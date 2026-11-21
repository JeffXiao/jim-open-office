/**
 * Served-build check for Open .xlsx (Playwright).
 *
 * Runs against dist-import on port 4174 — deliberately NOT the main
 * harness's port 4173, so the two can run without clashing. Build it first:
 *   npx vite build --outDir dist-import && node tests/verify-import.mjs
 *
 * Creates a test .xlsx with SheetJS, picks it in the Open picker, and
 * checks both paths: Cancel leaves the workbook untouched, Confirm replaces
 * it with the file's contents (values, a recalculated formula, and the
 * formatted cell) and the import survives a reload.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(DIR, '..');
const DIST = path.join(PROJECT, 'dist-import');
const PORT = 4174;
const BASE = '/jim-open-office/open-sheet/';
const BASE_URL = `http://localhost:${PORT}${BASE}`;
const FIXTURE = path.join(DIR, 'downloads', 'import-fixture.xlsx');

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
};

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

/** Serve dist-import under the Pages base path. */
function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
            let pathname = decodeURIComponent(url.pathname);
            if (pathname === '/favicon.svg') {
                pathname = '/jim-open-office/open-sheet/favicon.svg';
            }
            if (!pathname.startsWith(BASE)) {
                res.writeHead(404);
                res.end();
                return;
            }
            const rel = pathname.slice(BASE.length) || 'index.html';
            const file = path.join(DIST, rel);
            if (!file.startsWith(DIST)) {
                res.writeHead(403);
                res.end();
                return;
            }
            fs.readFile(file, (error, data) => {
                if (error !== null) {
                    res.writeHead(404);
                    res.end('not found');
                    return;
                }
                res.writeHead(200, {
                    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
                });
                res.end(data);
            });
        });
        server.listen(PORT, () => resolve(server));
    });
}

function buildFixture() {
    // The third row keeps A3 inside the sheet's !ref, or the writer drops it.
    const sheet = XLSX.utils.aoa_to_sheet([[2, 0.05], [3], [null]]);
    sheet['A3'] = { t: 'n', f: 'SUM(A1:A2)', v: 5 };
    sheet['B1'] = { t: 'n', v: 0.05, z: '0.00%' };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    XLSX.writeFile(workbook, FIXTURE);
}

const server = await serve();
let browser = null;
try {
    buildFixture();
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('requestfailed', (request) => {
        if (!request.url().includes('google.com')) {
            errors.push(`failed request: ${request.url()}`);
        }
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__aiOffice !== undefined, null, { timeout: 15000 });
    await page.waitForFunction(
        () => document.querySelector('#status')?.textContent?.startsWith('Ready') === true,
        null,
        { timeout: 15000 },
    );

    const inspect = async (address) =>
        page.evaluate((addr) => window.__aiOffice.inspectCell(addr), address);

    const a1Empty = await inspect('A1');
    check(
        'blank workbook opens, A1 empty',
        a1Empty === null || a1Empty.rawValue === null || a1Empty.rawValue === undefined || a1Empty.rawValue === '',
        JSON.stringify(a1Empty),
    );

    // Mark the workbook so the cancel path is provable.
    await page.evaluate(() => window.__aiOffice.setCell('A1', 99));
    check('marker cell set (A1 = 99)', (await inspect('A1'))?.rawValue === 99);

    const openButton = page.locator('[data-action="open"]');
    const openDialog = page.locator('#open-dialog');
    const fileInput = page.locator('#open-file-input');

    // Cancel path: pick the file, cancel the dialog, workbook untouched.
    await openButton.click();
    await fileInput.setInputFiles(FIXTURE);
    await openDialog.waitFor({ state: 'visible', timeout: 5000 });
    const dialogText = (await openDialog.textContent()) ?? '';
    check('confirm dialog names the picked file', dialogText.includes('import-fixture.xlsx'), dialogText.trim().slice(0, 80));
    await openDialog.locator('button[value="cancel"]').click();
    await openDialog.waitFor({ state: 'hidden', timeout: 5000 });
    check('cancel keeps the workbook', (await inspect('A1'))?.rawValue === 99);

    // Confirm path: pick again, confirm, contents land.
    await openButton.click();
    await fileInput.setInputFiles(FIXTURE);
    await openDialog.waitFor({ state: 'visible', timeout: 5000 });
    await openDialog.locator('button[value="confirm"]').click();
    await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Opened import-fixture.xlsx.',
        null,
        { timeout: 5000 },
    );
    check('status reports the opened file', true);
    check('A1 = 2 after import', (await inspect('A1'))?.rawValue === 2);
    check('A2 = 3 after import', (await inspect('A2'))?.rawValue === 3);
    // The formula engine recalculates after the workbook opens; give it a moment.
    await page
        .waitForFunction(() => window.__aiOffice.inspectCell('A3')?.rawValue === 5, null, {
            timeout: 5000,
        })
        .catch(() => {});
    const a3 = await inspect('A3');
    check('A3 formula recalculated to 5', a3?.rawValue === 5, JSON.stringify(a3));
    check('B1 = 0.05 after import', (await inspect('B1'))?.rawValue === 0.05);
    const sheets = await page.evaluate(() => window.__aiOffice.listSheets());
    check('sheet list is the imported sheet', JSON.stringify(sheets) === JSON.stringify(['Sheet1']));

    // The import persists: reload and the imported values are still there.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__aiOffice !== undefined, null, { timeout: 15000 });
    await page.waitForFunction(
        () => document.querySelector('#status')?.textContent?.startsWith('Ready') === true,
        null,
        { timeout: 15000 },
    );
    check('import survives a reload (A1 still 2)', (await inspect('A1'))?.rawValue === 2);

    check('no page errors or failed requests', errors.length === 0, errors.join('; '));
} finally {
    await browser?.close();
    server.close();
    fs.rmSync(FIXTURE, { force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
