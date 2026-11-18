# MIPSWEB

A MIPS simulator that runs in the browser.

## Running locally

```bash
npm install
npm run dev        # compiles less and TypeScript in watch mode and serves on http://localhost:8080
```

`PORT=<n>` changes the port of the server.

## CHAOS mode

The **CHAOS** toggle in the toolbar makes every function call (`jal`, `jalr`, `bal`, and `bgezal`/`bltzal`
when taken) assign random values to all the `$t0`-`$t9` registers. The scrambled registers are highlighted
in red. A program that relies on `$t` registers keeping their value across a call (instead of using `$s`
registers or saving them on the stack) will then misbehave, making the mistake visible.

## Exam evaluator

Start the app in evaluator mode with:

```bash
npm run evaluator                                  # build + serve with MIPSWEB_MODE=evaluator
MIPSWEB_MODE=evaluator MIPSWEB_MAX_STEPS=5000 node server.js   # custom default max steps
```

| Variable | Meaning | Default |
|---|---|---|
| `MIPSWEB_MODE` | `evaluator` shows the **Evaluate exams** button | normal mode |
| `MIPSWEB_MAX_STEPS` | default max executed instructions per run (editable in the dialog) | `1000` |

The static build (GitHub Pages) always runs in normal mode.

**Evaluate exams** asks for a folder like this (see `resources/evaluator-example`):

```
exams/
  tests.txt              use cases (.txt, .json, .io, .in or .tests)
  ROSSIMARIO/main.asm    one folder per student, with all the .asm files of the exam
  ROSSIMARIO/function.asm
  BIANCHILUCIA/main.asm
  ...
```

The use cases file contains, for each use case, the inputs (one per line, as typed in the console by the
students: one line per `read_int`, `read_string`, `read_char` or input dialog) and the expected output.
Lines before the first section are comments; `[case <name>]` is optional:

```
[case positive numbers]
[input]
5
3
[output]
The product is 15
```

A `.json` file can be used instead: `[{"name": "optional", "input": ["5", "3"], "output": "The product is 15"}]`.

Each student's program is assembled and run once per use case with the user's settings (entry point
`main`). The output printed by the program (the typed inputs are not part of it) is compared line by line
with the expected output, ignoring trailing spaces and trailing empty lines (optionally all whitespace).

The result is downloaded as an Excel file with two sheets:

- **Summary**: one row per student with the number of passed use cases and, for each use case, `OK`,
  `WRONG OUTPUT: <differences>`, `COMPILE ERROR: <file:line: message>`, `RUNTIME ERROR: <message>` or
  `TIMEOUT after <n> steps`.
- **Details**: one row per student and use case with input, expected output, program output and executed steps.
