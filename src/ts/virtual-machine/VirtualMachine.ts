import { CPU, T_REGISTERS } from "./CPU.js";
import { isChaosMode } from "../chaos.js";
import { file } from "../files.js";
import { Assembler } from "./Assembler.js";
import { Console } from "./Console.js";
import { Binary } from "./Utils.js";
import { renderApp } from "../app.js";
import {
    getExecutionSpeedTimeOut,
    isPerformanceMode,
} from "../execution-speed.js";
import { getOptions, INFINITE_LOOP_TRESHOLD } from "../settings.js";
import { updateUiAfterStep, updateUiDuringRun } from "../virtual-machine.js";
import { showForm } from "../forms.js";

/**When running at instant speed, execute instructions for this many ms before yielding to the browser
 * (so that the page stays responsive and the program can be paused)*/
const RUN_SLICE_MS = 40;
/**When running at instant speed (not in performance mode), refresh console and registers this often*/
const RUN_UI_REFRESH_MS = 500;

/**Lets the browser process events and repaint. Uses a MessageChannel since setTimeout(0) is clamped to >= 4ms*/
function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof MessageChannel === "undefined") {
            setTimeout(resolve, 0);
            return;
        }
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

/**Counts how many times each program counter is reached (used for infinite loop detection)*/
class PcCounter {
    private textCounts = new Uint32Array(0);
    private others = new Map<number, number>();

    /**increments the counter of the pc and returns the value it had before*/
    increment(pc: number): number {
        const index = (pc - 0x400000) / 4;
        if (index >= 0 && index < (1 << 20) && Number.isInteger(index)) {
            if (index >= this.textCounts.length) {
                const grown = new Uint32Array(
                    Math.min(1 << 20, Math.max(1024, (index + 1) * 2)),
                );
                grown.set(this.textCounts);
                this.textCounts = grown;
            }
            return this.textCounts[index]++;
        }
        const count = this.others.get(pc) ?? 0;
        this.others.set(pc, count + 1);
        return count;
    }

    /**decrements the counter (used when the count reached the treshold and should not increase)*/
    decrement(pc: number) {
        const index = (pc - 0x400000) / 4;
        if (index >= 0 && index < this.textCounts.length && Number.isInteger(index)) {
            this.textCounts[index]--;
        } else {
            const count = this.others.get(pc);
            if (count) this.others.set(pc, count - 1);
        }
    }

    clear() {
        this.textCounts.fill(0);
        this.others.clear();
    }
}

export class VirtualMachine {
    cpu: CPU;
    assembler: Assembler;
    running: boolean;
    /**Count how many times the virtual machine encounters each program counter (used for infinite loop detection)*/
    pcCounter: PcCounter;

    nextInstructionEditorPosition:
        | { fileId: number; lineNumber: number }
        | undefined;
    /**If this flag is true (can be set by the user with execution speed) then skip all operations about UI updates during execution,
     * leaving only the barebones. This improves performance for complex programs.*/
    performanceMode: boolean = false;

    /**Register that was changed by the last instruction*/
    get lastChangedRegister(): string | undefined {
        return this.cpu.getTracedChangedRegister();
    }
    /**List of register names that were read in the last instruction*/
    get lastReadRegisters(): string[] | undefined {
        const item = this.cpu.lastTraced;
        if (!item) return undefined;
        return item.instruction.getReadRegisters(
            item.params,
            this.cpu.getRegisters(),
        );
    }
    /**Names of the $t registers scrambled by the CHAOS mode in the last instruction (if any)*/
    get lastChaosRegisters(): string[] | undefined {
        if (!this.cpu.lastTraced || !this.cpu.lastTracedChaos) return undefined;
        const regs = this.cpu.getRegisters();
        return T_REGISTERS.map((i) => regs[i].name);
    }
    /**word-aligned address of the memory read by the last instruction*/
    get lastReadMem(): number | undefined {
        const item = this.cpu.lastTraced;
        if (!item) return undefined;
        return item.instruction.getReadMem(item.params, this.cpu.getRegisters());
    }
    /**word-aligned address of the memory written by the last instruction*/
    get lastWrittenMem(): number | undefined {
        const item = this.cpu.lastTraced;
        if (!item) return undefined;
        return item.instruction.getWrittenMem(
            item.params,
            this.cpu.getRegisters(),
        );
    }
    /**Forgets the last executed instruction (no registers/memory highlighted in the UI)*/
    clearLastInstructionInfo() {
        this.cpu.lastTraced = undefined;
    }
    /**Incremented at each run, used to stop a run loop when a newer one started*/
    private runId: number = 0;
    /**A stack of addresses, when a step is executed and calls a function, its return address is saved on the stack in order to allow a step-out*/
    stepOutStack: number[] = [];

    console: Console;
    /**Headless VM (exam evaluator): never touches the UI*/
    readonly headless: boolean;

    private asyncToken: number = 0;

    constructor(
        cpu: CPU,
        options: { headless?: boolean; inputs?: string[] } = {},
    ) {
        this.cpu = cpu;
        this.headless = options.headless ?? false;
        this.console = new Console(options);
        this.assembler = new Assembler(this.cpu);
        this.assembler.headless = this.headless;
        this.pcCounter = new PcCounter();
        this.running = false;
    }

