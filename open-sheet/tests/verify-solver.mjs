/**
 * Served-build check for the Solver (Playwright).
 *
 * Runs against dist-solver on port 4175 — deliberately NOT the main
 * harness's port 4173 or the import harness's 4174, so the harnesses can
 * run without clashing. Build it first:
 *   npx vite build --outDir dist-solver && node tests/verify-solver.mjs
 * The dist-solver build is deleted at the end of the run.
 *
 * Problem 1: minimize x^2+y^2 subject to x+y>=1 — known optimum
 * (0.5, 0.5), objective 0.5. Problem 2: the 19-variable ratio problem
 * (identical assets, weights >= 0, sum <= 1, each <= 0.2) — known optimum
 * equal weights 1/19, objective 0.3*sqrt(19) = 1.3077. Also checks that
 * the dialog is modeless (the sheet is clickable and editable while it
 * is open, before solving and on the results view; its inputs are
 * enabled when it reopens after a solve), that Keep leaves the solution
 * in the cells, that Restore reverts to the originals, that Esc after a
 * solve keeps the solution, that Cancel restores the original values,
 * that the dialog reopens prefilled with the last-used parameters, that
 * invalid input shows an error, and that opening a file with a saved
 * Solver model prefills the dialog from it.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(DIR, '..');
const DIST = path.join(PROJECT, 'dist-solver');
const PORT = 4175;
const BASE = '/jim-open-office/open-sheet/';
const BASE_URL = `http://localhost:${PORT}${BASE}`;

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

/** Serve dist-solver under the Pages base path. */
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

