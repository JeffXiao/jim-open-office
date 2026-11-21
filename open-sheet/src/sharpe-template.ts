/**
 * The Sharpe Ratio worked example, built as a native Univer workbook snapshot
 * (IWorkbookData). No Univer code runs here — this is pure data construction,
 * so the template can be unit-checked without a browser.
 *
 * Assumption (see the Phase 1 plan): the plan does not specify the template's
 * exact cells, and GridBook's one-click template is a Muse artifact whose
 * source is not readable from here. So this is the standard worked example:
 * a 12-month returns column, mean, sample standard deviation, risk-free rate,
 * and a formula-driven Sharpe cell. The monthly returns were chosen so the
 * computed Sharpe ratio reproduces GridBook's worked-example value, 1.8189
 * (mean 2.0542%, sample stdev 0.9919%, risk-free rate 0.25% per month).
 */
import type { IWorkbookData } from '@univerjs/core';
import { LocaleType } from '@univerjs/core';
import { CONFIG } from './config';

const STYLE_HEADER = 'header';
const STYLE_PERCENT = 'pct';
const STYLE_SHARPE = 'sharpe';
const STYLE_NOTE = 'note';

/** First data row (0-based) of the returns column; the header is row 0. */
const FIRST_RETURN_ROW = 1;
/** Last data row (0-based) of the returns column: 12 months. */
const LAST_RETURN_ROW = 12;
/** Row (0-based) of the summary block's first line. */
const SUMMARY_FIRST_ROW = 14;

/** Build the cell-data map for the "Sharpe Ratio" sheet. */
function buildSharpeCells(): IWorkbookData['sheets'][string]['cellData'] {
    const cells: Record<number, Record<number, { v?: number | string; f?: string; s?: string }>> = {};

    const setCell = (row: number, col: number, cell: { v?: number | string; f?: string; s?: string }): void => {
        if (cells[row] === undefined) {
            cells[row] = {};
        }
        cells[row][col] = cell;
    };

    setCell(0, 0, { v: 'Month', s: STYLE_HEADER });
    setCell(0, 1, { v: 'Monthly return', s: STYLE_HEADER });

    CONFIG.SHARPE_MONTHLY_RETURNS.forEach((monthlyReturn, index) => {
        const row = FIRST_RETURN_ROW + index;
        setCell(row, 0, { v: CONFIG.SHARPE_MONTH_LABELS[index] });
        setCell(row, 1, { v: monthlyReturn, s: STYLE_PERCENT });
    });

    const returnRange = `B${FIRST_RETURN_ROW + 1}:B${LAST_RETURN_ROW + 1}`;
    const meanCell = `B${SUMMARY_FIRST_ROW + 1}`;
    const stdevCell = `B${SUMMARY_FIRST_ROW + 2}`;
    const riskFreeCell = `B${SUMMARY_FIRST_ROW + 3}`;

    setCell(SUMMARY_FIRST_ROW, 0, { v: 'Mean monthly return' });
    setCell(SUMMARY_FIRST_ROW, 1, { f: `=AVERAGE(${returnRange})`, s: STYLE_PERCENT });
    setCell(SUMMARY_FIRST_ROW + 1, 0, { v: 'Standard deviation (sample)' });
    setCell(SUMMARY_FIRST_ROW + 1, 1, { f: `=STDEV(${returnRange})`, s: STYLE_PERCENT });
    setCell(SUMMARY_FIRST_ROW + 2, 0, { v: 'Risk-free rate (monthly)' });
    setCell(SUMMARY_FIRST_ROW + 2, 1, { v: CONFIG.SHARPE_RISK_FREE_RATE, s: STYLE_PERCENT });
    setCell(SUMMARY_FIRST_ROW + 3, 0, { v: 'Sharpe ratio', s: STYLE_SHARPE });
    setCell(SUMMARY_FIRST_ROW + 3, 1, {
        f: `=(${meanCell}-${riskFreeCell})/${stdevCell}`,
        s: STYLE_SHARPE,
    });

    setCell(SUMMARY_FIRST_ROW + 5, 0, {
        v: 'Sharpe = (Mean return − Risk-free rate) / Standard deviation (sample, STDEV).',
        s: STYLE_NOTE,
    });

    return cells;
}

/** Build the cell-data map for the "Notes" sheet. */
function buildNotesCells(): IWorkbookData['sheets'][string]['cellData'] {
    return {
        0: { 0: { v: 'Sharpe Ratio template — worked example', s: STYLE_HEADER } },
        1: {
            0: {
                v: 'Monthly returns are in column B (rows 2–13) of the "Sharpe Ratio" sheet. The summary in rows 15–18 is formula-driven.',
            },
        },
        2: {
            0: {
                v: 'Edit any return and the mean, standard deviation, and Sharpe ratio recalculate.',
            },
        },
        3: {
            0: {
                v: 'This example reproduces GridBook\u2019s one-click Sharpe template value (1.8189). The monthly returns are a constructed series chosen to match it.',
                s: STYLE_NOTE,
            },
        },
    };
}

/** The full workbook snapshot for a fresh Sharpe template. */
export function buildSharpeTemplateSnapshot(): IWorkbookData {
    return {
        id: CONFIG.WORKBOOK_ID,
        name: CONFIG.WORKBOOK_NAME,
        appVersion: CONFIG.UNIVER_VERSION,
        locale: LocaleType.EN_US,
        styles: {
            [STYLE_HEADER]: { bl: 1, fs: 12 },
            [STYLE_PERCENT]: { n: { pattern: '0.00%' } },
            [STYLE_SHARPE]: { n: { pattern: '0.0000' }, bl: 1 },
            [STYLE_NOTE]: { it: 1, fs: 11 },
        },
        sheetOrder: [CONFIG.SHEET_ID, CONFIG.NOTES_SHEET_ID],
        sheets: {
            [CONFIG.SHEET_ID]: {
                id: CONFIG.SHEET_ID,
                name: CONFIG.SHEET_NAME,
                cellData: buildSharpeCells(),
                rowCount: 100,
                columnCount: 26,
                columnData: {
                    0: { w: 220 },
                    1: { w: 170 },
                },
            },
            [CONFIG.NOTES_SHEET_ID]: {
                id: CONFIG.NOTES_SHEET_ID,
                name: CONFIG.NOTES_SHEET_NAME,
                cellData: buildNotesCells(),
                rowCount: 100,
                columnCount: 26,
                columnData: {
                    0: { w: 640 },
                },
            },
        },
    };
}

/** A1 address of the Sharpe ratio result cell (used by the app and the test hook). */
export const SHARPE_RESULT_ADDRESS = `B${SUMMARY_FIRST_ROW + 4}`;
