import { Instruction, Instructions } from "./Instructions.js";
import { Format, I_Format, J_Format, R_Format } from "./Formats.js";
import { Registers } from "./Registers.js";
import { Binary, Utils } from "./Utils.js";
import { Memory } from "./Memory.js";
import { Syscalls } from "./Syscalls.js";
import { VirtualMachine } from "./VirtualMachine.js";
import { getOptions } from "../settings.js";

export type DecodingCacheItem = {
    instruction: Instruction;
    params: { [key: string]: Binary };
    basic: string;
    /**instruction code (unsigned) this item was decoded from*/
    word: number;
    /**fast path operation (see FAST_OPS), FAST_NONE if the instruction must be executed with Instruction.execute*/
    op: number;
    rs: number;
    rt: number;
    rd: number;
    sa: number;
    /**params.immediate getValue(), getUnsignedValue(), getSignedValue()*/
    immV: number;
    immU: number;
    immS: number;
    /**branch offset in bytes*/
    boff: number;
    target: number;
    /**true if the instruction is a procedure call (symbol ends with "AL"), used by step over/out*/
    isFunctionCall: boolean;
    /**true if the instruction is a function call (jal, jalr, bal, bgezal, bltzal), used by the CHAOS mode*/
    isCall: boolean;
    /**the only general purpose register the fast path can write (-1 if none),
     * used to detect the changed register without copying all the registers*/
    dest: number;
};

const FAST_NONE = 0;
/**Instructions that are executed by the fast path in CPU.executeNext.
 * Every fast implementation must behave exactly like Instruction.execute (including the
 * signed flag of the written Binary values), rare cases (errors, warnings) fall back to it.*/
const FAST_OPS: string[] = [
    "",
    "SLL", "SRL", "SRA", "SLLV", "SRLV", "SRAV", "JR", "JALR",
    "MFHI", "MTHI", "MFLO", "MTLO", "MULT", "MULTU", "DIV", "DIVU",
    "ADD", "ADDU", "SUB", "SUBU", "AND", "OR", "XOR", "NOR", "SLT", "SLTU",
    "J", "JAL", "BAL", "BEQ", "BGEZ", "BGEZAL", "BGTZ", "BNE", "BLEZ", "BLTZ", "BLTZAL",
    "ADDI", "ADDIU", "SLTI", "SLTIU", "ANDI", "ORI", "XORI", "LUI",
    "LB", "LH", "LW", "LBU", "LHU", "SB", "SH", "SW",
];
const OP: { [symbol: string]: number } = Object.fromEntries(
    FAST_OPS.map((symbol, i) => [symbol, i]),
);
/**Fast instructions that write rd, rt or $ra (used for DecodingCacheItem.dest)*/
const WRITES_RD = new Set(["SLL", "SRL", "SRA", "SLLV", "SRLV", "SRAV", "JALR", "MFHI", "MFLO",
    "ADD", "ADDU", "SUB", "SUBU", "AND", "OR", "XOR", "NOR", "SLT", "SLTU"]);
const WRITES_RT = new Set(["ADDI", "ADDIU", "SLTI", "SLTIU", "ANDI", "ORI", "XORI", "LUI",
    "LB", "LH", "LW", "LBU", "LHU"]);
const WRITES_RA = new Set(["JAL", "BAL", "BGEZAL", "BLTZAL"]);
/**Instructions that make a function call (used by the CHAOS mode)*/
const CALL_INSTRUCTIONS = new Set(["JAL", "JALR", "BAL", "BGEZAL", "BLTZAL"]);
/**Indexes of the registers $t0-$t9*/
export const T_REGISTERS = [8, 9, 10, 11, 12, 13, 14, 15, 24, 25];
const TEXT_START = 0x400000;
/**Max number of words of the text segment that are cached by address*/
const FETCH_CACHE_WORDS = 1 << 20;

/**High 32 bits of the 64 bit product of a and b.
 * a and b are both int32 (signed) or both uint32 (unsigned). Result is exact.*/
