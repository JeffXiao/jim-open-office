/**
 * Served-build verification harness for the Phase 1 Univer Sheets POC.
 * Serves dist/ with `vite preview`, drives the app in headless Chromium,
 * and checks: page load with no console/page errors, the Univer sheet
 * renders, the Sharpe template computes 1.8189, a cell edit recalculates,
 * save/reload persists through IndexedDB, the reset dialog works, and the
 * .xlsx export round-trips with formulas intact.
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
const EXPECTED_SHARPE = 1.8189;
const TOLERANCE = 0.0001;

const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sampleStdev(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return { mean, stdev: Math.sqrt(variance) };
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
            page.on('console', (message) => {
                if (message.type() === 'error') consoleErrors.push(message.text());
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

            // Wait for the formula engine to calculate the Sharpe cell.
            const sharpe = await page.waitForFunction(
                () => {
                    const value = window.__aiOffice.getSharpe();
                    return typeof value === 'number' ? value : null;
                },
                null,
                { timeout: 30000 },
            ).then((handle) => handle.jsonValue());
            check(
                'Sharpe template computes 1.8189',
                Math.abs(sharpe - EXPECTED_SHARPE) < TOLERANCE,
                `observed ${sharpe}`,
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

            await page.screenshot({ path: path.join(DIR, 'verify-screenshot.png') });

            // Edit a cell and confirm the formula recalculates.
            const originalSeries = [0.0255, 0.0295, 0.0355, 0.0285, 0.0075, 0.0175,
                0.0075, 0.0105, 0.0295, 0.019, 0.0265, 0.0095];
            const editedSeries = [...originalSeries];
            editedSeries[0] = 0.05;
            const { mean, stdev } = sampleStdev(editedSeries);
            const expectedAfterEdit = (mean - 0.0025) / stdev;
            await page.evaluate(() => window.__aiOffice.setCell('B2', 0.05));
            const sharpeAfterEdit = await page.waitForFunction(
                (expected) => {
                    const value = window.__aiOffice.getSharpe();
                    return typeof value === 'number' && Math.abs(value - expected) < 0.0001
                        ? value
                        : null;
                },
                expectedAfterEdit,
                { timeout: 15000 },
            ).then((handle) => handle.jsonValue());
            check(
                'cell edit recalculates the Sharpe ratio',
                Math.abs(sharpeAfterEdit - expectedAfterEdit) < TOLERANCE,
                `observed ${sharpeAfterEdit}, expected ${expectedAfterEdit.toFixed(4)}`,
            );

            // Autosave (~800 ms) then reload: the edit must persist.
            await delay(2000);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => window.__aiOffice !== undefined, null, {
                timeout: 30000,
            });
            const sharpeAfterReload = await page.waitForFunction(
                () => {
                    const value = window.__aiOffice.getSharpe();
                    return typeof value === 'number' ? value : null;
                },
                null,
                { timeout: 30000 },
            ).then((handle) => handle.jsonValue());
            check(
                'save/reload persists the edit (IndexedDB)',
                Math.abs(sharpeAfterReload - expectedAfterEdit) < TOLERANCE,
                `observed ${sharpeAfterReload} after reload`,
            );

            // Export .xlsx and read it back with SheetJS.
            const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
            await page.locator('[data-action="export"]').click();
            const download = await downloadPromise;
            const downloadPath = path.join(DIR, 'downloads', 'sharpe-template.xlsx');
            fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
            await download.saveAs(downloadPath);
            const exported = XLSX.read(fs.readFileSync(downloadPath), { type: 'buffer' });
            const sheet = exported.Sheets['Sharpe Ratio'];
            const b18 = sheet['B18'];
            check(
                'export downloads an .xlsx with the Sharpe sheet',
                sheet !== undefined && b18 !== undefined,
                `B18 in export: ${JSON.stringify(b18)}`,
            );
            check(
                'exported Sharpe cell keeps its formula and value',
                typeof b18?.f === 'string' && Math.abs((b18?.v ?? NaN) - expectedAfterEdit) < TOLERANCE,
                `formula: ${b18?.f ?? 'none'}, value: ${b18?.v ?? 'none'}`,
            );
            const b2 = sheet['B2'];
            check(
                'exported B2 carries the edited value',
                Math.abs((b2?.v ?? NaN) - 0.05) < 1e-9,
                `B2: ${JSON.stringify(b2)}`,
            );

            // Reset dialog: open, cancel keeps the edit; open, confirm restores 1.8189.
            await page.locator('[data-action="reset"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'visible', timeout: 5000 });
            check('reset dialog opens (native <dialog>)', true);
            await page.locator('#reset-dialog button[value="cancel"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'hidden', timeout: 5000 });
            const sharpeAfterCancel = await page.evaluate(() => window.__aiOffice.getSharpe());
            check(
                'cancelling reset keeps the edited workbook',
                Math.abs(sharpeAfterCancel - expectedAfterEdit) < TOLERANCE,
                `observed ${sharpeAfterCancel}`,
            );
            await page.locator('[data-action="reset"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'visible', timeout: 5000 });
            await page.locator('#reset-dialog button[value="confirm"]').click();
            await page.locator('#reset-dialog').waitFor({ state: 'hidden', timeout: 5000 });
            const sharpeAfterReset = await page.waitForFunction(
                (expected) => {
                    const value = window.__aiOffice.getSharpe();
                    return typeof value === 'number' && Math.abs(value - expected) < 0.0001
                        ? value
                        : null;
                },
                EXPECTED_SHARPE,
                { timeout: 15000 },
            ).then((handle) => handle.jsonValue());
            check(
                'confirming reset restores the template (Sharpe 1.8189)',
                Math.abs(sharpeAfterReset - EXPECTED_SHARPE) < TOLERANCE,
                `observed ${sharpeAfterReset}`,
            );

            check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
            check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
            check('no failed requests', failedRequests.length === 0, failedRequests.join(' | '));
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
