/**
 * .xlsx export through SheetJS (the same bridge GridBook uses).
 * Input is a Univer workbook snapshot; output is a SheetJS workbook with
 * formulas preserved (so Excel recalculates) and the cached values kept.
 */
import type { IWorkbookData } from '@univerjs/core';
import * as XLSX from 'xlsx';
import { CONFIG } from './config';

type SnapshotCell = {
    v?: number | string | boolean | null;
    f?: string | null;
    s?: string | Record<string, unknown> | null;
};

/** Resolve a cell's number-format pattern from the workbook's style map. */
function stylePattern(
    styles: IWorkbookData['styles'],
    style: SnapshotCell['s'],
): string | undefined {
    if (typeof style !== 'string') {
        return undefined;
    }
    const styleData = styles[style] as { n?: { pattern?: string } } | undefined;
    return styleData?.n?.pattern;
}

/** Convert one Univer sheet's cell data into a SheetJS worksheet object. */
function snapshotSheetToWorksheet(
    sheet: IWorkbookData['sheets'][string],
    styles: IWorkbookData['styles'],
): XLSX.WorkSheet {
    const worksheet: XLSX.WorkSheet = {};
    const cellData = sheet.cellData ?? {};

    for (const [rowKey, row] of Object.entries(cellData)) {
        const rowIndex = Number(rowKey);
        for (const [colKey, cell] of Object.entries(row as Record<string, SnapshotCell>)) {
            const colIndex = Number(colKey);
            const address = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
            const pattern = stylePattern(styles, cell.s);
            if (typeof cell.f === 'string' && cell.f.length > 0) {
                const formulaCell: XLSX.CellObject = {
                    t: 'n',
                    f: cell.f.replace(/^=/, ''),
                    v: typeof cell.v === 'number' ? cell.v : undefined,
                };
                if (pattern !== undefined) {
                    formulaCell.z = pattern;
                }
                worksheet[address] = formulaCell;
            } else if (typeof cell.v === 'number') {
                const numberCell: XLSX.CellObject = { t: 'n', v: cell.v };
                if (pattern !== undefined) {
                    numberCell.z = pattern;
                }
                worksheet[address] = numberCell;
            } else if (typeof cell.v === 'string') {
                worksheet[address] = { t: 's', v: cell.v };
            } else if (typeof cell.v === 'boolean') {
                worksheet[address] = { t: 'b', v: cell.v };
            }
        }
    }

    const columnData = sheet.columnData as
        | Record<string, { w?: number }>
        | undefined;
    if (columnData !== undefined) {
        const columns: XLSX.ColInfo[] = [];
        for (const [colKey, col] of Object.entries(columnData)) {
            if (typeof col.w === 'number') {
                columns[Number(colKey)] = { wpx: col.w };
            }
        }
        if (columns.length > 0) {
            worksheet['!cols'] = columns;
        }
    }

    const ref = computeRef(cellData);
    if (ref !== undefined) {
        worksheet['!ref'] = ref;
    }
    return worksheet;
}

/** The used range of a sheet's cell data, as an A1 ref string. */
function computeRef(
    cellData: IWorkbookData['sheets'][string]['cellData'],
): string | undefined {
    if (cellData === undefined) {
        return undefined;
    }
    let maxRow = -1;
    let maxCol = -1;
    for (const [rowKey, row] of Object.entries(cellData)) {
        for (const colKey of Object.keys(row as Record<string, unknown>)) {
            maxRow = Math.max(maxRow, Number(rowKey));
            maxCol = Math.max(maxCol, Number(colKey));
        }
    }
    if (maxRow < 0 || maxCol < 0) {
        return undefined;
    }
    return XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
}

/** Convert a whole workbook snapshot into a SheetJS workbook. */
export function snapshotToXlsxWorkbook(snapshot: IWorkbookData): XLSX.WorkBook {
    const workbook = XLSX.utils.book_new();
    for (const sheetId of snapshot.sheetOrder) {
        const sheet = snapshot.sheets[sheetId];
        if (sheet === undefined) {
            continue;
        }
        const worksheet = snapshotSheetToWorksheet(sheet, snapshot.styles);
        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name ?? sheetId);
    }
    return workbook;
}

/** Write the snapshot out as an .xlsx download in the browser. */
export function exportSnapshotToXlsx(snapshot: IWorkbookData): void {
    const workbook = snapshotToXlsxWorkbook(snapshot);
    XLSX.writeFile(workbook, CONFIG.EXPORT_FILE_NAME);
}