function mulHigh(a: number, b: number, signed: boolean): number {
    const a0 = a & 0xffff;
    const b0 = b & 0xffff;
    const a1 = signed ? a >> 16 : a >>> 16;
    const b1 = signed ? b >> 16 : b >>> 16;
    const mid = a1 * b0 + a0 * b1;
    return a1 * b1 + Math.floor((mid * 65536 + a0 * b0) / 4294967296);
}
export class CPU {
    instructionsSet: Instructions = new Instructions();
    syscallsSet: Syscalls = new Syscalls();
    formats: Map<string, Format> = new Map();
    memory: Memory = new Memory();
    registers: Registers = new Registers([
        "$zero",
        "$at",
        "$v0",
        "$v1",
        "$a0",
        "$a1",
        "$a2",
        "$a3",
        "$t0",
        "$t1",
        "$t2",
        "$t3",
        "$t4",
        "$t5",
        "$t6",
        "$t7",
        "$s0",
        "$s1",
        "$s2",
        "$s3",
        "$s4",
        "$s5",
        "$s6",
        "$s7",
        "$t8",
        "$t9",
        "$k0",
        "$k1",
        "$gp",
        "$sp",
        "$fp",
        "$ra",
    ]);
    pc: Binary = new Binary();
    lo: Binary = new Binary();
    hi: Binary = new Binary();
    halted: boolean = false;

    constructor() {
        this.formats.set("R", new R_Format());
        this.formats.set("I", new I_Format());
        this.formats.set("J", new J_Format());
    }

    decodingCache: Map<number, DecodingCacheItem> = new Map();

    /**Decoded instructions by text segment address: (address - 0x400000) / 4 -> item*/
    private fetchCache: (DecodingCacheItem | undefined)[] = [];
    /**Register raw values before the last executed instruction (used for the UI trace).
     * For fast path instructions only the register that can be written is saved (see traceDest).*/
    private regSnapshot = new Float64Array(32);
    private nextRegSnapshot = new Float64Array(32);
    /**-2: full snapshot, -1: no register can be written, otherwise the only register that can be written*/
    private traceDest = -2;
    private nextTraceDest = -2;
    /**Last instruction executed when not in performance mode, used to compute (lazily)
     * the registers and memory read/written by it (see VirtualMachine.lastChangedRegister).*/
    lastTraced: DecodingCacheItem | undefined = undefined;
    /**CHAOS mode: when a function call is made, all the $t registers get random values,
     * showing what happens when a caller relies on $t registers being preserved across calls*/
    chaosMode: boolean = false;
    /**true if the last traced instruction was a call that scrambled the $t registers*/
    lastTracedChaos: boolean = false;

    decode(instructionCode: Binary) {
        return this.decodeWord(instructionCode.getUnsignedValue());
    }

    clearDecodingCache() {
        this.decodingCache.clear();
        this.fetchCache = [];
    }

