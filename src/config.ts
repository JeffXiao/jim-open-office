/**
 * App-wide constants. One frozen object; no magic numbers anywhere else.
 * See the web-development skill: "Constants: name every number".
 */

/** Monthly returns of the Sharpe worked example, as decimal fractions (2.55% = 0.0255). */
const SHARPE_MONTHLY_RETURNS: readonly number[] = Object.freeze([
    0.0255, 0.0295, 0.0355, 0.0285, 0.0075, 0.0175,
    0.0075, 0.0105, 0.0295, 0.019, 0.0265, 0.0095,
]);

export const CONFIG = Object.freeze({
    /** Univer packages are pinned to this exact version (see package.json). */
    UNIVER_VERSION: '1.5.2',
    /** DOM id of the element the Univer editor mounts into. */
    UNIVER_CONTAINER_ID: 'univer-container',
    /** IndexedDB database / store / key for the workbook snapshot. */
    IDB_DB_NAME: 'jim-open-office',
    IDB_STORE_NAME: 'workbooks',
    IDB_WORKBOOK_KEY: 'sharpe-template',
    /** Workbook and sheet ids (stable across save / reload). */
    WORKBOOK_ID: 'sharpe-template',
    WORKBOOK_NAME: 'Sharpe Template',
    SHEET_ID: 'sharpe-sheet',
    SHEET_NAME: 'Sharpe Ratio',
    NOTES_SHEET_ID: 'notes-sheet',
    NOTES_SHEET_NAME: 'Notes',
    /** The Sharpe worked example. */
    SHARPE_MONTHLY_RETURNS,
    SHARPE_MONTH_LABELS: Object.freeze([
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ]),
    /** Monthly risk-free rate, as a decimal fraction (0.25%). */
    SHARPE_RISK_FREE_RATE: 0.0025,
    /** Expected Sharpe ratio of the worked example (GridBook's one-click template: 1.8189). */
    SHARPE_EXPECTED: 1.8189,
    /** How long to wait after the last edit before autosaving, in ms. */
    AUTOSAVE_DELAY_MS: 800,
    /** Exported file name. */
    EXPORT_FILE_NAME: 'sharpe-template.xlsx',
    /** Status messages. */
    STATUS_LOADING: 'Loading the Sharpe template…',
    STATUS_READY: 'Ready — Sharpe template loaded.',
    STATUS_RESTORED: 'Ready — restored your saved workbook.',
    STATUS_SAVED: 'Workbook saved.',
    STATUS_EXPORTED: 'Exported sharpe-template.xlsx.',
    STATUS_EXPORT_FAILED: 'Export failed — see the browser console.',
    STATUS_RESET: 'Workbook reset to the Sharpe template.',
    STATUS_SAVE_FAILED: 'Save failed — see the browser console.',
});
