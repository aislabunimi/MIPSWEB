import { asciiTable } from "../utils.js";

export class Utils {
    static toHex(value: number, bits: number = 32): string {
        const hex = (value >>> 0)
            .toString(16)
            .padStart(Math.ceil(bits / 4), "0");
        return hex;
    }

    static toBinary(
        value: number,
        bits: number = 32,
        split: number = 8,
    ): string {
        const binary = (value >>> 0).toString(2).padStart(bits, "0");

        const parts: string[] = [];
        for (let i = 0; i < bits; i += split) {
            parts.push(binary.substring(i, i + split));
        }

        return parts.join(" ");
    }

    static toAscii(value: number, bits: number): string[] {
        if (bits <= 0 || bits % 8 !== 0) {
            throw new Error(
                `The number of bits (${bits}) must be a positive multiple of 8.`,
            );
        }

        let ascii: string[] = [];

        for (let i = bits - 8; i >= 0; i -= 8) {
            const byte = (value >> i) & 0xff;
            if (byte < 128) {
                ascii.push(asciiTable[byte]);
            } else {
                ascii.push("�");
            }
        }

        return ascii;
    }

    static toSigned(value: number, bits: number): number {
        const half = POW2[bits - 1];
        if (value < -half || value > half - 1) {
            throw new Error(
                `Value ${value} is out of range for signed ${bits}-bit representation. Expected between ${-half} and ${half - 1}.`,
            );
        }

        if (value >= 0) {
            return value;
        } else {
            return POW2[bits] + value;
        }
    }

    static fromSigned(value: number, bits: number): number {
        if (value >= POW2[bits - 1]) {
            return value - POW2[bits];
        } else {
            return value;
        }
    }

    static toUnsigned(value: number, bits: number): number {
        if (value < 0 || value > POW2[bits] - 1) {
            throw new Error(
                `Value ${value} is out of range for unsigned ${bits}-bit representation. Expected between 0 and ${POW2[bits] - 1}.`,
            );
        }

        return value;
    }
}

/**Precomputed powers of two (POW2[n] === 2 ** n) for n in [0, 64]*/
const POW2: number[] = Array.from({ length: 65 }, (_, i) => 2 ** i);

export class Binary {
    /**Unsigned representation of the value, always in [0, 2^length - 1].
     * Exposed (instead of private) only so that the CPU fast path can read and write
     * registers without method calls: outside of CPU.ts always use the methods.*/
    raw: number = 0;
    length: number;
    signed: boolean;

    constructor(value: number = 0, bits: number = 32, signed: boolean = false) {
        this.length = bits;
        this.signed = signed;
        this.set(value);
    }

    set(value: number, signed?: boolean) {
        if (typeof signed === "undefined") {
            signed = value < 0;
        }
        this.signed = signed;
        if (
            this.length === 32 &&
            value === Math.floor(value) &&
            (signed
                ? value >= -2147483648 && value <= 2147483647
                : value >= 0 && value <= 4294967295)
        ) {
            // fast path for the common case (in range 32 bit integer)
            this.raw = value >>> 0;
        } else if (signed) {
            this.raw = Utils.toSigned(value, this.length);
        } else {
            this.raw = Utils.toUnsigned(value, this.length);
        }
    }

    getValue(): number {
        if (this.signed) {
            return Utils.fromSigned(this.raw, this.length);
        } else {
            return this.raw;
        }
    }

    getUnsignedValue(): number {
        return this.raw;
    }

    getSignedValue(): number {
        const shift = 32 - this.length;
        return (this.raw << shift) >> shift;
    }

    /**@param from: number in [this.length-0]
     * @param to: number in [this.length-0] and has to be less than from, range is inclusive
     * @returns Binary representing bits from-to */
    getBits(from: number, to: number, signed: boolean = false): Binary {
        const bits = from - to + 1;
        let extractedBits: number;
        if (bits <= 0) {
            extractedBits = 0;
        } else if (to >= 32) {
            extractedBits = 0;
        } else if (bits >= 32) {
            extractedBits = (this.raw / POW2[to]) >>> 0;
        } else {
            extractedBits =
                ((this.raw >>> to) & (POW2[bits] - 1)) >>> 0;
        }
        if (signed) {
            return new Binary(
                Utils.fromSigned(extractedBits, bits),
                bits,
                true,
            );
        } else {
            return new Binary(extractedBits, bits);
        }
    }

    setBits(bits: Binary, from: number, to: number) {
        const mask = ((1 << (from - to + 1)) - 1) << to;
        this.raw = ((this.raw & ~mask) | ((bits.raw << to) & mask)) >>> 0;
    }

    getHex(): string {
        return Utils.toHex(this.raw, this.length);
    }

    getBinary(split: number = 8): string {
        return Utils.toBinary(this.raw, this.length, split);
    }

    getAscii(): string {
        const asciiArray = Utils.toAscii(this.raw, this.length);
        return asciiArray.join(" ");
    }

    copy(): Binary {
        return new Binary(this.getValue(), this.length, this.signed);
    }

    equals(binary: Binary): boolean {
        if (this.length !== binary.length) return false;
        return this.raw === binary.raw;
    }
}
