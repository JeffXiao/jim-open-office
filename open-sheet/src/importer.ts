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
import {
    indexToColumnLetters,
    parseCellAddress,
    parseConstraint,
    parseRange,
} from './solver/model';

/** What the Solver dialog needs, as imported from a saved Solver model. */
export type ImportedSolverParams = {
    objective: string;
    goal: 'max' | 'min' | 'value';
    targetValue: string;
    changing: string;
    nonNegative: boolean;
    method: string;
    constraints: { left: string; operator: string; right: string }[];
};

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

/**
 * Excel stores a saved Solver model as defined names (solver_opt,
 * solver_adj, solver_typ, solver_val, solver_num, solver_lhsN,
 * solver_relN, solver_rhsN, solver_neg, solver_eng) in the workbook.
 * solver_rel codes are 1 = <=, 2 = =, 3 = >=; solver_typ is 1 = Max,
 * 2 = Min, 3 = Value Of; solver_eng is 1 = GRG Nonlinear, 2 = Simplex LP,
 * 3 = Evolutionary; solver_neg is 1 = non-negative on. The refs carry the
 * sheet name (Sheet1!$BM$60) and the constants are bare numbers ("1").
 * Returns null when the workbook has no usable Solver model — the dialog
 * then keeps its defaults. A model is only imported when its refs point
 * at the first sheet, which is the one the app opens active; the Solver
 * always runs on the active sheet.
 */
export function extractSolverParams(workbook: XLSX.WorkBook): ImportedSolverParams | null {
    const names = workbook.Workbook?.Names;
    if (names === undefined || names.length === 0) {
        return null;
    }
    const byName = new Map<string, string>();
    for (const entry of names) {
        if (typeof entry.Name === 'string' && typeof entry.Ref === 'string') {
            byName.set(entry.Name.toLowerCase(), entry.Ref);
        }
    }
    const firstSheet = workbook.SheetNames[0] ?? '';

    /** The sheet a ref points at (null when the ref has no sheet prefix). */
    const sheetOf = (ref: string): string | null => {
        const bang = ref.lastIndexOf('!');
        if (bang < 0) {
            return null;
        }
        let sheet = ref.slice(0, bang);
        if (sheet.startsWith("'") && sheet.endsWith("'")) {
            sheet = sheet.slice(1, -1).replace(/''/g, "'");
        }
        return sheet;
    };
    /** A ref usable for this workbook: on the first sheet, or sheet-less. */
    const onFirstSheet = (ref: string): boolean => {
        const sheet = sheetOf(ref);
        return sheet === null || sheet === firstSheet;
    };
    /** Drop the sheet prefix (up to the last '!') and any $ markers. */
    const bareAddress = (ref: string): string => {
        const bang = ref.lastIndexOf('!');
        return (bang < 0 ? ref : ref.slice(bang + 1)).replace(/\$/g, '');
    };
    /** A ref as a cell address, normalized (BM60), or null. */
    const refToCell = (ref: string | undefined): string | null => {
        if (ref === undefined || !onFirstSheet(ref)) {
            return null;
        }
        const cell = parseCellAddress(bareAddress(ref));
        return cell === null
            ? null
            : `${indexToColumnLetters(cell.col)}${cell.row + 1}`;
    };
    /** A ref as a range, normalized (BM31:BM49, or BM50 alone), or null. */
    const refToRange = (ref: string | undefined): string | null => {
        if (ref === undefined || !onFirstSheet(ref)) {
            return null;
        }
        const range = parseRange(bareAddress(ref));
        if (range === null) {
            return null;
        }
        const start = `${indexToColumnLetters(range.start.col)}${range.start.row + 1}`;
        const end = `${indexToColumnLetters(range.end.col)}${range.end.row + 1}`;
        return start === end ? start : `${start}:${end}`;
    };
    /** A ref that is a plain number (solver_typ, solver_val, ...), or null. */
    const refToNumber = (ref: string | undefined): number | null => {
        if (ref === undefined) {
            return null;
        }
        const value = Number(ref);
        return Number.isFinite(value) ? value : null;
    };

    const objective = refToCell(byName.get('solver_opt'));
    const changing = refToRange(byName.get('solver_adj'));
    if (objective === null || changing === null) {
        return null;
    }
    const goalCode = refToNumber(byName.get('solver_typ'));
    const goal: ImportedSolverParams['goal'] =
        goalCode === 2 ? 'min' : goalCode === 3 ? 'value' : 'max';
    const targetValue =
        goal === 'value'
            ? (() => {
                  const value = refToNumber(byName.get('solver_val'));
                  return value === null ? '' : String(value);
              })()
            : '';
    const constraints: ImportedSolverParams['constraints'] = [];
    const count = refToNumber(byName.get('solver_num'));
    const relOperators: Record<number, string> = { 1: '<=', 2: '=', 3: '>=' };
    if (count !== null) {
        for (let index = 1; index <= count; index++) {
            const left = refToRange(byName.get(`solver_lhs${index}`));
            const rel = refToNumber(byName.get(`solver_rel${index}`));
            const operator = rel === null ? undefined : relOperators[rel];
            if (left === null || operator === undefined) {
                continue;
            }
            const rhsRef = byName.get(`solver_rhs${index}`);
            let right: string | null = null;
            const rhsNumber = refToNumber(rhsRef);
            if (rhsNumber !== null) {
                right = String(rhsNumber);
            } else {
                right = refToRange(rhsRef);
            }
            if (right === null) {
                continue;
            }
            // Skip anything the dialog could not solve with (a range right
            // side, an unknown operator, or a bad address).
            if (parseConstraint(left, operator, right) === null) {
                continue;
            }
            constraints.push({ left, operator, right });
        }
    }
    const neg = refToNumber(byName.get('solver_neg'));
    const nonNegative = neg === null ? true : neg !== 0;
    const eng = refToNumber(byName.get('solver_eng'));
    const method = eng === 2 ? 'simplex' : eng === 3 ? 'evolutionary' : 'grg';
    return { objective, goal, targetValue, changing, nonNegative, method, constraints };
}

/** Magic bytes of the two formats SheetJS can read: ZIP (.xlsx) and OLE2 (.xls). */
const XLSX_MAGIC = [0x50, 0x4b];
const XLS_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

/** True when the bytes start with the given magic sequence. */
function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
    return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Read a local .xlsx/.xls file into a Univer snapshot (browser only),
 * plus the saved Solver model when the file has one. SheetJS silently
 * "parses" non-spreadsheet bytes as a one-cell sheet, so the format is
 * checked first: a real file starts with the ZIP or OLE2 magic and
 * contains at least one sheet.
 */
export async function readXlsxFile(file: File): Promise<{
    snapshot: IWorkbookData;
    solverParams: ImportedSolverParams | null;
}> {
    const data = await file.arrayBuffer();
    const bytes = new Uint8Array(data);
    if (!hasMagic(bytes, XLSX_MAGIC) && !hasMagic(bytes, XLS_MAGIC)) {
        throw new Error(`"${file.name}" is not a spreadsheet file.`);
    }
    const workbook = XLSX.read(data, { type: 'array', cellFormula: true, cellStyles: true });
    if (workbook.SheetNames.length === 0) {
        throw new Error(`"${file.name}" contains no sheets.`);
    }
    return {
        snapshot: xlsxWorkbookToSnapshot(workbook, stripExtension(file.name)),
        solverParams: extractSolverParams(workbook),
    };
}
