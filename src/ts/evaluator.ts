import { appConfig, isEvaluatorMode } from "./app-config.js";
import { hideForm, showForm, showToast } from "./forms.js";
import {
    buildReport,
    evaluateStudent,
    ExamFile,
    ExamFolder,
    readExamFolder,
    StudentResult,
} from "./evaluator/evaluate.js";
import { buildXlsx } from "./evaluator/xlsx.js";

declare const JSZip: any;

/**State of the evaluator dialog*/
let folder: ExamFolder | undefined;
let folderName = "exams";
let results: StudentResult[] = [];
let report: Blob | undefined;
let running = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function setStatus(html: string, error: boolean = false) {
    const status = el("evaluator-status");
    if (!status) return;
    status.innerHTML = html;
    status.classList.toggle("error", error);
}

function updateButtons() {
    const start = el<HTMLButtonElement>("evaluator-start");
    if (start) start.disabled = !folder || running;
    const download = el<HTMLButtonElement>("evaluator-download");
    if (download) download.disabled = !report || running;
    const choose = el<HTMLButtonElement>("evaluator-choose");
    if (choose) choose.disabled = running;
}

(window as any).openEvaluatorOnClick = async function () {
    if (!isEvaluatorMode()) return;
    await showForm(
        "evaluator",
        { maxSteps: appConfig.evaluatorMaxSteps },
        false,
        undefined,
        false,
    );
    folder = undefined;
    results = [];
    report = undefined;
    updateButtons();
};

(window as any).closeEvaluatorOnClick = function () {
    if (running) return;
    hideForm();
};

(window as any).evaluatorChooseFolderOnClick = function () {
    el<HTMLInputElement>("evaluator-folder-input")?.click();
};

(window as any).evaluatorFolderChanged = async function (input: HTMLInputElement) {
    const fileList = Array.from(input.files ?? []);
    input.value = "";
    folder = undefined;
    results = [];
    report = undefined;
    renderResults();
    if (fileList.length === 0) return;
    const relevant = fileList.filter((f) =>
        /\.(asm|s|txt|json|io|in|tests)$/i.test(f.name),
    );
    try {
        const files: ExamFile[] = await Promise.all(
            relevant.map(async (f) => ({
                path: (f as any).webkitRelativePath || f.name,
                content: await f.text(),
            })),
        );
        folderName =
            ((fileList[0] as any).webkitRelativePath || "").split("/")[0] ||
            "exams";
        folder = readExamFolder(files);
        const noFiles = folder.students.filter((s) => s.files.length === 0);
        setStatus(
            `Folder <b>${escapeHtml(folderName)}</b>: ${folder.students.length} students, ` +
                `${folder.testCases.length} use cases (from <b>${escapeHtml(folder.testFileName)}</b>).` +
                (noFiles.length > 0
                    ? `<br>Without .asm files: ${noFiles.map((s) => escapeHtml(s.name)).join(", ")}`
                    : ""),
        );
    } catch (error) {
        setStatus(escapeHtml((error as Error).message), true);
    }
    updateButtons();
};

function readMaxSteps(): number | undefined {
    const value = Number(el<HTMLInputElement>("evaluator-max-steps")?.value);
    if (!Number.isInteger(value) || value <= 0) return undefined;
    return value;
}

(window as any).evaluatorStartOnClick = async function () {
    if (!folder || running) return;
    const maxSteps = readMaxSteps();
    if (!maxSteps) {
        setStatus("The max number of steps must be a positive integer", true);
        return;
    }
    const ignoreWhitespace =
        el<HTMLInputElement>("evaluator-ignore-whitespace")?.checked ?? false;
    running = true;
    results = [];
    report = undefined;
    updateButtons();
    renderResults();
    try {
        for (let i = 0; i < folder.students.length; i++) {
            const student = folder.students[i];
            setStatus(
                `Evaluating ${i + 1}/${folder.students.length}: <b>${escapeHtml(student.name)}</b>...`,
            );
            results.push(
                await evaluateStudent(
                    student,
                    folder.testCases,
                    maxSteps,
                    ignoreWhitespace,
                ),
            );
            renderResults();
            // let the browser repaint
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const { summary, details } = buildReport(
            results,
            folder.testCases,
            maxSteps,
        );
        report = (await buildXlsx(
            [
                { name: "Summary", rows: summary },
                { name: "Details", rows: details, widths: [18, 18, 16, 50, 16, 40, 40, 12] },
            ],
            JSZip,
        )) as Blob;
        const passedAll = results.filter((r) => r.passed === r.total).length;
        setStatus(
            `Done: ${results.length} students evaluated, ${passedAll} passed all the use cases (max ${maxSteps} steps per run).`,
        );
        downloadReport();
    } catch (error) {
        console.error(error);
        setStatus(
            `Evaluation failed: ${escapeHtml((error as Error).message)}`,
            true,
        );
    } finally {
        running = false;
        updateButtons();
    }
};

function downloadReport() {
    if (!report) return;
    const url = URL.createObjectURL(report);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${folderName}-evaluation.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast("Excel report downloaded", 3000);
}

(window as any).evaluatorDownloadOnClick = downloadReport;

function renderResults() {
    const container = el("evaluator-results");
    if (!container) return;
    if (results.length === 0) {
        container.innerHTML = "";
        return;
    }
    const rows = results
        .map((r) => {
            const cls = r.compileError
                ? "bad"
                : r.passed === r.total
                  ? "good"
                  : r.passed === 0
                    ? "bad"
                    : "partial";
            const problems = r.compileError
                ? `COMPILE ERROR: ${r.compileError}`
                : r.cases
                      .filter((c) => c.status !== "OK")
                      .map((c) => `${c.testCase.name}: ${c.status}`)
                      .join(", ");
            return (
                `<tr class="${cls}"><td>${escapeHtml(r.student.name)}</td>` +
                `<td class="score">${r.passed}/${r.total}</td>` +
                `<td class="problems" title="${escapeHtml(problems)}">${escapeHtml(problems)}</td></tr>`
            );
        })
        .join("");
    container.innerHTML = `<table><thead><tr><th>Student</th><th>Passed</th><th>Failed use cases</th></tr></thead><tbody>${rows}</tbody></table>`;
}
