import { getOptions } from "../settings.js";
import { Binary } from "./Utils.js";

enum Alignment {
    Word,
    Half,
    None,
}

/**returns the address in the given binary as a number.
 * throws an error if the required alignment check doesn't pass
 * or if the address is out of bounds*/
function getNumericAddress(
    addr: Binary,
    alignment: Alignment = Alignment.None,
): number {
    const minAddress = 0x400000;
    const maxAddress = 0xffffffff;
    const val = addr.getValue();
    if (val < minAddress) {
        throw new Error(
            `Invalid address: 0x${addr.getHex()}. Minimum address is 0x${minAddress.toString(16).toUpperCase()}.`,
        );
    } else if (val > maxAddress) {
        throw new Error(
            `Invalid address: 0x${addr.getHex()}. Maximum address is 0x${maxAddress.toString(16).toUpperCase()}.`,
        );
    }
    switch (alignment) {
        case Alignment.Word:
            if (val % 4 != 0) {
                throw new Error(
                    `Address: 0x${addr.getHex()} should be word-aligned.`,
                );
            }
        case Alignment.Half:
            if (val % 2 != 0) {
                throw new Error(
                    `Address: 0x${addr.getHex()} should be half-aligned.`,
                );
            }
        case Alignment.None:
            break;
    }
    return val;
}

/**Number of words in a memory page*/
const PAGE_WORDS = 1024;
const WORD_INDEX_MASK = PAGE_WORDS - 1;

/**A page of memory. Words are stored as the numeric value (`Binary.getValue()`) of the
 * word that was written, which is enough to rebuild an equivalent Binary when loading.*/
type Page = {
    values: Float64Array;
    /**1 if the word has been written (only written words are shown in the memory panel)*/
    used: Uint8Array;
};

export class Memory {
    constructor() {
        this.bigEndian = getOptions()["endianness"] === "big";
    }

    private bigEndian: boolean;
    private heapPointer = 0x10040000;
    private pages: Map<number, Page> = new Map<number, Page>();
    /**cache of the last accessed page, memory accesses are very local*/
    private lastPageNumber = -1;
    private lastPage: Page | undefined = undefined;

    isBigEndian(): boolean {
        return this.bigEndian;
    }
    private byteBitPosition(byteOffset: number): number {
        return this.bigEndian ? (3 - byteOffset) * 8 : byteOffset * 8;
    }
    private halfBitPosition(byteOffset: number): number {
        return this.bigEndian ? (2 - byteOffset) * 8 : byteOffset * 8;
    }

    private getPage(address: number, create: boolean): Page | undefined {
        const pageNumber = Math.floor(address / 4096);
        if (pageNumber === this.lastPageNumber) return this.lastPage;
        let page = this.pages.get(pageNumber);
        if (!page) {
            if (!create) return undefined;
            page = {
                values: new Float64Array(PAGE_WORDS),
                used: new Uint8Array(PAGE_WORDS),
            };
            this.pages.set(pageNumber, page);
        }
        this.lastPageNumber = pageNumber;
        this.lastPage = page;
        return page;
    }

    /**Fast path: returns the value (as `Binary.getValue()` would) of the word at the given
     * word-aligned and valid address, 0 if never written. No checks are done on the address.*/
    readWordValue(address: number): number {
        const page = this.getPage(address, false);
        if (page === undefined) return 0;
        return page.values[(address >>> 2) & WORD_INDEX_MASK];
    }

    /**Fast path: stores a word value at the given word-aligned and valid address.
     * @param value the word value as `Binary.getValue()` would return it
     * (in [-2^31, 2^31 - 1] for negative values and in [0, 2^32 - 1] otherwise).*/
    writeWordValue(address: number, value: number) {
        const page = this.getPage(address, true)!;
        const index = (address >>> 2) & WORD_INDEX_MASK;
        page.values[index] = value;
        page.used[index] = 1;
    }

    /**Inits the heap pointer to 0x10040000 or after the static data end if it exceeds 0x10040000*/
    initHeapPointer(staticDataEnd: number) {
        this.heapPointer = Math.max(staticDataEnd + 4, 0x10040000);
    }