    assemble(files: file[]) {
        this.stop();
        this.assembler.reset();
        this.cpu.reset();
        try {
            this.assembler.assembleFiles(files);
            this.nextInstructionEditorPosition =
                this.assembler.addressEditorsPositions.get(
                    this.cpu.pc.getValue(),
                );
            // the end of static data is the highest key in memory after assembling the program
            const staticDataEnd = this.cpu.memory.getMaxAddress();
            this.cpu.memory.initHeapPointer(staticDataEnd);
        } catch (error) {
            this.console.addLineWithPos(
                `Assemble: ${(error as Error).message}`,
                this.assembler.currentEditorPosition,
            );
            if (!this.headless) console.error(error);
            throw error;
        }
    }

    stop() {
        this.reset();
    }

    reset() {
        this.running = false;
        this.nextInstructionEditorPosition = undefined;
        this.clearLastInstructionInfo();
        this.console.reset();
        this.asyncToken++;
        this.pcCounter.clear();
        this.stepOutStack = [];
    }

    async stepOver() {
        // if step over is not possible execute a normal step
        if (!this.isNextInstructionFunction()) {
            await this.step();
            return;
        }
        await this.stepUntilPc(this.cpu.pc.getValue() + 4);
    }

    async stepOut() {
        if (this.stepOutStack.length <= 0) {
            await this.step();
            return;
        }
        await this.stepUntilPc(this.stepOutStack.pop()!);
    }

    /**Executes steps until the pc reaches the target, the program ends or an error occurs.
     * Yields periodically to the browser so that the page doesn't freeze.*/
    private async stepUntilPc(targetPc: number) {
        this.refreshOptions();
        const errors = this.runtimeErrors;
        const stopped = () =>
            this.cpu.pc.getValue() === targetPc ||
            this.cpu.isHalted() ||
            this.runtimeErrors !== errors;
        while (!stopped()) {
            const pending = this.stepSlice(stopped);
            if (pending) await pending;
            else await yieldToEventLoop();
        }
    }

    /**Executes steps synchronously for at most RUN_SLICE_MS or until stopped() is true
     * @returns the Promise of an asynchronous step, if any*/
    private stepSlice(stopped: () => boolean): Promise<void> | undefined {
        const sliceEnd = performance.now() + RUN_SLICE_MS;
        do {
            for (let i = 0; i < 2048; i++) {
                if (stopped()) return undefined;
                const pending = this.stepSync();
                if (pending) return pending;
            }
        } while (performance.now() < sliceEnd);
        return undefined;
    }

    async step() {
        this.refreshOptions();
        const result = this.stepSync();
        if (result) await result;
    }

    /**Executes a step. Returns a Promise only if the step is asynchronous (e.g. syscalls waiting for input),
     * otherwise the step is completed synchronously.*/
    stepSync(): void | Promise<void> {
        try {
            if (
                !this.cpu.isHalted() &&
                this.nextInstructionEditorPosition !== undefined
            ) {
                if (!this.performanceMode && this.isNextInstructionFunction()) {
                    this.stepOutStack.push(this.cpu.pc.getValue() + 4);
                }
                const result = this.cpu.executeNext(this, !this.performanceMode);
                if (result) {
                    return result
                        .then(() => this.afterStep())
                        .catch((error) => this.onRuntimeError(error))
                        .then(() => this.checkProgramEnd());
                }
                this.afterStep();
            } else {
                this.pause(true);
            }
        } catch (error) {
            this.onRuntimeError(error);
        }
        this.checkProgramEnd();
    }

    private afterStep() {
        if (this.performanceMode) return;
        const currPC = this.cpu.pc.getValue();
        if (currPC === this.stepOutStack[this.stepOutStack.length - 1])
            this.stepOutStack.pop();
        const pcCounter = this.pcCounter.increment(currPC);
        if (pcCounter >= INFINITE_LOOP_TRESHOLD) {
            // keep the counter at the treshold
            this.pcCounter.decrement(currPC);
            if (this.detectInfiniteLoops) {
                showForm(
                    "infinite-loop-popup",
                    { treshold: INFINITE_LOOP_TRESHOLD },
                    false,
                );
                this.pcCounter.clear();
                this.pause(true);
            }
        }
        this.updateEditorPosition();
        if (this.assembler.breakpointPCs.has(currPC)) this.pause(true);
    }

    /**Cached value of the "detect-infinite-loops" option (reading the options parses the localStorage,
     * too slow to be done at each step). Refreshed at the start of each run/step.*/
    private detectInfiniteLoops: boolean = true;

    private refreshOptions() {
        if (this.headless) {
            this.detectInfiniteLoops = false;
            this.cpu.chaosMode = false;
            return;
        }
        this.detectInfiniteLoops = !!getOptions()["detect-infinite-loops"];
        this.cpu.chaosMode = isChaosMode();
    }

    /**Number of runtime errors occurred since the VM was created*/
    getRuntimeErrorsCount(): number {
        return this.runtimeErrors;
    }

