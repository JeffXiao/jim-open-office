/**
 * Unit tests for the .xlsx importer (src/importer.ts).
 * Only the pure conversion (xlsxWorkbookToSnapshot) and the file read
 * (readXlsxFile) are tested here — both run in Node with SheetJS workbooks
 * built in memory, no browser needed. The toolbar wiring (picker, confirm
 * dialog, replace) is covered by the Playwright harness, which picks a real
 * file in a real browser.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readXlsxFile, xlsxWorkbookToSnapshot } from '../../src/importer';
import { snapshotToXlsxWorkbook } from '../../src/exporter';
import { buildBlankWorkbookSnapshot } from '../../src/blank-workbook';
import { CONFIG } from '../../src/config';

/** Build a SheetJS workbook from named worksheets. */
function makeWorkbook(sheets: Record<string, XLSX.WorkSheet>): XLSX.WorkBook {
    const workbook = XLSX.utils.book_new();
    for (const [name, sheet] of Object.entries(sheets)) {
        XLSX.utils.book_append_sheet(workbook, sheet, name);
    }
    return workbook;
}

/** Read one imported cell back out, without fighting the Univer types. */
function cellAt(
    snapshot: ReturnType<typeof xlsxWorkbookToSnapshot>,
    sheetIndex: number,
    row: number,
    col: number,
): { v?: unknown; f?: string; s?: string } {
    const sheetId = snapshot.sheetOrder[sheetIndex];
    const sheet = sheetId === undefined ? undefined : snapshot.sheets[sheetId];
    const cell = sheet?.cellData?.[row]?.[col] as
        | { v?: unknown; f?: string; s?: string }
        | undefined;
    return cell ?? {};
}

