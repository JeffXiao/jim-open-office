/**
 * Served-build verification harness for Open Sheet.
 * Serves dist/ with `vite preview`, drives the app in headless Chromium,
 * and checks: page load with no console/page errors, the Univer sheet
 * renders, the workbook opens blank (one empty "Sheet1"), a cell edit and a
 * formula recalculate, save/reload persists through IndexedDB, the reset
 * dialog works, and the .xlsx export round-trips with formulas intact.
 *
 * Run: node tests/verify.mjs
 * Exit code 0 = all checks passed.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(DIR, '..');
const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}/`;

const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer() {
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const response = await fetch(BASE_URL);
            if (response.ok) return;
        } catch {
            // Not up yet.
        }
        await delay(500);
    }
    throw new Error('vite preview did not start in time');
}

async function cellRawValue(page, address) {
    return page.evaluate((addr) => {
        const cell = window.__aiOffice.inspectCell(addr);
        return cell === null ? undefined : cell.rawValue;
    }, address);
}

async function main() {
    const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
        cwd: PROJECT,
        stdio: 'ignore',
    });
    try {
        await waitForServer();

        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
            const consoleErrors = [];
            const pageErrors = [];
            const failedRequests = [];
            // Google's sign-in script is external and optional: the app is
            // built to work fine when it fails to load (the fallback Sign in
            // button covers it), and this sandbox's test browser cannot reach
            // accounts.google.com at all. Filter its load failures out of the
            // error checks; every other error still fails the run.
            const TOLERATED_URL_PART = 'accounts.google.com/gsi/client';
            page.on('console', (message) => {
                if (message.type() === 'error') {
                    consoleErrors.push(`${message.location()?.url ?? ''} ${message.text()}`);
                }
            });
            page.on('pageerror', (error) => pageErrors.push(String(error)));
            page.on('requestfailed', (request) => {
                failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? '?'})`);
            });

            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

            // The app exposes a debug handle for the harness.
            await page.waitForFunction(() => window.__aiOffice !== undefined, null, {
                timeout: 30000,
            });
            check('app boots (window.__aiOffice present)', true);

            // The workbook opens blank: one sheet, "Sheet1", no content.
            const sheets = await page.evaluate(() => window.__aiOffice.listSheets());
            check(
                'workbook opens blank with one sheet named Sheet1',
                Array.isArray(sheets) && sheets.length === 1 && sheets[0] === 'Sheet1',
                `sheets: ${JSON.stringify(sheets)}`,
            );
            const a1Empty = await cellRawValue(page, 'A1');
            check(
                'blank workbook has no content (A1 empty)',
                a1Empty === undefined || a1Empty === null || a1Empty === '',
                `A1: ${JSON.stringify(a1Empty)}`,
            );

            // The Univer sheet UI is on screen (Univer renders the grid on canvas).
            const canvasCount = await page.locator('#univer-container canvas').count();
            const containerChildren = await page.locator('#univer-container > *').count();
            check(
                'Univer sheet renders in the page',
                canvasCount > 0 && containerChildren > 0,
                `canvases: ${canvasCount}, container children: ${containerChildren}`,
            );
            const statusText = await page.locator('#status').innerText();
            check('status line reports ready', /Ready/.test(statusText), statusText);

            // Optional sign-in: the button is there, nobody is signed in,
            // and the sheet works the same without signing in.
            const signinVisible = await page.locator('#signin-button').isVisible();
            check('Sign in button is visible while signed out', signinVisible);
            const signoutHidden = await page.locator('#signout-button').isHidden();
            check('Sign out button is hidden while signed out', signoutHidden);
            const signedInLabelHidden = await page.locator('#signed-in-user').isHidden();
            check('signed-in label is hidden while signed out', signedInLabelHidden);
            const configured = await page.evaluate(() => window.__aiOffice.isSignInConfigured());
            check(
                'sign-in is not configured yet (no client ID)',
                configured === false,
                `configured: ${configured}`,
            );
            const signedInUser = await page.evaluate(() => window.__aiOffice.getSignedInUser());
            check(
                'nobody is signed in on a fresh load',
                signedInUser === null,
                `user: ${JSON.stringify(signedInUser)}`,
            );
            // Clicking Sign in with no client ID explains setup is needed.
            await page.locator('#signin-button').click();
            const statusAfterSignin = await page.locator('#status').innerText();
            check(
                'Sign in without a client ID explains setup is needed',
                /isn.t set up yet/.test(statusAfterSignin),
                statusAfterSignin,
            );

            // The toolbar is Open / Export .xlsx / Reset / Solver /
            // Sign in: autosave already saves, so there is no Save button.
            const toolbarActions = await page
                .locator('#app-toolbar button[data-action]')
                .evaluateAll((buttons) =>
                    buttons.map((button) => button.getAttribute('data-action')),
                );
            check(
                'toolbar has Open, Export, Reset, Solver, Sign in — and no Save button',
                JSON.stringify(toolbarActions) ===
                    JSON.stringify(['open', 'export', 'reset', 'solver', 'signin', 'signout']),
                toolbarActions.join(', '),
            );

            await page.screenshot({ path: path.join(DIR, 'verify-screenshot.png') });

            // Edit cells and confirm a formula recalculates.
            await page.evaluate(() => {
                window.__aiOffice.setCell('A1', 2);
                window.__aiOffice.setCell('A2', 3);
                window.__aiOffice.setCell('A3', '=SUM(A1:A2)');
            });
            const a3 = await page.waitForFunction(
                () => {
                    const cell = window.__aiOffice.inspectCell('A3');
                    return cell !== null && cell.rawValue === 5 ? cell.rawValue : null;
                },
                null,
                { timeout: 15000 },
            ).then((handle) => handle.jsonValue());
            check(
                'formula recalculates (A3 = SUM(A1:A2) = 5)',
                a3 === 5,
                `observed A3: ${JSON.stringify(a3)}`,
            );

            // Autosave (~800 ms) then reload: the edit must persist.
            await delay(2000);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.__aiOffice !== undefined, null, {
                timeout: 30000,
            });
            const a1AfterReload = await cellRawValue(page, 'A1');
            const a3AfterReload = await cellRawValue(page, 'A3');
            check(
                'save/reload persists the edit (IndexedDB)',
                a1AfterReload === 2 && a3AfterReload === 5,
                `A1: ${JSON.stringify(a1AfterReload)}, A3: ${JSON.stringify(a3AfterReload)}`,
            );

            // Export .xlsx and read it back with SheetJS.
            const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
            await page.locator('[data-action="export"]').click();
            const download = await downloadPromise;
            const downloadPath = path.join(DIR, 'downloads', 'workbook.xlsx');
            fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
            await download.saveAs(downloadPath);
            const exported = XLSX.read(fs.readFileSync(downloadPath), { type: 'buffer' });
            const sheet = exported.Sheets['Sheet1'];
            const a3Exported = sheet?.['A3'];
            check(
                'export downloads an .xlsx with the Sheet1 sheet',
                sheet !== undefined && a3Exported !== undefined,
                `A3 in export: ${JSON.stringify(a3Exported)}`,
            );
            check(
                'exported A3 keeps its formula and value',
                typeof a3Exported?.f === 'string' && a3Exported?.v === 5,
                `formula: ${a3Exported?.f ?? 'none'}, value: ${a3Exported?.v ?? 'none'}`,
            );
            const a1Exported = sheet?.['A1'];
            check(
                'exported A1 carries the edited value',
                a1Exported?.v === 2,
                `A1: ${JSON.stringify(a1Exported)}`,
            );

            // Reset dialog: open, cancel keeps the edit; open, confirm clears to blank.
            await page.locator('[data-action="reset"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'visible', timeout: 5000 });
            check('reset dialog opens (native <dialog>)', true);
            await page.locator('#reset-dialog button[value="cancel"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'hidden', timeout: 5000 });
            const a1AfterCancel = await cellRawValue(page, 'A1');
            check(
                'cancelling reset keeps the edited workbook',
                a1AfterCancel === 2,
                `observed A1: ${JSON.stringify(a1AfterCancel)}`,
            );
            await page.locator('[data-action="reset"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'visible', timeout: 5000 });
            await page.locator('#reset-dialog button[value="confirm"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'hidden', timeout: 5000 });
            const a1AfterReset = await page.waitForFunction(
                () => {
                    const cell = window.__aiOffice.inspectCell('A1');
                    const raw = cell === null ? undefined : cell.rawValue;
                    return raw === undefined || raw === null || raw === '' ? 'empty' : null;
                },
                null,
                { timeout: 15000 },
            ).then((handle) => handle.jsonValue());
            check(
                'confirming reset restores a blank workbook',
                a1AfterReset === 'empty',
                `observed A1: ${JSON.stringify(a1AfterReset)}`,
            );

            check(
                'no console errors (other than the tolerated Google script load)',
                consoleErrors.filter((error) => !error.includes(TOLERATED_URL_PART)).length === 0,
                consoleErrors.join(' | '),
            );
            check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
            check(
                'no failed requests (other than the tolerated Google script load)',
                failedRequests.filter((request) => !request.includes(TOLERATED_URL_PART))
                    .length === 0,
                failedRequests.join(' | '),
            );
        } finally {
            await browser.close();
        }
    } finally {
        server.kill('SIGTERM');
    }

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('Harness failed:', error);
    process.exit(1);
});
