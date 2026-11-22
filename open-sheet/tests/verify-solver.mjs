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
 * equal weights 1/19, objective 0.3*sqrt(19) = 1.3077. Problem 3: the
 * same ratio from 19 equal weights summing to 0.8764 (Jeff's total) —
 * the optimum requires the total to rise to 1.0, and the sum<=1
 * constraint must bind there; the total is also sampled during the run
 * and must never exceed 1.0. Problem 4: a 2-variable problem whose
 * unconstrained optimum sums to 1.4 — the total and each weight are
 * sampled during the run and must never exceed their caps (1.0 and
 * 0.6). Also checks that
 * the dialog is modeless (the sheet is clickable and editable while it
 * is open, before solving and on the results view; its inputs are
 * enabled when it reopens after a solve), that Keep leaves the solution
 * in the cells, that Restore reverts to the originals, that Esc after a
 * solve keeps the solution, that Cancel restores the original values,
 * that the dialog reopens prefilled with the last-used parameters, that
 * invalid input shows an error, and that opening a file with a saved
 * Solver model prefills the dialog from it. It also checks the
 * "already optimal" note: shown when a solve starts at the optimum,
 * hidden after a genuine improvement, and hidden again when the dialog
 * reopens for a new solve. And that Solve stays disabled for the whole
 * run: closing the dialog during setup abandons the run instead of
 * starting one nobody can see, and a forced submit mid-run cannot
 * start a second run.
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
     * Wait for the results view while sampling cells: the solver writes
     * every trial to the sheet, so the only way to prove a total never
     * exceeds its cap mid-solve is to watch it during the run, not
     * just at the end. `sample` runs between visibility checks;
     * `intervalMs` paces it (0 = as fast as the round trips allow).
     */
    async function waitForResultsSampling(timeout, intervalMs, sample) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await page.locator('#solver-results').isVisible()) {
                return (await resultsList.textContent()) ?? '';
            }
            await sample();
            if (intervalMs > 0) {
                await page.waitForTimeout(intervalMs);
            }
        }
        throw new Error('results view did not appear within timeout');
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

    // A genuine improvement (0 -> 0.5) shows no "already optimal" note.
    check(
        'no "already optimal" note after a genuine improvement',
        (await page.locator('#solver-optimal-note').isHidden()) === true,
    );

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

    // ---- A solve that starts at the optimum shows the "already optimal" note. ----
    // A1 = A2 = 0.5 is already problem 1's optimum, so re-solving it
    // barely improves the objective and the results view says so.
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-solve').click();
    const resultsOptimum = await waitForResults(60000);
    check(
        're-solve from the optimum reports an optimal solution',
        resultsOptimum.includes('Optimal'),
        resultsOptimum.slice(0, 120),
    );
    const optimalNote = page.locator('#solver-optimal-note');
    check(
        '"already optimal" note shows when the start is already optimal',
        (await optimalNote.isVisible()) === true,
    );
    check(
        '"already optimal" note text',
        ((await optimalNote.textContent()) ?? '').includes('already (near-)optimal'),
        (await optimalNote.textContent()) ?? '',
    );
    await page.locator('#solver-keep').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });
    // Reopening for a new solve hides the note (the results view is gone).
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    check(
        '"already optimal" note is hidden when the dialog reopens',
        (await optimalNote.isHidden()) === true,
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

    // ---- Closing during setup abandons the run (no invisible solve). ----
    // Solve's setup awaits the first recalculation and the engine's
    // initial evaluations, so closing right after Solve lands inside
    // it. The setup must then be abandoned — never a run the user
    // cannot see — and reopening shows the idle form. (If the close
    // lands after setup instead, the normal cancel path applies; the
    // assertions below hold either way.)
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-solve').click();
    await page.locator('#solver-close').click();
    // Longer than the setup takes, so it has resolved either way.
    await page.waitForTimeout(1500);
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    check(
        'reopening after closing mid-setup shows Solve enabled (no invisible run)',
        (await page.locator('#solver-solve').isDisabled()) === false &&
            (await page.locator('#solver-cancel-run').isHidden()),
    );
    let setupAbandoned = true;
    for (let row = 1; row <= 19; row++) {
        if ((await inspect(`A${row}`))?.rawValue !== 0.05) {
            setupAbandoned = false;
            break;
        }
    }
    check('closing mid-setup leaves the original values (0.05)', setupAbandoned);

    // ---- Solve problem 2 for real. ----
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-solve').click();
    // While a run is active the Solve button stays disabled — and even
    // a forced submit must not start a second run (the guard ignores
    // it; Cancel is the way to stop). The run below must therefore
    // still report the original start (objective before 1.2847), not
    // a trial value a second run would have read.
    await page.locator('#solver-cancel-run').waitFor({ state: 'visible', timeout: 5000 });
    check(
        'Solve stays disabled while a run is active',
        (await page.locator('#solver-solve').isDisabled()) === true,
    );
    await page.evaluate(() => {
        const solve = document.querySelector('#solver-solve');
        solve.disabled = false;
        solve.click();
    });
    // Settle-based evaluation waits for the sheet recalculation on every
    // trial (~10ms on a small workbook), so the 19-variable solve needs
    // a long window.
    const results2 = await waitForResults(900000);
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

    // ---- Problem 3: the total must rise toward the sum constraint. ----
    // Jeff's live report: from XLE 23.22% + SCHD 64.43% (total 87.64%,
    // objective 3.148) the Solver changed nothing — the total stayed at
    // 87.64% even though the sum<=1 rule leaves 12.36% of room. The
    // regression: 19 equal weights summing to 0.8764 (the same total),
    // same ratio objective and sum<=1 constraint as problem 2. The
    // optimum is equal weights 1/19 (sum 1.0, objective 1.3077), so the
    // solver must raise the total toward the constraint to improve —
    // and the constraint must bind: the total must stop at 1.0, not
    // exceed it, even though a larger total would raise the objective
    // further (1.347 at sum 1.1). The 19-variable ratio from this far
    // start uses the full iteration budget, so the run reports
    // max-iterations — the answer is what the regression asserts.
    const start3 = 0.8764 / 19;
    for (let row = 1; row <= 19; row++) {
        await setCell(`A${row}`, start3);
    }
    await page.waitForFunction(
        () =>
            typeof window.__aiOffice.inspectCell('B1')?.rawValue === 'number' &&
            Math.abs(window.__aiOffice.inspectCell('B1').rawValue - 1.24619) < 1e-3,
        null,
        { timeout: 5000 },
    );
    await page.waitForFunction(
        () => {
            const value = window.__aiOffice.inspectCell('C1')?.rawValue;
            return typeof value === 'number' && Math.abs(value - 0.8764) < 1e-9;
        },
        null,
        { timeout: 5000 },
    );
    const b1Start3 = (await inspect('B1'))?.rawValue;
    check(
        'problem 3 start objective computes (B1 = 1.2462 at sum 0.8764)',
        typeof b1Start3 === 'number' && Math.abs(b1Start3 - 1.24619) < 1e-3,
        `B1 = ${b1Start3}`,
    );
    const c1Start3 = (await inspect('C1'))?.rawValue;
    check(
        'problem 3 start total computes (C1 = 0.8764)',
        typeof c1Start3 === 'number' && Math.abs(c1Start3 - 0.8764) < 1e-9,
        `C1 = ${c1Start3}`,
    );

    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await fillSolverForm({ objective: 'B1', goal: 'max', changing: 'A1:A19' });
    const constraints3 = (await page.locator('#solver-constraints').textContent()) ?? '';
    check(
        'problem 3 reuses the sum constraint (C1 <= 1)',
        constraints3.includes('C1 <= 1') && constraints3.includes('A1:A19 >= 0'),
        constraints3.trim(),
    );
    await page.locator('#solver-solve').click();
    // Sample the total while the 19-variable solve runs: the regression
    // for Jeff's live report (a mid-solve total of 112.14%). The run
    // takes minutes, so sample every 50ms — enough to catch the
    // behaviour, since an unprojected run probes over the cap on a
    // large fraction of its trials. The cap-time transfer polish adds
    // ~5,500 evaluations to a 19-variable solve, so the timeout is
    // 20 minutes, not 10.
    let maxTotal3 = 0;
    const resultsProblem3 = await waitForResultsSampling(1200000, 50, async () => {
        const total = (await inspect('C1'))?.rawValue;
        if (typeof total === 'number') {
            maxTotal3 = Math.max(maxTotal3, total);
        }
    });
    check(
        'problem 3: total never exceeds 1.0 during the solve',
        maxTotal3 <= 1 + 1e-9,
        `max C1 seen = ${maxTotal3}`,
    );
    const b1Solved3 = (await inspect('B1'))?.rawValue;
    check(
        'problem 3: objective improves to 1.3077',
        typeof b1Solved3 === 'number' && Math.abs(b1Solved3 - 0.3 * Math.sqrt(19)) < 1e-3,
        `B1 = ${b1Solved3}`,
    );
    const c1Solved3 = (await inspect('C1'))?.rawValue;
    check(
        'problem 3: total rises toward the sum constraint (C1 = 1.0)',
        typeof c1Solved3 === 'number' && Math.abs(c1Solved3 - 1) < 5e-3,
        `C1 = ${c1Solved3}`,
    );
    check(
        'problem 3: sum constraint binds (C1 <= 1, never exceeded)',
        typeof c1Solved3 === 'number' && c1Solved3 <= 1 + 1e-6,
        `C1 = ${c1Solved3}`,
    );
    let weights3Ok = true;
    let worstDev3 = 0;
    for (let row = 1; row <= 19; row++) {
        const value = (await inspect(`A${row}`))?.rawValue;
        if (typeof value !== 'number' || Math.abs(value - 1 / 19) >= 5e-3) {
            weights3Ok = false;
        }
        if (typeof value === 'number') {
            worstDev3 = Math.max(worstDev3, Math.abs(value - 1 / 19));
        }
    }
    check('problem 3: all 19 weights = 1/19', weights3Ok, `worst deviation ${worstDev3.toFixed(5)}`);
    check('problem 3 results show the objective before/after', resultsProblem3.includes('1.2462'));
    await page.locator('#solver-keep').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });

    // ---- Problem 4: the total must never exceed its cap mid-solve. ----
    // Maximize -(A1-0.7)^2-(A2-0.7)^2 subject to A1,A2 >= 0, total
    // C1 = SUM(A1:A2) <= 1, each <= 0.6. The unconstrained optimum
    // (0.7, 0.7) sums to 1.4, so the simplex's expansions probe totals
    // over 1 — the live report was 112.14% mid-solve. The projector
    // repairs those trials before they are written, so sampling the
    // sheet during the run must never see the total over 1 or a weight
    // over 0.6. The constrained optimum is (0.5, 0.5), objective -0.08.
    await setCell('A1', 0.4);
    await setCell('A2', 0.4);
    await setCell('B1', '=-((A1-0.7)^2+(A2-0.7)^2)');
    await setCell('C1', '=SUM(A1:A2)');
    await page.waitForFunction(
        () =>
            typeof window.__aiOffice.inspectCell('B1')?.rawValue === 'number' &&
            Math.abs(window.__aiOffice.inspectCell('B1').rawValue - -0.18) < 1e-9,
        null,
        { timeout: 5000 },
    );
    await page.waitForFunction(
        () => {
            const value = window.__aiOffice.inspectCell('C1')?.rawValue;
            return typeof value === 'number' && Math.abs(value - 0.8) < 1e-9;
        },
        null,
        { timeout: 5000 },
    );
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await fillSolverForm({ objective: 'B1', goal: 'max', changing: 'A1:A2' });
    // Replace problem 3's three constraints with problem 4's.
    for (let i = 0; i < 3; i++) {
        await page.locator('#solver-constraints li').first().click();
        await page.locator('#solver-delete-constraint').click();
    }
    await addConstraint('A1:A2', '>=', '0');
    await addConstraint('C1', '<=', '1');
    await addConstraint('A1:A2', '<=', '0.6');
    await page.locator('#solver-solve').click();
    let maxTotal4 = 0;
    let maxWeight4 = 0;
    const results4 = await waitForResultsSampling(60000, 0, async () => {
        const total = (await inspect('C1'))?.rawValue;
        if (typeof total === 'number') {
            maxTotal4 = Math.max(maxTotal4, total);
        }
        for (const address of ['A1', 'A2']) {
            const value = (await inspect(address))?.rawValue;
            if (typeof value === 'number') {
                maxWeight4 = Math.max(maxWeight4, value);
            }
        }
    });
    check('problem 4 reports an optimal solution', results4.includes('Optimal'), results4.slice(0, 120));
    check(
        'problem 4: total never exceeds 1.0 during the solve',
        maxTotal4 <= 1 + 1e-9,
        `max C1 seen = ${maxTotal4}`,
    );
    check(
        'problem 4: no weight exceeds its 0.6 cap during the solve',
        maxWeight4 <= 0.6 + 1e-9,
        `max weight seen = ${maxWeight4}`,
    );
    const a1Solved4 = (await inspect('A1'))?.rawValue;
    const a2Solved4 = (await inspect('A2'))?.rawValue;
    const b1Solved4 = (await inspect('B1'))?.rawValue;
    const c1Solved4 = (await inspect('C1'))?.rawValue;
    check(
        'problem 4: optimum is (0.5, 0.5), objective -0.08, total 1.0',
        typeof a1Solved4 === 'number' &&
            Math.abs(a1Solved4 - 0.5) < 5e-3 &&
            typeof a2Solved4 === 'number' &&
            Math.abs(a2Solved4 - 0.5) < 5e-3 &&
            typeof b1Solved4 === 'number' &&
            Math.abs(b1Solved4 - -0.08) < 1e-3 &&
            typeof c1Solved4 === 'number' &&
            Math.abs(c1Solved4 - 1) < 5e-3,
        `A1 = ${a1Solved4}, A2 = ${a2Solved4}, B1 = ${b1Solved4}, C1 = ${c1Solved4}`,
    );
    await page.locator('#solver-keep').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });

    // ---- Infeasible start: the solver must still end feasible. ----
    // Set the weights to (0.7, 0.7) — total 1.4, over the cap — and
    // solve again with the same parameters. The projector repairs the
    // start before the first trial, so the saved best is feasible
    // throughout and the final answer is the feasible optimum again,
    // never the infeasible start. (Not sampled during this run: the
    // sheet still shows the over-cap start until the first trial
    // lands, which is the pre-solve value, not a trial.)
    await setCell('A1', 0.7);
    await setCell('A2', 0.7);
    await page.locator('[data-action="solver"]').click();
    await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#solver-solve').click();
    const results4b = await waitForResults(60000);
    check(
        'infeasible start reports an optimal solution',
        results4b.includes('Optimal'),
        results4b.slice(0, 120),
    );
    const a1Solved4b = (await inspect('A1'))?.rawValue;
    const a2Solved4b = (await inspect('A2'))?.rawValue;
    const c1Solved4b = (await inspect('C1'))?.rawValue;
    check(
        'infeasible start ends at the feasible optimum (0.5, 0.5), total 1.0',
        typeof a1Solved4b === 'number' &&
            Math.abs(a1Solved4b - 0.5) < 5e-3 &&
            typeof a2Solved4b === 'number' &&
            Math.abs(a2Solved4b - 0.5) < 5e-3 &&
            typeof c1Solved4b === 'number' &&
            Math.abs(c1Solved4b - 1) < 5e-3,
        `A1 = ${a1Solved4b}, A2 = ${a2Solved4b}, C1 = ${c1Solved4b}`,
    );
    await page.locator('#solver-keep').click();
    await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });

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

    // ---- Keep on a 19-variable IMPORTED problem (Jeff's live report). ----
    // Jeff's run: the Solver calculated (cells moved during the run) but
    // after Keep Solution the changing cells were back at the pre-solve
    // values. The Keep path must hold the solution on an imported file
    // with a chained-formula objective, not just on the blank workbook.
    // Fixture: Jeff's shape — 19 changing cells BM31:BM49, chained
    // objective BM60 = (0.08*SUM - 0.02) / (0.2*SQRT(SUMPRODUCT(w,w))),
    // constraints BM31:BM49>=0, BM50<=1, BM56<=0.2, GRG. Start weights
    // are unequal (sum 0.95, objective ~1.1164); the known optimum is
    // equal weights 1/19, objective 1.3077. The solve stops at the
    // iteration limit with a partial improvement — that is the point:
    // Keep must preserve whatever the solve found, not the start.
    const keep19FixturePath = path.join(DIR, 'keep19-fixture.xlsx');
    try {
        const keepStart = [0.14, 0.01, 0.09, 0.01];
        for (let i = 0; i < 14; i++) keepStart.push(0.05);
        keepStart.push(0.0); // 19 cells, sum 0.95
        const keepSum = keepStart.reduce((a, b) => a + b, 0);
        const keepSumSq = keepStart.reduce((a, b) => a + b * b, 0);
        const keepWb = XLSX.utils.book_new();
        const keepWs = {};
        for (let i = 0; i < 19; i++) {
            keepWs[`BM${31 + i}`] = { t: 'n', v: keepStart[i] };
        }
        keepWs['BM50'] = { t: 'n', f: 'SUM(BM31:BM49)', v: keepSum };
        keepWs['BM51'] = { t: 'n', f: 'SUMPRODUCT(BM31:BM49,BM31:BM49)', v: keepSumSq };
        keepWs['BM52'] = { t: 'n', f: 'SQRT(BM51)', v: Math.sqrt(keepSumSq) };
        keepWs['BM53'] = { t: 'n', f: '0.08*BM50-0.02', v: 0.08 * keepSum - 0.02 };
        keepWs['BM56'] = { t: 'n', f: 'MAX(BM31:BM49)', v: Math.max(...keepStart) };
        keepWs['BM60'] = {
            t: 'n',
            f: 'BM53/(0.2*BM52)',
            v: (0.08 * keepSum - 0.02) / (0.2 * Math.sqrt(keepSumSq)),
        };
        keepWs['!ref'] = 'A1:BM60';
        XLSX.utils.book_append_sheet(keepWb, keepWs, 'Sheet1');
        keepWb.Workbook = {
            Names: [
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
            ],
        };
        XLSX.writeFile(keepWb, keep19FixturePath);
        const readWeights = async () => {
            const weights = [];
            for (let row = 31; row <= 49; row++) {
                weights.push((await inspect(`BM${row}`))?.rawValue);
            }
            return { weights, objective: (await inspect('BM60'))?.rawValue };
        };
        await page.locator('[data-action="open"]').click();
        await page.locator('#open-file-input').setInputFiles(keep19FixturePath);
        await page.locator('#open-dialog').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('#open-dialog button[value="confirm"]').click();
        await page.waitForFunction(
            () => document.querySelector('#status')?.textContent === 'Opened keep19-fixture.xlsx.',
            null,
            { timeout: 15000 },
        );
        await page.locator('[data-action="solver"]').click();
        await solverDialog.waitFor({ state: 'visible', timeout: 5000 });
        check(
            'imported 19-var problem prefills the dialog (BM60 / BM31:BM49)',
            (await page.locator('#solver-objective').inputValue()) === 'BM60' &&
                (await page.locator('#solver-changing').inputValue()) === 'BM31:BM49',
        );
        await page.locator('#solver-solve').click();
        const resultsKeep19 = await waitForResults(900000);
        const atResults = await readWeights();
        const moved = atResults.weights.some(
            (value, i) => typeof value === 'number' && Math.abs(value - keepStart[i]) > 5e-3,
        );
        check(
            'imported 19-var solve improves the objective at results-show',
            typeof atResults.objective === 'number' && atResults.objective > 1.1164,
            `BM60 = ${atResults.objective}`,
        );
        check(
            'imported 19-var solve moved the changing cells by results-show',
            moved,
            `BM31 = ${atResults.weights[0]}, BM32 = ${atResults.weights[1]}`,
        );
        await page.locator('#solver-keep').click();
        await solverDialog.waitFor({ state: 'hidden', timeout: 5000 });
        const afterKeep19 = await readWeights();
        const kept =
            afterKeep19.weights.every(
                (value, i) =>
                    typeof value === 'number' &&
                    typeof atResults.weights[i] === 'number' &&
                    Math.abs(value - atResults.weights[i]) < 1e-9,
            ) && afterKeep19.objective === atResults.objective;
        check(
            'Keep Solution keeps the solved values on an imported 19-var problem',
            kept,
            `BM60 after Keep = ${afterKeep19.objective} (was ${atResults.objective})`,
        );
        const reverted = afterKeep19.weights.every(
            (value, i) => typeof value === 'number' && Math.abs(value - keepStart[i]) < 1e-9,
        );
        check('Keep Solution does not revert to the start weights', !reverted);
        void resultsKeep19;
    } finally {
        fs.rmSync(keep19FixturePath, { force: true });
    }

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