    /**Returns the pointer to the available memory and increases the heap pointer*/
    allocate(bytes: number) {
        const pointer = this.heapPointer;
        let nextHeap = pointer + bytes;
        if (nextHeap % 4 !== 0) {
            nextHeap = nextHeap + (4 - (nextHeap % 4));
        }
        this.heapPointer = nextHeap;
        return pointer;
    }

    storeWord(wordAddress: Binary, value: Binary) {
        let address = getNumericAddress(wordAddress, Alignment.Word);
        this.writeWordValue(address, value.getValue());
    }

    loadWord(wordAddress: Binary, signed: boolean = false): Binary {
        const address = getNumericAddress(wordAddress, Alignment.Word);
        const value = this.readWordValue(address);
        return new Binary(signed ? value : value >>> 0, 32, signed);
    }

    storeByte(wordAddress: Binary, value: Binary) {
        const address = getNumericAddress(wordAddress);
        const byteOffset = address % 4;
        const alignedAddress = address - byteOffset;
        const wordAlignedAddress = new Binary(alignedAddress);
        let word: Binary = this.loadWord(wordAlignedAddress);

        const bitPosition = this.byteBitPosition(byteOffset);

        word.setBits(value, bitPosition + 7, bitPosition);

        this.storeWord(new Binary(alignedAddress), word);
    }

    loadByte(wordAddress: Binary): Binary {
        const address = getNumericAddress(wordAddress);
        const byteOffset = address % 4;
        const alignedAddress = address - byteOffset;
        const wordAlignedAddress = new Binary(alignedAddress);
        let word: Binary = this.loadWord(wordAlignedAddress, false);

        const bitPosition = this.byteBitPosition(byteOffset);

        return word.getBits(bitPosition + 7, bitPosition, true);
    }

    loadHalf(wordAddress: Binary): Binary {
        const address = getNumericAddress(wordAddress, Alignment.Half);
        const byteOffset = address % 4;

        const alignedAddress = address - byteOffset;
        const wordAlignedAddress = new Binary(alignedAddress);
        let word: Binary = this.loadWord(wordAlignedAddress);

        const bitPosition = this.halfBitPosition(byteOffset); // 0 or 16

        return word.getBits(bitPosition + 15, bitPosition, true);
    }

    storeHalf(wordAddress: Binary, value: Binary) {
        const address = getNumericAddress(wordAddress, Alignment.Half);
        const byteOffset = address % 4;
        const alignedAddress = address - byteOffset;
        const wordAlignedAddress = new Binary(alignedAddress);
        let word: Binary = this.loadWord(wordAlignedAddress);

        const bitPosition = this.halfBitPosition(byteOffset); // 0 or 16

        word.setBits(value, bitPosition + 15, bitPosition);

        this.storeWord(new Binary(alignedAddress), word);
    }

    /**Returns all the written words sorted by address*/
    get() {
        const sortedMemory = new Map<number, Binary>();
        const pageNumbers = Array.from(this.pages.keys()).sort((a, b) => a - b);
        for (const pageNumber of pageNumbers) {
            const page = this.pages.get(pageNumber)!;
            const base = pageNumber * 4096;
            for (let i = 0; i < PAGE_WORDS; i++) {
                if (page.used[i] === 1) {
                    sortedMemory.set(base + i * 4, new Binary(page.values[i]));
                }
            }
        }
        return sortedMemory;
    }

    /**Returns the highest written address, or -Infinity if the memory is empty*/
    getMaxAddress(): number {
        let max = -Infinity;
        for (const [pageNumber, page] of this.pages) {
            for (let i = PAGE_WORDS - 1; i >= 0; i--) {
                if (page.used[i] === 1) {
                    max = Math.max(max, pageNumber * 4096 + i * 4);
                    break;
                }
            }
        }
        return max;
    }

    reset() {
        this.pages.clear();
        this.lastPageNumber = -1;
        this.lastPage = undefined;
    }

    getString(stringAddress: Binary): string {
        const bytes: number[] = [];
        // copy the address: the given Binary is often a register (e.g. $a0) and must not change
        const address = new Binary(stringAddress.getValue());

        let byte = this.loadByte(address);
        while (byte.getValue() !== 0) {
            bytes.push(byte.getUnsignedValue());
            address.set(address.getValue() + 1);
            byte = this.loadByte(address);
        }

        const decoder = new TextDecoder("latin1");
        const str = decoder.decode(new Uint8Array(bytes));
        return str;
    }
}
