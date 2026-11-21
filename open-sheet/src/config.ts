/**
 * App-wide constants. One frozen object; no magic numbers anywhere else.
 * See the web-development skill: "Constants: name every number".
 */

export const CONFIG = Object.freeze({
    /** Univer packages are pinned to this exact version (see package.json). */
    UNIVER_VERSION: '1.5.2',
    /** DOM id of the element the Univer editor mounts into. */
    UNIVER_CONTAINER_ID: 'univer-container',
    /** IndexedDB database / store / key for the workbook snapshot. */
    IDB_DB_NAME: 'jim-open-office',
    IDB_STORE_NAME: 'workbooks',
    IDB_WORKBOOK_KEY: 'workbook',
    /** Workbook and sheet ids (stable across save / reload). */
    WORKBOOK_ID: 'open-sheet-workbook',
    WORKBOOK_NAME: 'Untitled',
    SHEET_ID: 'sheet-1',
    SHEET_NAME: 'Sheet1',
    /** How long to wait after the last edit before autosaving, in ms. */
    AUTOSAVE_DELAY_MS: 800,
    /** Exported file name. */
    EXPORT_FILE_NAME: 'workbook.xlsx',
    /** File types the Open picker accepts. */
    OPEN_ACCEPT: '.xlsx,.xls',
    /**
     * Google sign-in (optional). Paste the OAuth 2.0 client ID here
     * (ends in .apps.googleusercontent.com; Authorized JavaScript origin
     * https://jeffxiao.github.io). Empty means sign-in is not configured
     * yet: the Sign in button stays, but explains that setup is needed.
     * The sheet works fully without signing in either way.
     */
    GOOGLE_CLIENT_ID: '',
    /** sessionStorage key for the signed-in identity (cleared on sign-out). */
    AUTH_STORAGE_KEY: 'open-sheet-auth',
    /** How long to wait for the Google sign-in script to load, in ms. */
    GIS_WAIT_TIMEOUT_MS: 5000,
    /** Poll interval while waiting for the Google sign-in script, in ms. */
    GIS_POLL_INTERVAL_MS: 100,
    /** Status messages. */
    STATUS_LOADING: 'Loading…',
    STATUS_READY: 'Ready — blank workbook.',
    STATUS_RESTORED: 'Ready — restored your saved workbook.',
    STATUS_SAVED: 'Workbook saved.',
    STATUS_EXPORTED: 'Exported workbook.xlsx.',
    STATUS_EXPORT_FAILED: 'Export failed — see the browser console.',
    STATUS_RESET: 'Workbook reset to a blank sheet.',
    STATUS_OPEN_FAILED: 'Couldn’t open that file — it may not be a valid spreadsheet file.',
    STATUS_SAVE_FAILED: 'Save failed — see the browser console.',
    STATUS_SIGN_IN_NOT_SET_UP:
        'Google sign-in isn’t set up yet — add a client ID to use it.',
    STATUS_SIGN_IN_UNAVAILABLE:
        'Google sign-in couldn’t load — check your connection, or keep working without signing in.',
    STATUS_SIGN_IN_FAILED:
        'Google sign-in didn’t work — try again or keep working without signing in.',
    STATUS_SIGNED_OUT: 'Signed out — your workbook stays on this device.',
});