    /**Runs the program without UI (exam evaluator) for at most maxSteps instructions.
     * @returns the number of executed steps*/
    async runHeadless(maxSteps: number): Promise<number> {
        this.performanceMode = true;
        this.running = true;
        this.refreshOptions();
        let steps = 0;
        while (this.running && !this.cpu.isHalted() && steps < maxSteps) {
            const sliceEnd = Math.min(steps + 50000, maxSteps);
            while (this.running && !this.cpu.isHalted() && steps < sliceEnd) {
                const pending = this.stepSync();
                steps++;
                if (pending) await pending;
            }
            // let the browser breathe between slices
            if (steps < maxSteps) await yieldToEventLoop();
        }
        this.running = false;
        return steps;
    }

    /**Number of runtime errors occurred*/
    private runtimeErrors = 0;

    private onRuntimeError(error: unknown) {
        this.runtimeErrors++;
        this.console.addLineWithPos(
            `Runtime Error: ${(error as Error).message}`,
            this.cpu.pc.getValue(),
        );
        if (!this.headless) console.warn(error);
        this.pause(true);
    }

    private checkProgramEnd() {
        if (
            this.cpu.pc.getValue() >= this.assembler.textSegmentEnd.getValue()
        ) {
            this.cpu.halt();
            this.console.addLine(
                "Program finished (dropped off bottom).",
                "success",
            );
        }
    }

    /**Updates the next instruction's editor position*/
    updateEditorPosition() {
        if (!this.cpu.isHalted()) {
            this.nextInstructionEditorPosition =
                this.assembler.addressEditorsPositions.get(
                    this.cpu.pc.getValue(),
                );
        }
    }

    async run() {
        this.running = true;
        const runId = ++this.runId;
        this.refreshOptions();
        const timeout = getExecutionSpeedTimeOut();
        this.performanceMode = isPerformanceMode();
        // in performance mode the last instruction is not traced: don't show stale info
        if (this.performanceMode) this.clearLastInstructionInfo();
        if (timeout > 0) {
            while (this.isRunActive(runId)) {
                await this.step();
                // update ui since steps are not instant
                await updateUiAfterStep();
                this.pcCounter.clear();
                await new Promise((resolve) => setTimeout(resolve, timeout));
            }
            return;
        }

        // instant execution: run synchronously in time slices, yielding to the browser
        // between them so that the UI stays responsive and the user can pause
        let lastUiRefresh = performance.now();
        let sliceEnd = performance.now() + RUN_SLICE_MS;
        while (this.isRunActive(runId)) {
            const pending = this.runSlice(runId, sliceEnd);
            if (pending) await pending; // asynchronous step (e.g. syscall)
            if (!this.isRunActive(runId)) break;
            if (performance.now() < sliceEnd) continue;
            await yieldToEventLoop();
            if (
                this.isRunActive(runId) &&
                !this.performanceMode &&
                performance.now() - lastUiRefresh > RUN_UI_REFRESH_MS
            ) {
                await updateUiDuringRun();
                lastUiRefresh = performance.now();
            }
            sliceEnd = performance.now() + RUN_SLICE_MS;
        }
    }

    private isRunActive(runId: number): boolean {
        return this.running && !this.cpu.isHalted() && runId === this.runId;
    }

    /**Executes steps synchronously until the deadline, the end of the run or an asynchronous step.
     * Kept out of run() on purpose: loops inside async functions (compiled to generators) are much
     * slower since they are poorly optimized by the JS engines.
     * @returns the Promise of the asynchronous step, if any*/
    private runSlice(runId: number, sliceEnd: number): Promise<void> | undefined {
        do {
            for (let i = 0; i < 2048; i++) {
                if (!this.isRunActive(runId)) return undefined;
                const pending = this.stepSync();
                if (pending) return pending;
            }
        } while (performance.now() < sliceEnd);
        return undefined;
    }

    pause(updateUi: boolean = false) {
        this.running = false;
        if (updateUi && !this.headless) updateUiAfterStep();
    }

    isNextInstructionFunction(): boolean {
        const decodedInstruction = this.cpu.fetch();
        if (!decodedInstruction) return false;
        return decodedInstruction.isFunctionCall;
    }

    async exit() {
        this.cpu.halt();
        this.pause(false);
        this.nextInstructionEditorPosition = undefined;
        this.clearLastInstructionInfo();
        if (!this.headless) await updateUiAfterStep();
    }

    getRegisters() {
        const registers = [...this.cpu.getRegisters()];
        registers.push({ name: "pc", binary: this.cpu.pc });
        registers.push({ name: "hi", binary: this.cpu.hi });
        registers.push({ name: "lo", binary: this.cpu.lo });
        return registers;
    }

    getMemory() {
        return Array.from(this.cpu.getMemory().entries()).map(
            ([address, binary]): {
                address: number;
                binary: Binary;
                tags: { name: string; type: string }[];
            } => ({
                address,
                binary: binary,
                tags: [],
            }),
        );
    }

    getCurrentAsyncToken(): number {
        return this.asyncToken;
    }
}