    decodeWord(word: number): DecodingCacheItem | undefined {
        const cached = this.decodingCache.get(word);
        if (cached) {
            return cached;
        }
        const instructionCode = new Binary(word);
        const opcode = new Binary(
            instructionCode.getBits(31, 26).getValue(),
            6,
        );
        let funct: Binary | undefined = undefined;
        if (opcode.getValue() === 0) {
            funct = new Binary(instructionCode.getBits(5, 0).getValue(), 6);
        }
        let foundInstruction: Instruction | undefined = undefined;
        const rtField = instructionCode.getBits(20, 16).getValue();

        for (const instruction of this.instructionsSet.instructions) {
            if (instruction.opcode.getValue() === opcode.getValue()) {
                if (funct) {
                    if (instruction.funct?.getValue() === funct.getValue()) {
                        foundInstruction = instruction;
                        break;
                    }
                } else if (!instruction.funct) {
                    if (instruction.fixedRt) {
                        if (instruction.fixedRt.getValue() === rtField) {
                            // bal and bgezal have the same opcode and fixedRt, but need to be interpreted as bgezal
                            // specifically, `bal target` is interpreted as `bgezal $zero target`
                            if (instruction.symbol === "BAL") continue;
                            foundInstruction = instruction;
                            break;
                        } else {
                            continue;
                        }
                    }
                    foundInstruction = instruction;
                    break;
                }
            }
        }

        if (foundInstruction) {
            const format = this.getFormat(foundInstruction.format);
            if (format) {
                let params = format.disassemble(
                    foundInstruction,
                    instructionCode,
                );

                const basic = foundInstruction.basic(params, this.registers);
                const imm = params.immediate;
                const immV = imm ? imm.getValue() : 0;
                const item: DecodingCacheItem = {
                    instruction: foundInstruction,
                    params,
                    basic,
                    word,
                    op: OP[foundInstruction.symbol] ?? FAST_NONE,
                    rs: params.rs ? params.rs.getValue() : 0,
                    rt: params.rt ? params.rt.getValue() : 0,
                    rd: params.rd ? params.rd.getValue() : 0,
                    sa: params.shamt ? params.shamt.getValue() : 0,
                    immV,
                    immU: imm ? imm.getUnsignedValue() : 0,
                    immS: imm ? imm.getSignedValue() : 0,
                    boff: Utils.fromSigned(immV, 16) << 2,
                    target: params.target ? params.target.getValue() : 0,
                    isFunctionCall: foundInstruction.symbol.endsWith("AL"),
                    isCall: CALL_INSTRUCTIONS.has(foundInstruction.symbol),
                    dest: -1,
                };
                const symbol = foundInstruction.symbol;
                if (WRITES_RD.has(symbol)) item.dest = item.rd;
                else if (WRITES_RT.has(symbol)) item.dest = item.rt;
                else if (WRITES_RA.has(symbol)) item.dest = 31;
                this.decodingCache.set(word, item);
                return item;
            }
        }

        return undefined;
    }

    /**Decodes the instruction pointed by the pc (throws if the pc is not a valid address)*/
    fetch(): DecodingCacheItem | undefined {
        const pc = this.pc;
        const pcv = pc.signed ? pc.raw | 0 : pc.raw;
        if (pcv >= TEXT_START && (pcv & 3) === 0) {
            const word = this.memory.readWordValue(pcv) >>> 0;
            const index = (pcv - TEXT_START) >>> 2;
            if (index < FETCH_CACHE_WORDS) {
                const item = this.fetchCache[index];
                if (item !== undefined && item.word === word) return item;
                const decoded = this.decodeWord(word);
                this.fetchCache[index] = decoded;
                return decoded;
            }
            return this.decodeWord(word);
        }
        // invalid address: let memory throw the appropriate error
        return this.decode(this.memory.loadWord(this.pc));
    }

    /**Executes the instruction pointed by the pc.
     * Returns a Promise only if the instruction is asynchronous (syscalls), otherwise it
     * executes synchronously. Throws on runtime errors (the pc is left on the faulty instruction).
     * @param trace whether to record the info needed to show the registers/memory used by the instruction*/
    executeNext(
        vm: VirtualMachine,
        trace: boolean,
    ): void | Promise<void> {
        const item = this.fetch();
        if (item === undefined) return;
        const regs = this.registers.registers;
        const pcBefore = this.pc.getValue();
        if (trace) {
            const snap = this.nextRegSnapshot;
            if (item.op !== FAST_NONE) {
                this.nextTraceDest = item.dest;
                if (item.dest >= 0) snap[item.dest] = regs[item.dest].binary.raw;
            } else {
                this.nextTraceDest = -2;
                for (let i = 0; i < 32; i++) snap[i] = regs[i].binary.raw;
            }
        }
        if (item.op !== FAST_NONE && !this.executeFast(item, regs)) {
            // fallback to Instruction.execute: take the full snapshot
            if (trace) {
                this.nextTraceDest = -2;
                const snap = this.nextRegSnapshot;
                for (let i = 0; i < 32; i++) snap[i] = regs[i].binary.raw;
            }
            const result = item.instruction.execute(this, item.params, vm);
            if (result !== undefined) {
                return result.then(() => this.afterExecute(item, trace, pcBefore));
            }
        } else if (item.op === FAST_NONE) {
            const result = item.instruction.execute(this, item.params, vm);
            if (result !== undefined) {
                return result.then(() => this.afterExecute(item, trace, pcBefore));
            }
        }
        this.afterExecute(item, trace, pcBefore);
    }

