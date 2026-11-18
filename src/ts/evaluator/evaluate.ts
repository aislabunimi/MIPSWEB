import { VirtualMachine } from "../virtual-machine/VirtualMachine.js";
import { CPU } from "../virtual-machine/CPU.js";
import { file } from "../files.js";
import { diffOutputs, parseTestCases, TestCase } from "./test-cases.js";

/**A file read from the exams folder*/
export type ExamFile = {
    /**path relative to the selected folder, with "/" separators (e.g. "ROSSIMARIO/main.asm")*/
    path: string;
    content: string;
};

export type Student = {
    /**name of the student's folder (e.g. ROSSIMARIO)*/
    name: string;
    files: file[];
};

export type ExamFolder = {
    students: Student[];
    testCases: TestCase[];
    testFileName: string;
};

export type CaseStatus =
    | "OK"
    | "WRONG OUTPUT"
    | "COMPILE ERROR"
    | "RUNTIME ERROR"
    | "TIMEOUT"
    | "NO FILES";

export type CaseResult = {
    testCase: TestCase;
    status: CaseStatus;
    /**the output printed by the program*/
    output: string;
    /**difference with the expected output, error message or timeout description*/
    details: string;
    steps: number;
};

export type StudentResult = {
    student: Student;
    passed: number;
    total: number;
    /**set if the program doesn't assemble (all the cases fail)*/
    compileError?: string;
    cases: CaseResult[];
};

const ASM_EXTENSIONS = [".asm", ".s"];
const TEST_FILE_EXTENSIONS = [".txt", ".json", ".io", ".in", ".tests"];

function isAsm(path: string): boolean {
    const lower = path.toLowerCase();
    return ASM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**Organizes the files of the selected folder.
 * Expected structure: each subfolder is a student (named NAMESURNAME) containing the .asm files
 * of the exam (e.g. main.asm and function.asm); the use cases file is in the folder itself.
 * The paths can either start with the selected folder name or not.*/
export function readExamFolder(files: ExamFile[]): ExamFolder {
    let entries = files
        .map((f) => ({ ...f, parts: f.path.split("/").filter((p) => p !== "") }))
        .filter((f) => !f.parts.some((p) => p.startsWith("."))); // hidden files (.DS_Store, ...)

    // remove the common root folder (the selected folder), if any
    while (
        entries.length > 0 &&
        entries.every((e) => e.parts.length > 1 && e.parts[0] === entries[0].parts[0])
    ) {
        entries = entries.map((e) => ({ ...e, parts: e.parts.slice(1) }));
    }

    const topLevel = entries.filter((e) => e.parts.length === 1);
    const candidates = topLevel.filter((e) =>
        TEST_FILE_EXTENSIONS.some((ext) => e.parts[0].toLowerCase().endsWith(ext)),
    );
    if (candidates.length === 0) {
        throw new Error(
            `No use cases file found: put a file (${TEST_FILE_EXTENSIONS.join(", ")}) with the inputs and outputs in the selected folder, next to the students' folders.`,
        );
    }
    // prefer a file whose name suggests it contains the tests
    const testFile =
        candidates.find((c) => /test|case|io|input|output/i.test(c.parts[0])) ??
        candidates[0];
    if (
        candidates.length > 1 &&
        candidates.filter((c) => /test|case|io|input|output/i.test(c.parts[0])).length !== 1
    ) {
        throw new Error(
            `Found more than one possible use cases file (${candidates.map((c) => c.parts[0]).join(", ")}): keep only one in the selected folder.`,
        );
    }
    const testCases = parseTestCases(testFile.content, testFile.parts[0]);

    const byStudent = new Map<string, ExamFile[]>();
    for (const e of entries) {
        if (e.parts.length < 2) continue;
        const name = e.parts[0];
        if (!byStudent.has(name)) byStudent.set(name, []);
        if (isAsm(e.path)) byStudent.get(name)!.push({ path: e.parts.slice(1).join("/"), content: e.content });
    }
    const students: Student[] = Array.from(byStudent.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, studentFiles]) => ({
            name,
            files: studentFiles
                // main first, then alphabetical: the order matters if there is no .globl main
                .sort((a, b) => {
                    const am = /(^|\/)main\.[^/]*$/i.test(a.path) ? 0 : 1;
                    const bm = /(^|\/)main\.[^/]*$/i.test(b.path) ? 0 : 1;
                    return am - bm || a.path.localeCompare(b.path);
                })
                .map((f, i) => {
                    const fileName = f.path.split("/").pop()!;
                    const dot = fileName.lastIndexOf(".");
                    return {
                        id: i + 1,
                        name: dot > 0 ? fileName.slice(0, dot) : fileName,
                        type: dot > 0 ? fileName.slice(dot + 1) : "asm",
                        content: f.content,
                    };
                }),
        }));
    if (students.length === 0) {
        throw new Error(
            "No students found: the selected folder must contain one subfolder per student (e.g. ROSSIMARIO/main.asm).",
        );
    }
    return { students, testCases, testFileName: testFile.parts[0] };
}