const server = await serve();
let browser = null;
/** Synthetic .xlsx with a saved Solver model, written for the import check. */
const fixturePath = path.join(DIR, 'solver-model-fixture.xlsx');
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
    const setCell = async (address, value) =>
        page.evaluate(([addr, val]) => window.__aiOffice.setCell(addr, val), [address, value]);
    const solverDialog = page.locator('#solver-dialog');
    const resultsList = page.locator('#solver-results-list');

    /** Fill the dialog's objective / goal / changing inputs. */
    async function fillSolverForm({ objective, goal, changing }) {
        await page.locator('#solver-objective').fill(objective);
        await page.locator(`input[name="solver-goal"][value="${goal}"]`).check();
        await page.locator('#solver-changing').fill(changing);
    }

    /** Add one constraint row through the dialog's edit row. */
    async function addConstraint(left, operator, right) {
        await page.locator('#solver-constraint-left').fill(left);
        await page.locator('#solver-constraint-operator').selectOption(operator);
        await page.locator('#solver-constraint-right').fill(right);
        await page.locator('#solver-add-constraint').click();
    }

    /** Wait for the results view, then return its text. */
    async function waitForResults(timeout) {
        await page.locator('#solver-results').waitFor({ state: 'visible', timeout });
        return (await resultsList.textContent()) ?? '';
    }

    /**
     * Edit a cell by keyboard while the (modeless) dialog is open: click
     * A1, which sits left of the centred dialog, arrow right to the
     * target column, type the value, Enter to commit.
     */
    async function editCellByKeyboard(columnSteps, value, address, expected) {
        await page.mouse.click(77, 177);
        for (let i = 0; i < columnSteps; i++) {
            await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.type(value);
        await page.keyboard.press('Enter');
        await page.waitForFunction(
            ([addr, want]) => window.__aiOffice.inspectCell(addr)?.rawValue === want,
            [address, expected],
            { timeout: 5000 },
        );
    }

    // ---- Problem 1: min x^2+y^2 s.t. x+y>=1, optimum (0.5, 0.5), 0.5. ----
    await setCell('A1', 0);
    await setCell('A2', 0);
    await setCell('B1', '=A1^2+A2^2');
    await setCell('C1', '=A1+A2');
    // Formulas recalculate asynchronously: wait for the values to land
    // before asserting (an immediate read still shows the previous value).
    await page.waitForFunction(
        () => window.__aiOffice.inspectCell('B1')?.rawValue === 0,
        null,
        { timeout: 5000 },
    );
    await page.waitForFunction(
        () => window.__aiOffice.inspectCell('C1')?.rawValue === 0,
        null,
        { timeout: 5000 },
    );
    check('problem 1 objective formula computes (B1 = 0)', (await inspect('B1'))?.rawValue === 0);
    check('problem 1 constraint side computes (C1 = 0)', (await inspect('C1'))?.rawValue === 0);

    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    check('Solver dialog opens', true);

    // (a) Modeless: the sheet is clickable and editable with the dialog open.
    await editCellByKeyboard(3, '42', 'D1', 42);
    check('sheet editable while the Solver dialog is open (D1 = 42)', true);
    check('Solver dialog stays open after editing the sheet', await solverDialog.isVisible());

    await fillSolverForm({ objective: 'B1', goal: 'min', changing: 'A1:A2' });
    await addConstraint('C1', '>=', '1');
    const constraintsText = (await page.locator('#solver-constraints').textContent()) ?? '';
    check('constraint added to the list', constraintsText.includes('C1 >= 1'), constraintsText.trim());

    await page.locator('#solver-solve').click();
    const results1 = await waitForResults(60000);
    check('problem 1 reports an optimal solution', results1.includes('Optimal'), results1.slice(0, 120));
    const a1 = (await inspect('A1'))?.rawValue;
    const a2 = (await inspect('A2'))?.rawValue;
    const b1 = (await inspect('B1'))?.rawValue;
    check('problem 1: A1 = 0.5', typeof a1 === 'number' && Math.abs(a1 - 0.5) < 5e-3, `A1 = ${a1}`);
    check('problem 1: A2 = 0.5', typeof a2 === 'number' && Math.abs(a2 - 0.5) < 5e-3, `A2 = ${a2}`);
    check('problem 1: B1 = 0.5', typeof b1 === 'number' && Math.abs(b1 - 0.5) < 1e-3, `B1 = ${b1}`);
    check('problem 1 results show the objective before/after', results1.includes('0.5'));

    // (b) Modeless: the results view is showing AND the sheet is still editable.
    await editCellByKeyboard(3, '99', 'D1', 99);
    check('sheet editable while the results view is open (D1 = 99)', true);
    check('results view still showing after editing the sheet', await page.locator('#solver-results').isVisible());

    await page.locator('#solver-keep').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });
    const a1Kept = (await inspect('A1'))?.rawValue;
    const a2Kept = (await inspect('A2'))?.rawValue;
    check(
        'Keep Solution leaves the solution in the cells (A1 = A2 = 0.5)',
        typeof a1Kept === 'number' &&
            Math.abs(a1Kept - 0.5) < 5e-3 &&
            typeof a2Kept === 'number' &&
            Math.abs(a2Kept - 0.5) < 5e-3,
        `A1 = ${a1Kept}, A2 = ${a2Kept}`,
    );

    // ---- The dialog reopens prefilled with the last-used parameters. ----
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    check(
        'dialog reopens prefilled (objective, changing, constraint)',
        (await page.locator('#solver-objective').inputValue()) === 'B1' &&
            (await page.locator('#solver-changing').inputValue()) === 'A1:A2' &&
            ((await page.locator('#solver-constraints').textContent()) ?? '').includes('C1 >= 1'),
    );
    // (c) Reopening after a solve shows enabled inputs (the solving state
    // is cleared when the run finishes).
    check(
        'dialog inputs enabled on reopen after a solve',
        (await page.locator('#solver-objective').isDisabled()) === false &&
            (await page.locator('#solver-solve').isDisabled()) === false,
    );
    await page.locator('#solver-close').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });

    // ---- Problem 2: 19-variable ratio, optimum 1/19 each, 1.3077. ----
    for (let row = 1; row <= 19; row++) {
        await setCell(`A${row}`, 0.05);
    }
    await setCell('B1', '=(0.08*SUM(A1:A19)-0.02)/(0.2*SQRT(SUMPRODUCT(A1:A19,A1:A19)))');
    await setCell('C1', '=SUM(A1:A19)');
    await page.waitForFunction(
        () =>
            typeof window.__aiOffice.inspectCell('B1')?.rawValue === 'number' &&
            Math.abs(window.__aiOffice.inspectCell('B1').rawValue - 1.28472) < 1e-3,
        null,
        { timeout: 5000 },
    );
    await page.waitForFunction(
        () => {
            const value = window.__aiOffice.inspectCell('C1')?.rawValue;
            return typeof value === 'number' && Math.abs(value - 0.95) < 1e-9;
        },
        null,
        { timeout: 5000 },
    );
    const b1Start = (await inspect('B1'))?.rawValue;
    check(
        'problem 2 objective formula computes (B1 = 1.2847 at equal 0.05 starts)',
        typeof b1Start === 'number' && Math.abs(b1Start - 1.28472) < 1e-3,
        `B1 = ${b1Start}`,
    );
    const c1Start = (await inspect('C1'))?.rawValue;
    check(
        'problem 2 sum cell computes (C1 = 0.95)',
        typeof c1Start === 'number' && Math.abs(c1Start - 0.95) < 1e-9,
        `C1 = ${c1Start}`,
    );

    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await fillSolverForm({ objective: 'B1', goal: 'max', changing: 'A1:A19' });
    // Replace the problem-1 constraint with problem 2's three constraints.
    await page.locator('#solver-constraints li').first().click();
    await page.locator('#solver-delete-constraint').click();
    await addConstraint('A1:A19', '>=', '0');
    await addConstraint('C1', '<=', '1');
    await addConstraint('A1:A19', '<=', '0.2');
    const constraints2 = (await page.locator('#solver-constraints').textContent()) ?? '';
    check(
        'problem 2 has its three constraints',
        constraints2.includes('A1:A19 >= 0') &&
            constraints2.includes('C1 <= 1') &&
            constraints2.includes('A1:A19 <= 0.2'),
        constraints2.trim(),
    );

    // ---- Cancel mid-solve restores the original values. ----
    await page.locator('#solver-solve').click();
    await page.locator('#solver-cancel-run').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-cancel-run').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });
    let restored = true;
    for (let row = 1; row <= 19; row++) {
        if ((await inspect(`A${row}`))?.rawValue !== 0.05) {
            restored = false;
            break;
        }
    }
    check('Cancel restores all 19 original values (0.05)', restored);
    const statusAfterCancel = (await page.locator('#status').textContent()) ?? '';
    check('status reports the cancelled solve', statusAfterCancel.includes('cancelled'), statusAfterCancel);

    // ---- Solve problem 2 for real. ----
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-solve').click();
    // Settle-based evaluation waits for the sheet recalculation on every
    // trial (~10ms on a small workbook), so the 19-variable solve needs
    // a long window.
    const results2 = await waitForResults(600000);
    check('problem 2 reports an optimal solution', results2.includes('Optimal'), results2.slice(0, 120));
    let weightsOk = true;
    let worstDev = 0;
    for (let row = 1; row <= 19; row++) {
        const value = (await inspect(`A${row}`))?.rawValue;
        if (typeof value !== 'number' || Math.abs(value - 1 / 19) >= 5e-3) {
            weightsOk = false;
        }
        if (typeof value === 'number') {
            worstDev = Math.max(worstDev, Math.abs(value - 1 / 19));
        }
    }
    check('problem 2: all 19 weights = 1/19', weightsOk, `worst deviation ${worstDev.toFixed(5)}`);
    const b1Solved = (await inspect('B1'))?.rawValue;
    check(
        'problem 2: B1 = 1.3077',
        typeof b1Solved === 'number' && Math.abs(b1Solved - 0.3 * Math.sqrt(19)) < 1e-3,
        `B1 = ${b1Solved}`,
    );
    check('problem 2 results show the objective before/after', results2.includes('1.2847'));

    // Esc after a solve keeps the solution: dismissing the results view
    // is the same as Keep Solution, never a silent Restore.
    await page.keyboard.press('Escape');
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });
    let escKept = true;
    for (let row = 1; row <= 19; row++) {
        const value = (await inspect(`A${row}`))?.rawValue;
        if (typeof value !== 'number' || Math.abs(value - 1 / 19) >= 5e-3) {
            escKept = false;
            break;
        }
    }
    check('Esc after a solve keeps the solution (all 19 weights = 1/19)', escKept);
    const statusAfterSolve = (await page.locator('#status').textContent()) ?? '';
    check('status reports the finished solve', statusAfterSolve.includes('Solver finished'), statusAfterSolve);

    // ---- Restore Original Values reverts to the pre-solve values. ----
    // Re-solve problem 1 (fast), then Restore instead of Keep.
    await setCell('A1', 0);
    await setCell('A2', 0);
    // Problem 2 replaced B1/C1 with its own formulas; put problem 1's back.
    await setCell('B1', '=A1^2+A2^2');
    await setCell('C1', '=A1+A2');
    await page.waitForFunction(
        () => window.__aiOffice.inspectCell('B1')?.rawValue === 0,
        null,
        { timeout: 5000 },
    );
    await page.waitForFunction(
        () => window.__aiOffice.inspectCell('C1')?.rawValue === 0,
        null,
        { timeout: 5000 },
    );
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await fillSolverForm({ objective: 'B1', goal: 'min', changing: 'A1:A2' });
    // Replace problem 2's three constraints with problem 1's one.
    for (let i = 0; i < 3; i++) {
        await page.locator('#solver-constraints li').first().click();
        await page.locator('#solver-delete-constraint').click();
    }
    await addConstraint('C1', '>=', '1');
    await page.locator('#solver-solve').click();
    const results3 = await waitForResults(60000);
    check('problem 1 re-solve reports an optimal solution', results3.includes('Optimal'), results3.slice(0, 120));
    await page.locator('#solver-restore').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });
    const a1Restored = (await inspect('A1'))?.rawValue;
    const a2Restored = (await inspect('A2'))?.rawValue;
    check(
        'Restore Original Values reverts the cells (A1 = A2 = 0)',
        a1Restored === 0 && a2Restored === 0,
        `A1 = ${a1Restored}, A2 = ${a2Restored}`,
    );
    const statusAfterRestore = (await page.locator('#status').textContent()) ?? '';
    check('status reports the restore', statusAfterRestore.includes('restored'), statusAfterRestore);

    // ---- Invalid input shows an error instead of solving. ----
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-objective').fill('');
    await page.locator('#solver-solve').click();
    await page.locator('#solver-error').waitFor({ state: 'visible', timeout: 5000 });
    const errorText = (await page.locator('#solver-error').textContent()) ?? '';
    check('empty objective shows a validation error', errorText.includes('Set Objective'), errorText);
    await page.locator('#solver-close').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });

    // ---- Opening a file with a saved Solver model prefills the dialog. ----
    // Synthetic fixture (same shape as problem 1, built from scratch).
    const fixture = XLSX.utils.book_new();
    const fixtureSheet = XLSX.utils.aoa_to_sheet([[0], [0]]);
    fixtureSheet['B1'] = { t: 'n', f: 'A1^2+A2^2', v: 0 };
    fixtureSheet['C1'] = { t: 'n', f: 'A1+A2', v: 0 };
    XLSX.utils.book_append_sheet(fixture, fixtureSheet, 'Sheet1');
    fixture.Workbook = {
        Names: [
            { Name: 'solver_opt', Ref: 'Sheet1!$B$1' },
            { Name: 'solver_adj', Ref: 'Sheet1!$A$1:$A$2' },
            { Name: 'solver_typ', Ref: '2' },
            { Name: 'solver_val', Ref: '0' },
            { Name: 'solver_num', Ref: '1' },
            { Name: 'solver_lhs1', Ref: 'Sheet1!$A$1:$A$2' },
            { Name: 'solver_rel1', Ref: '3' },
            { Name: 'solver_rhs1', Ref: '0' },
            { Name: 'solver_neg', Ref: '1' },
            { Name: 'solver_eng', Ref: '1' },
        ],
    };
    XLSX.writeFile(fixture, fixturePath);
    await page.locator('[data-action="open"]').click();
    await page.locator('#open-file-input').setInputFiles(fixturePath);
    await page.locator('#open-dialog').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#open-dialog button[value="confirm"]').click();
    await page.waitForFunction(
        () => document.querySelector('#status')?.textContent === 'Opened solver-model-fixture.xlsx.',
        null,
        { timeout: 15000 },
    );
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    check(
        'imported Solver model prefills the dialog (objective, goal, changing)',
        (await page.locator('#solver-objective').inputValue()) === 'B1' &&
            (await page.locator('input[name="solver-goal"][value="min"]').isChecked()) &&
            (await page.locator('#solver-changing').inputValue()) === 'A1:A2',
    );
    const importedConstraints = (await page.locator('#solver-constraints').textContent()) ?? '';
    check(
        'imported Solver model prefills the constraint',
        importedConstraints.includes('A1:A2 >= 0'),
        importedConstraints.trim(),
    );
    check(
        'imported Solver model prefills non-negative and method',
        (await page.locator('#solver-nonnegative').isChecked()) &&
            (await page.locator('#solver-method').inputValue()) === 'grg',
    );
    await page.locator('#solver-close').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });

    check('no page errors or failed requests', errors.length === 0, errors.join('; '));
} finally {
    await browser?.close();
    server.close();
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.rmSync(fixturePath, { force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
