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
import { extractSolverParams, readXlsxFile, xlsxWorkbookToSnapshot } from '../../src/importer';
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
        const { snapshot, solverParams } = await readXlsxFile(file);
        expect(snapshot.name).toBe('quarterly');
        expect(cellAt(snapshot, 0, 0, 0)).toMatchObject({ v: 1 });
        expect(cellAt(snapshot, 0, 0, 1)).toMatchObject({ v: 2 });
        expect(solverParams).toBeNull();
    });

    it('rejects a file that is not a spreadsheet', async () => {
        const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'bad.xlsx');
        await expect(readXlsxFile(file)).rejects.toThrow();
    });

    it('returns the saved Solver model when the file carries one', async () => {
        const workbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[0, 0]]) });
        setSolverNames(workbook, SOLVER_NAMES);
        const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
        const file = new File([bytes], 'model.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const { solverParams } = await readXlsxFile(file);
        expect(solverParams).toMatchObject({
            objective: 'BM60',
            goal: 'max',
            changing: 'BM31:BM49',
            nonNegative: true,
            method: 'grg',
        });
        expect(solverParams?.constraints).toHaveLength(3);
    });
});

/** Attach defined names to a workbook, the way Excel stores a Solver model. */
function setSolverNames(
    workbook: XLSX.WorkBook,
    names: { Name: string; Ref: string }[],
): void {
    workbook.Workbook = { ...(workbook.Workbook ?? {}), Names: names };
}

/**
 * A synthetic Solver model in the same shape as a real portfolio file
 * (objective BM60, changing BM31:BM49, three constraints) — built from
 * scratch, not copied from any real file.
 */
const SOLVER_NAMES = [
    { Name: 'solver_opt', Ref: 'Sheet1!$BM$60' },
    { Name: 'solver_adj', Ref: 'Sheet1!$BM$31:$BM$49' },
    { Name: 'solver_typ', Ref: '1' },
    { Name: 'solver_val', Ref: '0' },
    { Name: 'solver_num', Ref: '3' },
    { Name: 'solver_lhs1', Ref: 'Sheet1!$BM$31:$BM$49' },
    { Name: 'solver_rel1', Ref: '3' },
    { Name: 'solver_rhs1', Ref: '0' },
    { Name: 'solver_lhs2', Ref: 'Sheet1!$BM$50' },
    { Name: 'solver_rel2', Ref: '1' },
    { Name: 'solver_rhs2', Ref: '1' },
    { Name: 'solver_lhs3', Ref: 'Sheet1!$BM$56' },
    { Name: 'solver_rel3', Ref: '1' },
    { Name: 'solver_rhs3', Ref: '0.2' },
    { Name: 'solver_neg', Ref: '1' },
    { Name: 'solver_eng', Ref: '1' },
];

describe('extractSolverParams', () => {
    it('extracts a full Solver model', () => {
        const workbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[0]]) });
        setSolverNames(workbook, SOLVER_NAMES);
        expect(extractSolverParams(workbook)).toEqual({
            objective: 'BM60',
            goal: 'max',
            targetValue: '',
            changing: 'BM31:BM49',
            nonNegative: true,
            method: 'grg',
            constraints: [
                { left: 'BM31:BM49', operator: '>=', right: '0' },
                { left: 'BM50', operator: '<=', right: '1' },
                { left: 'BM56', operator: '<=', right: '0.2' },
            ],
        });
    });

    it('returns null when the workbook has no Solver names', () => {
        const workbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        expect(extractSolverParams(workbook)).toBeNull();
    });

    it('returns null when the objective or the changing range is missing', () => {
        const noObjective = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        setSolverNames(noObjective, SOLVER_NAMES.filter((n) => n.Name !== 'solver_opt'));
        expect(extractSolverParams(noObjective)).toBeNull();
        const noChanging = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        setSolverNames(noChanging, SOLVER_NAMES.filter((n) => n.Name !== 'solver_adj'));
        expect(extractSolverParams(noChanging)).toBeNull();
    });

    it('reads Value Of with its target, Min, non-negative off, and Simplex', () => {
        const workbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        setSolverNames(workbook, [
            { Name: 'solver_opt', Ref: 'Sheet1!$B$1' },
            { Name: 'solver_adj', Ref: 'Sheet1!$A$1:$A$2' },
            { Name: 'solver_typ', Ref: '3' },
            { Name: 'solver_val', Ref: '2.5' },
            { Name: 'solver_num', Ref: '0' },
            { Name: 'solver_neg', Ref: '0' },
            { Name: 'solver_eng', Ref: '2' },
        ]);
        expect(extractSolverParams(workbook)).toEqual({
            objective: 'B1',
            goal: 'value',
            targetValue: '2.5',
            changing: 'A1:A2',
            nonNegative: false,
            method: 'simplex',
            constraints: [],
        });
        const minWorkbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        setSolverNames(minWorkbook, [
            { Name: 'solver_opt', Ref: 'Sheet1!$B$1' },
            { Name: 'solver_adj', Ref: 'Sheet1!$A$1:$A$2' },
            { Name: 'solver_typ', Ref: '2' },
        ]);
        expect(extractSolverParams(minWorkbook)).toMatchObject({
            goal: 'min',
            targetValue: '',
            nonNegative: true,
            method: 'grg',
        });
    });

    it('keeps a cell right side as a cell, and skips an unparseable constraint', () => {
        const workbook = makeWorkbook({ Sheet1: XLSX.utils.aoa_to_sheet([[1]]) });
        setSolverNames(workbook, [
            { Name: 'solver_opt', Ref: 'Sheet1!$B$1' },
            { Name: 'solver_adj', Ref: 'Sheet1!$A$1:$A$2' },
            { Name: 'solver_typ', Ref: '1' },
            { Name: 'solver_num', Ref: '3' },
            { Name: 'solver_lhs1', Ref: 'Sheet1!$A$1:$A$2' },
            { Name: 'solver_rel1', Ref: '3' },
            { Name: 'solver_rhs1', Ref: '0' },
            // Unknown relation code (9): skipped, the others still import.
            { Name: 'solver_lhs2', Ref: 'Sheet1!$C$1' },
            { Name: 'solver_rel2', Ref: '9' },
            { Name: 'solver_rhs2', Ref: '1' },
            { Name: 'solver_lhs3', Ref: 'Sheet1!$C$1' },
            { Name: 'solver_rel3', Ref: '1' },
            { Name: 'solver_rhs3', Ref: 'Sheet1!$D$1' },
        ]);
        expect(extractSolverParams(workbook)).toEqual({
            objective: 'B1',
            goal: 'max',
            targetValue: '',
            changing: 'A1:A2',
            nonNegative: true,
            method: 'grg',
            constraints: [
                { left: 'A1:A2', operator: '>=', right: '0' },
                { left: 'C1', operator: '<=', right: 'D1' },
            ],
        });
    });

    it('ignores a model saved on another sheet', () => {
        const workbook = makeWorkbook({
            Sheet1: XLSX.utils.aoa_to_sheet([[1]]),
            Sheet2: XLSX.utils.aoa_to_sheet([[2]]),
        });
        setSolverNames(workbook, [
            { Name: 'solver_opt', Ref: 'Sheet2!$B$1' },
            { Name: 'solver_adj', Ref: 'Sheet2!$A$1:$A$2' },
        ]);
        expect(extractSolverParams(workbook)).toBeNull();
    });
});