describe('xlsxWorkbookToSnapshot', () => {
    it('opens a file with no sheets as a blank workbook', () => {
        const snapshot = xlsxWorkbookToSnapshot(XLSX.utils.book_new());
        expect(snapshot.sheetOrder).toEqual([CONFIG.SHEET_ID]);
        expect(snapshot.sheets[CONFIG.SHEET_ID]?.cellData).toEqual({});
    });

    it('keeps numbers, strings, and booleans with their types', () => {
        const sheet = XLSX.utils.aoa_to_sheet([[42, 'hello', true, 3.5]]);
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        expect(cellAt(snapshot, 0, 0, 0)).toMatchObject({ v: 42 });
        expect(cellAt(snapshot, 0, 0, 1)).toMatchObject({ v: 'hello' });
        expect(cellAt(snapshot, 0, 0, 2)).toMatchObject({ v: true });
        expect(cellAt(snapshot, 0, 0, 3)).toMatchObject({ v: 3.5 });
    });

    it('keeps a formula (with = added back) and its cached value', () => {
        const sheet = XLSX.utils.aoa_to_sheet([[2], [3]]);
        sheet['A3'] = { t: 'n', f: 'SUM(A1:A2)', v: 5 };
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        expect(cellAt(snapshot, 0, 2, 0)).toMatchObject({ f: '=SUM(A1:A2)', v: 5 });
    });

    it('keeps a formula even when no cached value was stored', () => {
        const sheet: XLSX.WorkSheet = {};
        sheet['A1'] = { t: 'n', f: 'SUM(B1:B2)' };
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        expect(cellAt(snapshot, 0, 0, 0).f).toBe('=SUM(B1:B2)');
        expect(cellAt(snapshot, 0, 0, 0).v).toBeUndefined();
    });

    it('turns a number-format pattern into one shared style entry', () => {
        const sheet = XLSX.utils.aoa_to_sheet([[0.05, 0.07]]);
        sheet['A1']!.z = '0.00%';
        sheet['B1']!.z = '0.00%';
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        const first = cellAt(snapshot, 0, 0, 0);
        const second = cellAt(snapshot, 0, 0, 1);
        expect(first.s).toBeDefined();
        expect(first.s).toBe(second.s);
        const style = first.s === undefined ? undefined : snapshot.styles[first.s];
        expect(style).toMatchObject({ n: { pattern: '0.00%' } });
    });

    it('carries column widths across', () => {
        const sheet = XLSX.utils.aoa_to_sheet([[1]]);
        const cols: XLSX.ColInfo[] = [];
        cols[0] = { wpx: 120 };
        cols[2] = { wpx: 80 };
        sheet['!cols'] = cols;
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        const sheetId = snapshot.sheetOrder[0];
        const imported = sheetId === undefined ? undefined : snapshot.sheets[sheetId];
        expect(imported?.columnData).toMatchObject({ '0': { w: 120 }, '2': { w: 80 } });
    });

    it('keeps every sheet, in order, under its own name', () => {
        const snapshot = xlsxWorkbookToSnapshot(
            makeWorkbook({
                Alpha: XLSX.utils.aoa_to_sheet([[1]]),
                Beta: XLSX.utils.aoa_to_sheet([[2]]),
            }),
        );
        expect(snapshot.sheetOrder).toHaveLength(2);
        const names = snapshot.sheetOrder.map((id) => snapshot.sheets[id]?.name);
        expect(names).toEqual(['Alpha', 'Beta']);
        expect(cellAt(snapshot, 1, 0, 0)).toMatchObject({ v: 2 });
    });

    it('grows the grid past 100 rows / 26 columns when the data reaches further', () => {
        const sheet: XLSX.WorkSheet = {};
        sheet['A151'] = { t: 'n', v: 1 };
        sheet['AA1'] = { t: 'n', v: 2 };
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        const sheetId = snapshot.sheetOrder[0];
        const imported = sheetId === undefined ? undefined : snapshot.sheets[sheetId];
        expect(imported?.rowCount).toBe(151);
        expect(imported?.columnCount).toBe(27);
    });

    it('stays at the blank size for a small file', () => {
        const sheet = XLSX.utils.aoa_to_sheet([[1]]);
        const snapshot = xlsxWorkbookToSnapshot(makeWorkbook({ Sheet1: sheet }));
        const sheetId = snapshot.sheetOrder[0];
        const imported = sheetId === undefined ? undefined : snapshot.sheets[sheetId];
        expect(imported?.rowCount).toBe(100);
        expect(imported?.columnCount).toBe(26);
    });

    it('uses the given name as the workbook title, Untitled by default', () => {
        const workbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        expect(xlsxWorkbookToSnapshot(workbook, 'My Report').name).toBe('My Report');
        expect(xlsxWorkbookToSnapshot(workbook).name).toBe(CONFIG.WORKBOOK_NAME);
    });

    it('round-trips through the exporter: values, formulas, formats, widths', () => {
        const snapshot = buildBlankWorkbookSnapshot();
        const sheet = snapshot.sheets[CONFIG.SHEET_ID];
        if (sheet === undefined) {
            throw new Error('blank snapshot has no sheet');
        }
        sheet.cellData = {
            '0': {
                '0': { v: 2 },
                '1': { v: 0.05, s: 'pct' },
            },
            '1': { '0': { v: 5, f: '=SUM(A1:A1)' } },
        };
        snapshot.styles = { pct: { n: { pattern: '0.00%' } } };
        sheet.columnData = { '0': { w: 120 } } as typeof sheet.columnData;

        const exported = snapshotToXlsxWorkbook(snapshot);
        const roundTripped = xlsxWorkbookToSnapshot(exported);
        expect(roundTripped.sheetOrder).toHaveLength(1);
        expect(cellAt(roundTripped, 0, 0, 0)).toMatchObject({ v: 2 });
        expect(cellAt(roundTripped, 0, 1, 0)).toMatchObject({ f: '=SUM(A1:A1)', v: 5 });
        const styled = cellAt(roundTripped, 0, 0, 1);
        const pattern =
            styled.s === undefined
                ? undefined
                : (roundTripped.styles[styled.s] as { n?: { pattern?: string } } | undefined)?.n
                      ?.pattern;
        expect(pattern).toBe('0.00%');
        const outId = roundTripped.sheetOrder[0];
        const outSheet = outId === undefined ? undefined : roundTripped.sheets[outId];
        expect(outSheet?.columnData).toMatchObject({ '0': { w: 120 } });
    });
});

describe('readXlsxFile', () => {
    it('reads a real .xlsx file and names the workbook after it', async () => {
        const workbook = makeWorkbook({ Data: XLSX.utils.aoa_to_sheet([[1, 2]]) });
        const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const file = new File([bytes], 'quarterly.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const snapshot = await readXlsxFile(file);
        expect(snapshot.name).toBe('quarterly');
        expect(cellAt(snapshot, 0, 0, 0)).toMatchObject({ v: 1 });
        expect(cellAt(snapshot, 0, 0, 1)).toMatchObject({ v: 2 });
    });

    it('rejects a file that is not a spreadsheet', async () => {
        const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'bad.xlsx');
        await expect(readXlsxFile(file)).rejects.toThrow();
    });
});