    private afterExecute(
        item: DecodingCacheItem,
        trace: boolean,
        pcBefore: number,
    ) {
        const zero = this.registers.registers[0].binary;
        zero.signed = false;
        zero.raw = 0;
        // CHAOS mode: scramble the $t registers when a call is made (conditional calls only if taken)
        let chaos = false;
        if (
            this.chaosMode &&
            item.isCall &&
            this.pc.getValue() !== pcBefore + 4
        ) {
            chaos = true;
            this.scrambleTRegisters();
        }
        if (trace) {
            this.lastTracedChaos = chaos;
            const tmp = this.regSnapshot;
            this.regSnapshot = this.nextRegSnapshot;
            this.nextRegSnapshot = tmp;
            this.traceDest = this.nextTraceDest;
            this.lastTraced = item;
        }
    }

    /**Sets random values in all the $t registers*/
    scrambleTRegisters() {
        const regs = this.registers.registers;
        for (const index of T_REGISTERS) {
            regs[index].binary.set((Math.random() * 0x100000000) | 0);
        }
    }

    /**Name of the first register changed by the last traced instruction*/
    getTracedChangedRegister(): string | undefined {
        if (!this.lastTraced) return undefined;
        const regs = this.registers.registers;
        if (this.traceDest !== -2) {
            const dest = this.traceDest;
            if (dest >= 0 && regs[dest].binary.raw !== this.regSnapshot[dest])
                return regs[dest].name;
            return undefined;
        }
        for (let i = 0; i < regs.length; i++) {
            if (regs[i].binary.raw !== this.regSnapshot[i]) return regs[i].name;
        }
        return undefined;
    }