function fileLabel(files: file[], fileId: number | undefined): string {
    const f = files.find((f) => f.id === fileId);
    return f ? `${f.name}.${f.type}` : "";
}

/**Runs a program (without UI) with the given inputs for at most maxSteps instructions*/
export async function runProgram(
    files: file[],
    inputs: string[],
    maxSteps: number,
): Promise<{
    status: "OK" | "COMPILE ERROR" | "RUNTIME ERROR" | "TIMEOUT";
    output: string;
    message: string;
    steps: number;
}> {
    const vm = new VirtualMachine(new CPU(), { headless: true, inputs });
    try {
        vm.assemble(files);
    } catch (error) {
        const pos = vm.assembler.currentEditorPosition;
        const where = pos ? `${fileLabel(files, pos.fileId)}:${pos.lineNumber}: ` : "";
        return { status: "COMPILE ERROR", output: "", message: where + (error as Error).message, steps: 0 };
    }
    const steps = await vm.runHeadless(maxSteps);
    const output = vm.console.output;
    if (vm.getRuntimeErrorsCount() > 0) {
        const line = vm.console.lines.find((l) => l.type === "error");
        const pos = vm.assembler.addressEditorsPositions.get(vm.cpu.pc.getValue());
        const where = pos ? ` (${fileLabel(files, pos.fileId)}:${pos.lineNumber})` : "";
        const message = (line?.text ?? "Runtime Error").trim().replace(/^Runtime Error: /, "");
        return { status: "RUNTIME ERROR", output, message: message + where, steps };
    }
    if (!vm.cpu.isHalted()) {
        if (steps >= maxSteps) {
            return { status: "TIMEOUT", output, message: `after ${maxSteps} steps`, steps };
        }
        return { status: "RUNTIME ERROR", output, message: "the program could not be started (no instructions?)", steps };
    }
    return { status: "OK", output, message: "", steps };
}

export async function evaluateStudent(
    student: Student,
    testCases: TestCase[],
    maxSteps: number,
    ignoreWhitespace: boolean,
): Promise<StudentResult> {
    const result: StudentResult = { student, passed: 0, total: testCases.length, cases: [] };
    if (student.files.length === 0) {
        result.cases = testCases.map((testCase) => ({
            testCase,
            status: "NO FILES",
            output: "",
            details: "no .asm files in the folder",
            steps: 0,
        }));
        return result;
    }
    for (const testCase of testCases) {
        const run = await runProgram(student.files, testCase.inputs, maxSteps);
        if (run.status === "COMPILE ERROR") {
            result.compileError = run.message;
            result.cases = testCases.map((testCase) => ({
                testCase,
                status: "COMPILE ERROR",
                output: "",
                details: run.message,
                steps: 0,
            }));
            return result;
        }
        let status: CaseStatus = run.status;
        let details = run.message;
        if (run.status === "OK") {
            const diff = diffOutputs(testCase.expectedOutput, run.output, ignoreWhitespace);
            if (diff === null) {
                result.passed++;
            } else {
                status = "WRONG OUTPUT";
                details = diff;
            }
        }
        result.cases.push({ testCase, status, output: run.output, details, steps: run.steps });
    }
    return result;
}

/**Text of a case result for the summary table*/
export function caseSummary(c: CaseResult): string {
    switch (c.status) {
        case "OK":
            return "OK";
        case "TIMEOUT":
            return `TIMEOUT ${c.details}`;
        default:
            return `${c.status}: ${c.details}`;
    }
}

/**Rows (first row is the header) of the summary and the details sheets of the report*/
export function buildReport(
    results: StudentResult[],
    testCases: TestCase[],
    maxSteps: number,
): { summary: (string | number)[][]; details: (string | number)[][] } {
    const summary: (string | number)[][] = [
        ["Student", "Passed", "Total", "Score %", "Result", ...testCases.map((c) => c.name)],
    ];
    for (const r of results) {
        const result = r.compileError
            ? "COMPILE ERROR"
            : r.cases.some((c) => c.status === "NO FILES")
              ? "NO FILES"
              : r.passed === r.total
                ? "ALL PASSED"
                : `${r.passed}/${r.total} passed`;
        summary.push([
            r.student.name,
            r.passed,
            r.total,
            r.total > 0 ? Math.round((1000 * r.passed) / r.total) / 10 : 0,
            result,
            ...r.cases.map(caseSummary),
        ]);
    }
    const details: (string | number)[][] = [
        ["Student", "Use case", "Result", "Details", "Input", "Expected output", "Program output", `Steps (max ${maxSteps})`],
    ];
    for (const r of results) {
        for (const c of r.cases) {
            details.push([
                r.student.name,
                c.testCase.name,
                c.status,
                c.status === "OK" ? "" : c.details,
                c.testCase.inputs.join("\n"),
                c.testCase.expectedOutput,
                c.output,
                c.steps,
            ]);
        }
    }
    return { summary, details };
}
