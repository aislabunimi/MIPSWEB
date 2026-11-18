/**A use case of an exam: the inputs typed by the user and the expected output*/
export type TestCase = {
    name: string;
    /**One entry per input request (read_int, read_string, read_char, input dialogs...)*/
    inputs: string[];
    expectedOutput: string;
};

/**Parses the file containing the use cases of the exam.
 *
 * Text format (any extension but .json): each use case is an `[input]` section, with one input
 * per line, followed by an `[output]` section with the expected output, verbatim.
 * An optional `[case <name>]` line before `[input]` names the use case.
 * Lines before the first section are ignored (they can be used as comments).
 * ```
 * [case positive numbers]
 * [input]
 * 5
 * 3
 * [output]
 * The product is 15
 * ```
 * JSON format (.json): `[{"name": "optional", "input": ["5", "3"] | "5\n3", "output": "The product is 15"}]`
 */
export function parseTestCases(content: string, fileName: string): TestCase[] {
    const text = content.replace(/\r\n?/g, "\n");
    const cases = fileName.toLowerCase().endsWith(".json")
        ? parseJson(text)
        : parseText(text);
    if (cases.length === 0) {
        throw new Error(
            `No use cases found in "${fileName}": each use case needs an [input] and an [output] section`,
        );
    }
    return cases;
}

function parseJson(text: string): TestCase[] {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) {
        throw new Error("The JSON test file must contain an array of use cases");
    }
    return data.map((item: any, i: number) => {
        if (item == null || item.output === undefined) {
            throw new Error(`Use case ${i + 1} has no "output"`);
        }
        const input = item.input ?? [];
        return {
            name: item.name ? String(item.name) : `Case ${i + 1}`,
            inputs: Array.isArray(input)
                ? input.map(String)
                : splitInputLines(String(input)),
            expectedOutput: String(item.output),
        };
    });
}

const SECTION_REGEX = /^\s*\[\s*(input|output|case)\b\s*:?\s*([^\]]*)\]\s*$/i;

function parseText(text: string): TestCase[] {
    const cases: TestCase[] = [];
    let current: { name?: string; input?: string[]; output?: string[] } | null =
        null;
    let section: "input" | "output" | null = null;
    let pendingName: string | undefined = undefined;

    const closeCase = () => {
        if (current) {
            if (current.output === undefined) {
                throw new Error(
                    `Use case ${cases.length + 1} has an [input] but no [output] section`,
                );
            }
            cases.push({
                name: current.name || `Case ${cases.length + 1}`,
                inputs: trimTrailingEmpty(current.input ?? []),
                expectedOutput: trimTrailingEmpty(current.output).join("\n"),
            });
        }
        current = null;
        section = null;
    };

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(SECTION_REGEX);
        if (match) {
            const kind = match[1].toLowerCase();
            if (kind === "case") {
                closeCase();
                pendingName = match[2].trim() || undefined;
            } else if (kind === "input") {
                closeCase();
                current = { name: pendingName, input: [] };
                pendingName = undefined;
                section = "input";
            } else {
                if (!current) {
                    // a case without inputs
                    current = { name: pendingName, input: [] };
                    pendingName = undefined;
                } else if (current.output !== undefined) {
                    throw new Error(
                        `Line ${i + 1}: two [output] sections in the same use case`,
                    );
                }
                current.output = [];
                section = "output";
            }
            continue;
        }
        if (!current || section === null) continue; // comments before the first section
        if (section === "input") current.input!.push(line);
        else current.output!.push(line);
    }
    closeCase();
    return cases;
}

function splitInputLines(input: string): string[] {
    return trimTrailingEmpty(input.split("\n"));
}

function trimTrailingEmpty(lines: string[]): string[] {
    const result = [...lines];
    while (result.length > 0 && result[result.length - 1].trim() === "")
        result.pop();
    return result;
}

/**Normalizes an output for the comparison: unix line endings, no trailing spaces on each line,
 * no empty lines at the end. With ignoreWhitespace, also collapses and trims all the spaces
 * of each line and ignores empty lines.*/
export function normalizeOutput(
    output: string,
    ignoreWhitespace: boolean = false,
): string[] {
    let lines = output
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""));
    if (ignoreWhitespace) {
        lines = lines
            .map((line) => line.replace(/\s+/g, " ").trim())
            .filter((line) => line !== "");
    }
    return trimTrailingEmpty(lines);
}

/**Compares the expected and the actual output.
 * @returns null if they are equal, otherwise a short description of the differences*/
export function diffOutputs(
    expected: string,
    actual: string,
    ignoreWhitespace: boolean = false,
    maxDifferences: number = 3,
): string | null {
    const exp = normalizeOutput(expected, ignoreWhitespace);
    const act = normalizeOutput(actual, ignoreWhitespace);
    const differences: string[] = [];
    let count = 0;
    const length = Math.max(exp.length, act.length);
    for (let i = 0; i < length; i++) {
        if (exp[i] === act[i]) continue;
        count++;
        if (differences.length >= maxDifferences) continue;
        if (i >= act.length) {
            differences.push(
                `line ${i + 1}: expected ${JSON.stringify(exp[i])} but the output ended`,
            );
        } else if (i >= exp.length) {
            differences.push(
                `line ${i + 1}: unexpected ${JSON.stringify(act[i])}`,
            );
        } else {
            differences.push(
                `line ${i + 1}: expected ${JSON.stringify(exp[i])} but got ${JSON.stringify(act[i])}`,
            );
        }
    }
    if (count === 0) return null;
    if (count > differences.length) {
        differences.push(`(${count - differences.length} more different lines)`);
    }
    return differences.join("; ");
}
