/**Minimal .xlsx (Office Open XML) writer: string and number cells, bold header row,
 * wrapped text, frozen header and column widths. Uses JSZip (loaded globally in index.html).*/

export type Sheet = {
    name: string;
    /**the first row is the header*/
    rows: (string | number)[][];
    /**column widths in characters (optional)*/
    widths?: number[];
};

/**Excel limit for the length of a cell*/
const MAX_CELL_LENGTH = 32767;

function escapeXml(text: string): string {
    return (
        text
            // characters not allowed in XML 1.0
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
    );
}

function columnName(index: number): string {
    let name = "";
    index++;
    while (index > 0) {
        const rem = (index - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        index = Math.floor((index - 1) / 26);
    }
    return name;
}

function sheetXml(sheet: Sheet): string {
    const columns = Math.max(1, ...sheet.rows.map((r) => r.length));
    const widths = Array.from({ length: columns }, (_, c) => {
        if (sheet.widths?.[c]) return sheet.widths[c];
        // automatic width: longest line of the column, between 8 and 60 characters
        let max = 8;
        for (const row of sheet.rows) {
            const value = row[c];
            if (value === undefined) continue;
            for (const line of String(value).split("\n"))
                max = Math.max(max, Math.min(60, line.length + 2));
        }
        return max;
    });
    const cols = widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("");
    const rows = sheet.rows
        .map((row, r) => {
            const cells = row
                .map((value, c) => {
                    const ref = `${columnName(c)}${r + 1}`;
                    // style 1: bold header, style 2: wrapped text
                    const style = r === 0 ? 1 : 2;
                    if (typeof value === "number" && Number.isFinite(value)) {
                        return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
                    }
                    let text = String(value ?? "");
                    if (text.length > MAX_CELL_LENGTH)
                        text = text.slice(0, MAX_CELL_LENGTH - 20) + "... (truncated)";
                    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
                })
                .join("");
            return `<row r="${r + 1}">${cells}</row>`;
        })
        .join("");
    const lastRef = `${columnName(columns - 1)}${Math.max(1, sheet.rows.length)}`;
    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
        `<cols>${cols}</cols>` +
        `<sheetData>${rows}</sheetData>` +
        `<autoFilter ref="A1:${lastRef}"/>` +
        `</worksheet>`
    );
}

const STYLES =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

/**Builds the .xlsx file. `JSZipClass` is the JSZip constructor.*/
export async function buildXlsx(sheets: Sheet[], JSZipClass: any): Promise<Blob | Uint8Array> {
    const zip = new JSZipClass();
    // sheet names: max 31 chars, no []:*?/\ and unique
    const names: string[] = [];
    for (const sheet of sheets) {
        let name = sheet.name.replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31) || "Sheet";
        while (names.includes(name)) name = name.slice(0, 28) + names.length;
        names.push(name);
    }
    zip.file(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
            `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
            sheets
                .map(
                    (_, i) =>
                        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
                )
                .join("") +
            `</Types>`,
    );
    zip.file(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
            `</Relationships>`,
    );
    zip.file(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<sheets>` +
            names
                .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
                .join("") +
            `</sheets>` +
            `<definedNames>` +
            sheets
                .map((s, i) => {
                    const cols = Math.max(1, ...s.rows.map((r) => r.length));
                    return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(names[i].replace(/'/g, "''"))}'!$A$1:$${columnName(cols - 1)}$${Math.max(1, s.rows.length)}</definedName>`;
                })
                .join("") +
            `</definedNames>` +
            `</workbook>`,
    );
    zip.file(
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            sheets
                .map(
                    (_, i) =>
                        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
                )
                .join("") +
            `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            `</Relationships>`,
    );
    zip.file("xl/styles.xml", STYLES);
    sheets.forEach((sheet, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet)));
    const type = typeof Blob !== "undefined" ? "blob" : "uint8array";
    return zip.generateAsync({
        type,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        compression: "DEFLATE",
    });
}
