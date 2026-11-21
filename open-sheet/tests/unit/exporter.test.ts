/**
 * Unit tests for the .xlsx exporter (src/exporter.ts).
 * Only the pure conversion (snapshotToXlsxWorkbook) is tested here: it takes
 * a Univer snapshot and returns a SheetJS workbook, with no browser involved.
 * The download half (exportSnapshotToXlsx, XLSX.writeFile) is covered by the
 * Playwright harness, which clicks Export in a real browser.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { snapshotToXlsxWorkbook } from '../../src/exporter';
import { buildBlankWorkbookSnapshot } from '../../src/blank-workbook';

type Snapshot = Parameters<typeof snapshotToXlsxWorkbook>[0];

type CellInput = {
    v?: number | string | boolean | null;
    f?: string;
    s?: string | Record<string, unknown>;
};

type SheetInput = {
    name: string;
    cells?: Record<string, CellInput>;
    columnData?: Record<string, { w?: number }>;
};

/** Build a snapshot from A1-addressed cells, without touching Univer. */
function makeSnapshot(input: {
    sheets?: Record<string, SheetInput>;
    styles?: Record<string, unknown>;
} = {}): Snapshot {
    const sheetsInput = input.sheets ?? { 'sheet-1': { name: 'Sheet1', cells: {} } };
    const sheets: Record<string, unknown> = {};
    for (const [id, sheet] of Object.entries(sheetsInput)) {
        const cellData: Record<number, Record<number, CellInput>> = {};
        for (const [address, cell] of Object.entries(sheet.cells ?? {})) {
            const { r, c } = XLSX.utils.decode_cell(address);
            (cellData[r] ??= {})[c] = cell;
        }
        sheets[id] = {
            id,
            name: sheet.name,
            cellData,
            rowCount: 100,
            columnCount: 26,
            ...(sheet.columnData !== undefined ? { columnData: sheet.columnData } : {}),
        };
    }
    return {
        id: 'test-workbook',
        name: 'Test',
        appVersion: '1.5.2',
        locale: buildBlankWorkbookSnapshot().locale,
        styles: input.styles ?? {},
        sheetOrder: Object.keys(sheetsInput),
        sheets,
    } as unknown as Snapshot;
}

describe('snapshotToXlsxWorkbook', () => {
    it('exports the blank workbook as one empty Sheet1 with no used range', () => {
        const workbook = snapshotToXlsxWorkbook(buildBlankWorkbookSnapshot());
        expect(workbook.SheetNames).toEqual(['Sheet1']);
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet).toBeDefined();
        expect(sheet?.['!ref']).toBeUndefined();
        expect(Object.keys(sheet ?? {}).filter((key) => !key.startsWith('!'))).toEqual([]);
    });

    it('exports the blank workbook with no Sharpe content — removal regression', () => {
        const workbook = snapshotToXlsxWorkbook(buildBlankWorkbookSnapshot());
        expect(JSON.stringify(workbook).toLowerCase()).not.toContain('sharpe');
    });

    it('keeps numbers, strings, and booleans with their types', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: {
                            A1: { v: 42 },
                            A2: { v: 'hello' },
                            A3: { v: true },
                            A4: { v: 3.5 },
                        },
                    },
                },
            }),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['A1']).toMatchObject({ t: 'n', v: 42 });
        expect(sheet?.['A2']).toMatchObject({ t: 's', v: 'hello' });
        expect(sheet?.['A3']).toMatchObject({ t: 'b', v: true });
        expect(sheet?.['A4']).toMatchObject({ t: 'n', v: 3.5 });
    });

    it('keeps a formula (with the leading = stripped) and its cached value', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: {
                            A1: { v: 2 },
                            A2: { v: 3 },
                            A3: { v: 5, f: '=SUM(A1:A2)' },
                        },
                    },
                },
            }),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['A3']).toMatchObject({ t: 'n', f: 'SUM(A1:A2)', v: 5 });
    });

    it('keeps a formula even when no cached value was computed yet', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: { A1: { f: '=SUM(B1:B2)' } },
                    },
                },
            }),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['A1']?.f).toBe('SUM(B1:B2)');
    });

    it('ignores an empty formula string and falls back to the value', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: { A1: { v: 7, f: '' } },
                    },
                },
            }),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['A1']).toMatchObject({ t: 'n', v: 7 });
        expect(sheet?.['A1']?.f).toBeUndefined();
    });

    it('skips cells with no usable value', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: { A1: { v: null }, A2: { v: 1 } },
                    },
                },
            }),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['A1']).toBeUndefined();
        expect(sheet?.['A2']).toMatchObject({ t: 'n', v: 1 });
    });

    it('applies a number-format pattern from the style map', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot(
                {
                    sheets: {
                        'sheet-1': {
                            name: 'Sheet1',
                            cells: {
                                A1: { v: 0.05, s: 'fmt-1' },
                                A2: { v: 0.05, s: { n: { pattern: '0.00%' } } },
                            },
                        },
                    },
                    styles: { 'fmt-1': { n: { pattern: '0.00%' } } },
                },
            ),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['A1']?.z).toBe('0.00%');
        // A style given as an object instead of an id resolves to nothing.
        expect(sheet?.['A2']?.z).toBeUndefined();
    });

    it('carries column widths across as pixel widths', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: { A1: { v: 1 } },
                        columnData: { '0': { w: 120 }, '2': { w: 80 } },
                    },
                },
            }),
        );
        const sheet = workbook.Sheets['Sheet1'];
        expect(sheet?.['!cols']?.[0]).toMatchObject({ wpx: 120 });
        expect(sheet?.['!cols']?.[2]).toMatchObject({ wpx: 80 });
    });

    it('computes the used range from the furthest cell', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': {
                        name: 'Sheet1',
                        cells: { A1: { v: 1 }, C3: { v: 2 } },
                    },
                },
            }),
        );
        expect(workbook.Sheets['Sheet1']?.['!ref']).toBe('A1:C3');
    });

    it('exports every sheet in sheet order, and skips ids with no sheet', () => {
        const workbook = snapshotToXlsxWorkbook(
            makeSnapshot({
                sheets: {
                    'sheet-1': { name: 'First', cells: { A1: { v: 1 } } },
                    'sheet-2': { name: 'Second', cells: { B2: { v: 2 } } },
                },
            }),
        );
        // A sheet id listed in sheetOrder but missing from sheets is skipped.
        const snapshot = makeSnapshot({
            sheets: { 'sheet-1': { name: 'Only', cells: {} } },
        });
        snapshot.sheetOrder.push('sheet-missing');
        const partial = snapshotToXlsxWorkbook(snapshot);
        expect(workbook.SheetNames).toEqual(['First', 'Second']);
        expect(workbook.Sheets['Second']?.['B2']).toMatchObject({ t: 'n', v: 2 });
        expect(partial.SheetNames).toEqual(['Only']);
    });
});