    /**Executes the instruction with the fast path.
     * Returns false (without side effects) if the instruction has to be executed by Instruction.execute.*/
    private executeFast(
        d: DecodingCacheItem,
        regs: { binary: Binary }[],
    ): boolean {
        const pc = this.pc;
        const pcv = pc.signed ? pc.raw | 0 : pc.raw;
        // In the following, for a Binary b (32 bits):
        // b.getValue() === (b.signed ? b.raw | 0 : b.raw), b.getSignedValue() === b.raw | 0
        // b.set(v) for an in range integer v is: b.signed = v < 0; b.raw = v >>> 0
        switch (d.op) {
            case OP.SLL: {
                const rt = regs[d.rt].binary;
                const v = (rt.signed ? rt.raw | 0 : rt.raw) << d.sa;
                setValue(regs[d.rd].binary, v);
                break;
            }
            case OP.SRL:
            case OP.SRLV: {
                const rt = regs[d.rt].binary;
                const sa = d.op === OP.SRL ? d.sa : regs[d.rs].binary.raw & 31;
                const v = (rt.signed ? rt.raw | 0 : rt.raw) >> sa;
                const mask = ((1 << sa) - 1) << (32 - sa);
                const rd = regs[d.rd].binary;
                rd.signed = v < 0;
                rd.raw = ((v >>> 0) & ~mask) >>> 0;
                break;
            }
            case OP.SRA:
            case OP.SRAV: {
                const rt = regs[d.rt].binary;
                const sa = d.op === OP.SRA ? d.sa : regs[d.rs].binary.raw & 31;
                setValue(
                    regs[d.rd].binary,
                    (rt.signed ? rt.raw | 0 : rt.raw) >> sa,
                );
                break;
            }
            case OP.SLLV: {
                const rt = regs[d.rt].binary;
                const sa = regs[d.rs].binary.raw & 31;
                setValue(
                    regs[d.rd].binary,
                    (rt.signed ? rt.raw | 0 : rt.raw) << sa,
                );
                break;
            }
            case OP.JR: {
                const rs = regs[d.rs].binary;
                pc.set(rs.signed ? rs.raw | 0 : rs.raw);
                return true;
            }
            case OP.JALR: {
                setValue(regs[d.rd].binary, pcv + 4);
                const rs = regs[d.rs].binary;
                pc.set(rs.signed ? rs.raw | 0 : rs.raw);
                return true;
            }
            case OP.MFHI:
                setUnsigned(regs[d.rd].binary, this.hi.raw);
                break;
            case OP.MFLO:
                setUnsigned(regs[d.rd].binary, this.lo.raw);
                break;
            case OP.MTHI: {
                const rs = regs[d.rs].binary;
                setValue(this.hi, rs.signed ? rs.raw | 0 : rs.raw);
                break;
            }
            case OP.MTLO: {
                const rs = regs[d.rs].binary;
                setValue(this.lo, rs.signed ? rs.raw | 0 : rs.raw);
                break;
            }
            case OP.MULT: {
                const a = regs[d.rs].binary.raw | 0;
                const b = regs[d.rt].binary.raw | 0;
                setUnsigned(this.lo, Math.imul(a, b) >>> 0);
                setUnsigned(this.hi, mulHigh(a, b, true) >>> 0);
                break;
            }
            case OP.MULTU: {
                const a = regs[d.rs].binary.raw;
                const b = regs[d.rt].binary.raw;
                setUnsigned(this.lo, Math.imul(a, b) >>> 0);
                setUnsigned(this.hi, mulHigh(a, b, false) >>> 0);
                break;
            }
            case OP.DIV: {
                const a = regs[d.rs].binary.raw | 0;
                const b = regs[d.rt].binary.raw | 0;
                if (b === 0) return false; // warning + undefined result
                setValue(this.lo, Math.trunc(a / b) | 0);
                setValue(this.hi, ((a % b) >> 0) << 0);
                break;
            }
            case OP.DIVU: {
                const a = regs[d.rs].binary.raw;
                const b = regs[d.rt].binary.raw;
                if (b === 0) return false;
                setUnsigned(this.lo, Math.floor(a / b));
                setUnsigned(this.hi, a % b);
                break;
            }
            case OP.ADD:
            case OP.ADDI: {
                const a = regs[d.rs].binary.raw | 0;
                const b = d.op === OP.ADD ? regs[d.rt].binary.raw | 0 : d.immV;
                const result = ((a + b) >> 0) << 0;
                if (
                    (a >= 0 && b >= 0 && result < 0) ||
                    (a < 0 && b < 0 && result >= 0)
                )
                    return false; // overflow exception
                setSigned(regs[d.op === OP.ADD ? d.rd : d.rt].binary, result);
                break;
            }
            case OP.ADDU:
                setSigned(
                    regs[d.rd].binary,
                    ((regs[d.rs].binary.raw | 0) + (regs[d.rt].binary.raw | 0)) | 0,
                );
                break;
            case OP.SUB: {
                const a = regs[d.rs].binary.raw | 0;
                const b = regs[d.rt].binary.raw | 0;
                const result = a - b;
                if (
                    result < -2147483648 ||
                    result > 2147483647 ||
                    ((a ^ b) & (a ^ result)) < 0
                )
                    return false; // overflow exception
                setSigned(regs[d.rd].binary, result);
                break;
            }
            case OP.SUBU:
                setUnsigned(
                    regs[d.rd].binary,
                    ((regs[d.rs].binary.raw | 0) - (regs[d.rt].binary.raw | 0)) >>> 0,
                );
                break;
            case OP.AND:
                setUnsigned(regs[d.rd].binary, (regs[d.rs].binary.raw & regs[d.rt].binary.raw) >>> 0);
                break;
            case OP.OR:
                setUnsigned(regs[d.rd].binary, (regs[d.rs].binary.raw | regs[d.rt].binary.raw) >>> 0);
                break;
            case OP.XOR:
                setUnsigned(regs[d.rd].binary, (regs[d.rs].binary.raw ^ regs[d.rt].binary.raw) >>> 0);
                break;
            case OP.NOR:
                setUnsigned(regs[d.rd].binary, ~(regs[d.rs].binary.raw | regs[d.rt].binary.raw) >>> 0);
                break;
            case OP.SLT:
                setUnsigned(regs[d.rd].binary, (regs[d.rs].binary.raw | 0) < (regs[d.rt].binary.raw | 0) ? 1 : 0);
                break;
            case OP.SLTU:
                setUnsigned(regs[d.rd].binary, regs[d.rs].binary.raw < regs[d.rt].binary.raw ? 1 : 0);
                break;
            case OP.J:
                pc.set((pcv & 0xf0000000) | (d.target << 2));
                return true;
            case OP.JAL:
                setValue(regs[31].binary, pcv + 4);
                pc.set((pcv & 0xf0000000) | (d.target << 2));
                return true;
            case OP.BAL:
                setValue(regs[31].binary, pcv + 4);
                pc.set(pcv + 4 + d.boff);
                return true;
            case OP.BEQ:
                pc.set(regs[d.rs].binary.raw === regs[d.rt].binary.raw ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BNE:
                pc.set(regs[d.rs].binary.raw !== regs[d.rt].binary.raw ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BGEZ:
                pc.set((regs[d.rs].binary.raw | 0) >= 0 ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BGEZAL:
                setValue(regs[31].binary, pcv + 4);
                pc.set((regs[d.rs].binary.raw | 0) >= 0 ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BGTZ:
                pc.set((regs[d.rs].binary.raw | 0) > 0 ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BLEZ:
                pc.set((regs[d.rs].binary.raw | 0) <= 0 ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BLTZAL:
                setValue(regs[31].binary, pcv + 4);
                pc.set((regs[d.rs].binary.raw | 0) < 0 ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.BLTZ:
                pc.set((regs[d.rs].binary.raw | 0) < 0 ? pcv + 4 + d.boff : pcv + 4);
                return true;
            case OP.ADDIU: {
                const rs = regs[d.rs].binary;
                setValue(regs[d.rt].binary, ((rs.signed ? rs.raw | 0 : rs.raw) + d.immV) | 0);
                break;
            }
            case OP.SLTI:
                setUnsigned(regs[d.rt].binary, (regs[d.rs].binary.raw | 0) < d.immS ? 1 : 0);
                break;
            case OP.SLTIU:
                // the immediate is sign extended, then compared as unsigned
                setUnsigned(regs[d.rt].binary, regs[d.rs].binary.raw < d.immS >>> 0 ? 1 : 0);
                break;
            case OP.ANDI:
                setUnsigned(regs[d.rt].binary, (regs[d.rs].binary.raw & d.immU) >>> 0);
                break;
            case OP.ORI:
                setUnsigned(regs[d.rt].binary, (regs[d.rs].binary.raw | d.immU) >>> 0);
                break;
            case OP.XORI:
                setUnsigned(regs[d.rt].binary, (regs[d.rs].binary.raw ^ d.immU) >>> 0);
                break;
            case OP.LUI:
                setValue(regs[d.rt].binary, d.immV << 16);
                break;
            default: {
                // loads and stores
                const rs = regs[d.rs].binary;
                const address = (rs.signed ? rs.raw | 0 : rs.raw) + d.immV;
                // invalid addresses: fall back so that the same error is thrown
                if (address < TEXT_START || address > 0xffffffff) return false;
                const offset = address & 3;
                const aligned = address - offset;
                const rt = regs[d.rt].binary;
                const memory = this.memory;
                const bigEndian = memory.isBigEndian();
                switch (d.op) {
                    case OP.LW:
                        if (offset !== 0) return false;
                        setValue(rt, memory.readWordValue(address));
                        break;
                    case OP.SW:
                        if (offset !== 0) return false;
                        memory.writeWordValue(address, rt.signed ? rt.raw | 0 : rt.raw);
                        break;
                    case OP.LB:
                    case OP.LBU: {
                        const pos = bigEndian ? (3 - offset) * 8 : offset * 8;
                        const byte = (memory.readWordValue(aligned) >>> pos) & 0xff;
                        if (d.op === OP.LB) setSigned(rt, (byte << 24) >> 24);
                        else setUnsigned(rt, byte);
                        break;
                    }
                    case OP.LH:
                    case OP.LHU: {
                        if ((offset & 1) !== 0) return false;
                        const pos = bigEndian ? (2 - offset) * 8 : offset * 8;
                        const half = (memory.readWordValue(aligned) >>> pos) & 0xffff;
                        if (d.op === OP.LH) setSigned(rt, (half << 16) >> 16);
                        else setUnsigned(rt, half);
                        break;
                    }
                    case OP.SB:
                    case OP.SH: {
                        const isByte = d.op === OP.SB;
                        if (!isByte && (offset & 1) !== 0) return false;
                        const pos = bigEndian
                            ? ((isByte ? 3 : 2) - offset) * 8
                            : offset * 8;
                        const mask = (isByte ? 0xff : 0xffff) << pos;
                        const word = memory.readWordValue(aligned) >>> 0;
                        memory.writeWordValue(
                            aligned,
                            ((word & ~mask) | ((rt.raw & (isByte ? 0xff : 0xffff)) << pos & mask)) >>> 0,
                        );
                        break;
                    }
                    default:
                        return false;
                }
            }
        }
        pc.set(pcv + 4);
        return true;
    }

    /**Kept for compatibility: executes the next instruction recording the UI trace*/
    async execute(vm: VirtualMachine) {
        const result = this.executeNext(vm, !vm.performanceMode);
        if (result) await result;
    }

    reset() {
        const opts = getOptions();
        if (opts["reset-mem"] === true) {
            this.memory.reset();
        }
        if (opts["reset-regs"] === true) {
            this.registers.reset();
        }
        this.pc.set(0);
        this.lo.set(0);
        this.hi.set(0);
        this.halted = false;
        this.clearDecodingCache();
        this.lastTraced = undefined;
        this.lastTracedChaos = false;
    }

    resume(): void {
        this.halted = false;
    }

    halt(): void {
        this.halted = true;
    }

    isHalted(): boolean {
        return this.halted;
    }

    storeByte(address: Binary, value: Binary) {
        this.memory.storeByte(address, value);
    }

    storeWord(address: Binary, value: Binary) {
        this.memory.storeWord(address, value);
    }

    loadByte(address: Binary): Binary {
        return this.memory.loadByte(address);
    }

    loadWord(address: Binary): Binary {
        return this.memory.loadWord(address);
    }

    getFormat(format: string) {
        return this.formats.get(format);
    }

    getRegisters() {
        return this.registers.registers;
    }

    getMemory() {
        return this.memory.get();
    }
}

/**Same as b.set(v) for an integer v in [-2^31, 2^32 - 1] (b of 32 bits)*/
function setValue(b: Binary, v: number) {
    b.signed = v < 0;
    b.raw = v >>> 0;
}
/**Same as b.set(v, true) for an integer v in [-2^31, 2^31 - 1] (b of 32 bits)*/
function setSigned(b: Binary, v: number) {
    b.signed = true;
    b.raw = v >>> 0;
}
/**Same as b.set(v, false) for an integer v in [0, 2^32 - 1] (b of 32 bits)*/
function setUnsigned(b: Binary, v: number) {
    b.signed = false;
    b.raw = v;
}
