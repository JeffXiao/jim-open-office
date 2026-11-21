/**
 * .xlsx import through SheetJS — the mirror of the exporter (src/exporter.ts).
 * A SheetJS workbook read from a local file becomes a Univer snapshot the
 * app can open. Nothing is uploaded: the file is read in the browser and
 * converted in memory.
 *
 * Conversion notes (the inverse of the exporter):
 * - SheetJS stores a formula without '=' (e.g. 'SUM(A1:A2)'); Univer stores
 *   it with '=' — so '=' is added back, and the cached value is kept.
 * - A number-format pattern (cell.z) becomes one shared style entry, and
 *   the cell points at it by id, mirroring how the exporter resolves ids.
 * - Column widths come from '!cols' (wpx); the grid grows past the blank
 *   workbook's 100 rows / 26 columns only when the file's data reaches
 *   further. A file with no sheets opens as a blank workbook.
 */
import type { IWorkbookData } from '@univerjs/core';
import { LocaleType } from '@univerjs/core';
import * as XLSX from 'xlsx';
import { CONFIG } from './config';
import { buildBlankWorkbookSnapshot } from './blank-workbook';

/** Grid size of a fresh blank workbook; grown when the file reaches further. */
const DEFAULT_ROW_COUNT = 100;
const DEFAULT_COLUMN_COUNT = 26;

type ImportedCell = {
    v?: number | string | boolean;
    f?: string;
    s?: string;
};

/** Convert one SheetJS cell into a Univer cell, or null when it holds nothing. */
function importCell(
    cell: XLSX.CellObject,
    styleIdFor: (pattern: string) => string,
): ImportedCell | null {
    const imported: ImportedCell = {};
    if (typeof cell.f === 'string' && cell.f.length > 0) {
        imported.f = `=${cell.f}`;
        if (
            typeof cell.v === 'number' ||
            typeof cell.v === 'string' ||
            typeof cell.v === 'boolean'
        ) {
            imported.v = cell.v;
        }
    } else if (
        typeof cell.v === 'number' ||
        typeof cell.v === 'string' ||
        typeof cell.v === 'boolean'
    ) {
        imported.v = cell.v;
    } else {
        return null;
    }
    if (typeof cell.z === 'string' && cell.z.length > 0) {
        imported.s = styleIdFor(cell.z);
    }
    return imported;
}

/** Convert one SheetJS worksheet into a Univer sheet. */
function worksheetToSheet(
    sheetId: string,
    sheetName: string,
    worksheet: XLSX.WorkSheet,
    styleIdFor: (pattern: string) => string,
): IWorkbookData['sheets'][string] {
    const cellData: Record<string, Record<string, ImportedCell>> = {};
    let maxRow = -1;
    let maxCol = -1;
    for (const [address, cell] of Object.entries(worksheet)) {
        if (address.startsWith('!')) {
            continue;
        }
        const { r, c } = XLSX.utils.decode_cell(address);
        const imported = importCell(cell, styleIdFor);
        if (imported === null) {
            continue;
        }
        (cellData[r] ??= {})[c] = imported;
        maxRow = Math.max(maxRow, r);
        maxCol = Math.max(maxCol, c);
    }
    const sheet: IWorkbookData['sheets'][string] = {
        id: sheetId,
        name: sheetName,
        cellData,
        rowCount: Math.max(DEFAULT_ROW_COUNT, maxRow + 1),
        columnCount: Math.max(DEFAULT_COLUMN_COUNT, maxCol + 1),
    };
    const cols = worksheet['!cols'];
    if (Array.isArray(cols)) {
        const columnData: Record<string, { w?: number }> = {};
        cols.forEach((col, index) => {
            if (col !== undefined && typeof col.wpx === 'number') {
                columnData[index] = { w: col.wpx };
            }
        });
        if (Object.keys(columnData).length > 0) {
            sheet.columnData = columnData as IWorkbookData['sheets'][string]['columnData'];
        }
    }
    return sheet;
}

/** Convert a SheetJS workbook (already read) into a Univer snapshot. */
export function xlsxWorkbookToSnapshot(
    workbook: XLSX.WorkBook,
    name: string = CONFIG.WORKBOOK_NAME,
): IWorkbookData {
    if (workbook.SheetNames.length === 0) {
        return buildBlankWorkbookSnapshot();
    }
    const styles: IWorkbookData['styles'] = {};
    const styleIds = new Map<string, string>();
    const styleIdFor = (pattern: string): string => {
        const existing = styleIds.get(pattern);
        if (existing !== undefined) {
            return existing;
        }
        const id = `imported-style-${styleIds.size + 1}`;
        styleIds.set(pattern, id);
        styles[id] = { n: { pattern } };
        return id;
    };

    const sheets: IWorkbookData['sheets'] = {};
    const sheetOrder: string[] = [];
    workbook.SheetNames.forEach((sheetName, index) => {
        const worksheet = workbook.Sheets[sheetName];
        if (worksheet === undefined) {
            return;
        }
        const sheetId = `imported-sheet-${index + 1}`;
        sheetOrder.push(sheetId);
        sheets[sheetId] = worksheetToSheet(sheetId, sheetName, worksheet, styleIdFor);
    });
    if (sheetOrder.length === 0) {
        return buildBlankWorkbookSnapshot();
    }
    return {
        id: CONFIG.WORKBOOK_ID,
        name,
        appVersion: CONFIG.UNIVER_VERSION,
        locale: LocaleType.EN_US,
        styles,
        sheetOrder,
        sheets,
    };
}

/** Strip the extension off a file name for the workbook title. */
function stripExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** Magic bytes of the two formats SheetJS can read: ZIP (.xlsx) and OLE2 (.xls). */
const XLSX_MAGIC = [0x50, 0x4b];
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/** True when the bytes start with the given magic sequence. */
function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
    return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Read a local .xlsx/.xls file into a Univer snapshot (browser only).
 * SheetJS silently "parses" non-spreadsheet bytes as a one-cell sheet, so
 * the format is checked first: a real file starts with the ZIP or OLE2
 * magic and contains at least one sheet.
 */
export async function readXlsxFile(file: File): Promise<IWorkbookData> {
    const data = await file.arrayBuffer();
    const bytes = new Uint8Array(data);
    if (!hasMagic(bytes, XLSX_MAGIC) && !hasMagic(bytes, XLS_MAGIC)) {
        throw new Error(`"${file.name}" is not a spreadsheet file.`);
    }
    const workbook = XLSX.read(data, { type: 'array', cellFormula: true, cellStyles: true });
    if (workbook.SheetNames.length === 0) {
        throw new Error(`"${file.name}" contains no sheets.`);
    }
    return xlsxWorkbookToSnapshot(workbook, stripExtension(file.name));
}
