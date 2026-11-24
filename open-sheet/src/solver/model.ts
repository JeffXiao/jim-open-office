/**
 * Sheet bridge for the Solver: the only module that touches Univer.
 * Address/range parsing is pure (unit-tested without Univer); the class
 * below reads and writes the live sheet through the Facade API.
 *
 * One evaluation is one sheet round trip: write a trial vector into the
 * changing range with a single setValues call, wait for the sheet
 * recalculation to settle, then read the objective cell and each
 * constraint side. The reads must wait: Univer's sheet recalculation is
 * debounced (~10ms) and asynchronous — a read in the same turn as a write
 * still shows the previous value (measured). An earlier version evaluated
 * formula cells directly with the formula engine's batch API
 * (executeFormulas), but that reads STALE values whenever the objective
 * (or a constraint side) is a formula whose precedents are themselves
 * formulas: the batch call computes the given formulas against the
 * cached values of their precedents, and the trial write has not
 * refreshed those yet. The symptom was a constant objective, so the
 * solver concluded the start was optimal and never changed the changing
 * cells (confirmed on a chained formula, D1 = 10-B1 with B1 = A1^2+A2^2,
 * and on a real portfolio file whose objective is
 * (return - risk-free) / volatility). Settling first costs ~10ms per
 * evaluation, but it is the only read that is correct for chained
 * formulas — which is how real workbooks are built.
 */
import type { FWorksheet } from '@univerjs/preset-sheets-core';
import { CONFIG } from '../config';

export type CellRef = { row: number; col: number };
export type RangeRef = { start: CellRef; end: CellRef };
export type ConstraintOperator = '>=' | '<=' | '=';
export type ConstraintRight =
    | { kind: 'number'; value: number }
    | { kind: 'cell'; ref: CellRef };
export type SolverConstraint = {
    left: RangeRef;
    operator: ConstraintOperator;
    right: ConstraintRight;
};

/** 'A' -> 0, 'Z' -> 25, 'AA' -> 26. */
export function columnLettersToIndex(letters: string): number {
    let index = 0;
    for (const char of letters.toUpperCase()) {
        index = index * 26 + (char.charCodeAt(0) - 'A'.charCodeAt(0) + 1);
    }
    return index - 1;
}

/** 0 -> 'A', 25 -> 'Z', 26 -> 'AA'. */
export function indexToColumnLetters(index: number): string {
    let letters = '';
    let value = index + 1;
    while (value > 0) {
        const remainder = (value - 1) % 26;
        letters = String.fromCharCode('A'.charCodeAt(0) + remainder) + letters;
        value = Math.floor((value - 1) / 26);
    }
    return letters;
}

/**
 * Parse one A1 address (absolute markers allowed: $A$1, A$1, $A1).
 * Returns null for anything that is not a cell inside the sheet limits.
 */
export function parseCellAddress(text: string): CellRef | null {
    const cleaned = text.trim().replace(/\$/g, '');
    const match = /^([A-Za-z]{1,3})([0-9]+)$/.exec(cleaned);
    if (match === null) {
        return null;
    }
    const col = columnLettersToIndex(match[1] ?? '');
    const row = Number(match[2] ?? '0') - 1;
    if (
        col < 0 ||
        col >= CONFIG.SOLVER_MAX_COLUMNS ||
        row < 0 ||
        row >= CONFIG.SOLVER_MAX_ROWS
    ) {
        return null;
    }
    return { row, col };
}

/**
 * Parse an A1 range ('A1:B2') or a single cell ('A1'). The ends are
 * normalized so start is always the top-left cell. Null when invalid.
 */
export function parseRange(text: string): RangeRef | null {
    const parts = text.split(':');
    if (parts.length === 1) {
        const cell = parseCellAddress(parts[0] ?? '');
        return cell === null ? null : { start: cell, end: cell };
    }
    if (parts.length !== 2) {
        return null;
    }
    const first = parseCellAddress(parts[0] ?? '');
    const second = parseCellAddress(parts[1] ?? '');
    if (first === null || second === null) {
        return null;
    }
    return {
        start: { row: Math.min(first.row, second.row), col: Math.min(first.col, second.col) },
        end: { row: Math.max(first.row, second.row), col: Math.max(first.col, second.col) },
    };
}

/** 'A1' for a cell ref. */
export function cellAddress(ref: CellRef): string {
    return `${indexToColumnLetters(ref.col)}${ref.row + 1}`;
}

/** 'A1' for a single cell, 'A1:B2' for a range. */
export function rangeAddress(range: RangeRef): string {
    const start = cellAddress(range.start);
    if (range.start.row === range.end.row && range.start.col === range.end.col) {
        return start;
    }
    return `${start}:${cellAddress(range.end)}`;
}

/** Every cell in a range, row-major order. */
export function rangeCells(range: RangeRef): CellRef[] {
    const cells: CellRef[] = [];
    for (let row = range.start.row; row <= range.end.row; row++) {
        for (let col = range.start.col; col <= range.end.col; col++) {
            cells.push({ row, col });
        }
    }
    return cells;
}

/** Number of cells in a range. */
export function rangeSize(range: RangeRef): number {
    return (
        (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1)
    );
}

/** Parse a constraint's right side: a number, or a cell address. */
export function parseConstraintRight(text: string): ConstraintRight | null {
    const cleaned = text.trim();
    if (cleaned === '') {
        return null;
    }
    const asNumber = Number(cleaned);
    if (Number.isFinite(asNumber)) {
        return { kind: 'number', value: asNumber };
    }
    const asCell = parseCellAddress(cleaned);
    return asCell === null ? null : { kind: 'cell', ref: asCell };
}

/** Parse one constraint: left side (cell or range), operator, right side. */
export function parseConstraint(
    leftText: string,
    operator: string,
    rightText: string,
): SolverConstraint | null {
    if (operator !== '>=' && operator !== '<=' && operator !== '=') {
        return null;
    }
    const left = parseRange(leftText);
    const right = parseConstraintRight(rightText);
    if (left === null || right === null) {
        return null;
    }
    return { left, operator, right };
}

/**
 * Parse a SUM formula: 'SUM(BM31:BM49)' (a leading '=', '$' markers,
 * whitespace, and case are tolerated). Returns the summed range, or
 * null for anything else — a plain cell, a different function, or an
 * expression around the SUM. Only a bare SUM of one range is a
 * projectable total; anything else stays with the penalty method.
 */
export function parseSumFormula(formula: string): RangeRef | null {
    const cleaned = formula.trim().replace(/^\s*=/, '').trim();
    const match = /^sum\s*\(\s*(.+?)\s*\)$/i.exec(cleaned);
    if (match === null) {
        return null;
    }
    return parseRange(match[1] ?? '');
}

/** One feasibility rule a trial point must satisfy. */
type ProjectionRule =
    | { kind: 'cell'; index: number; operator: ConstraintOperator; value: number }
    | { kind: 'sum'; indices: number[]; operator: ConstraintOperator; value: number };

/**
 * Build a feasibility projector for a solve: a pure function mapping
 * any trial point to a point the rules allow, without touching the
 * sheet. Two kinds of constraint can be projected:
 *
 * - A range (or a single changing cell) against a number: each
 *   changing cell it covers is clamped to the number (`>=` / `<=`)
 *   or set to it (`=`).
 * - A single cell whose formula is the SUM of (part of) the changing
 *   range against a number: the covered cells are scaled
 *   proportionally until their sum meets the number — scaling keeps
 *   the relative allocation, which is what a total cap means for a
 *   portfolio. A SUM that also covers cells outside the changing
 *   range is skipped: its fixed part is not ours to scale.
 *
 * Not projectable, and left to the penalty method: a cell right side
 * (it can move during the solve), and a left-side formula that is not
 * a bare SUM (for example a volatility cell) — the projector cannot
 * know how the changing cells move it without evaluating it, and
 * evaluating it means writing the trial first. The projector is a
 * repair, not a guarantee for mutually unsatisfiable constraints:
 * cell rules and sum rules pull in opposite directions when they
 * conflict, so they alternate a few rounds and finish on the cell
 * rules; whatever conflict is left over, the penalty still catches.
 */
export function buildProjector(
    changing: RangeRef,
    constraints: SolverConstraint[],
    formulaOf: (ref: CellRef) => string | null,
): (trial: number[]) => number[] {
    const indexOf = new Map<string, number>();
    rangeCells(changing).forEach((ref, index) => {
        indexOf.set(`${ref.row},${ref.col}`, index);
    });
    const rules: ProjectionRule[] = [];
    for (const constraint of constraints) {
        if (constraint.right.kind !== 'number') {
            continue;
        }
        const leftCells = rangeCells(constraint.left);
        if (leftCells.length === 1) {
            const ref = leftCells[0] as CellRef;
            const ownIndex = indexOf.get(`${ref.row},${ref.col}`);
            if (ownIndex !== undefined) {
                rules.push({
                    kind: 'cell',
                    index: ownIndex,
                    operator: constraint.operator,
                    value: constraint.right.value,
                });
                continue;
            }
            const formula = formulaOf(ref);
            if (formula === null) {
                continue;
            }
            const summed = parseSumFormula(formula);
            if (summed === null) {
                continue;
            }
            const indices: number[] = [];
            let outside = false;
            for (const cell of rangeCells(summed)) {
                const index = indexOf.get(`${cell.row},${cell.col}`);
                if (index === undefined) {
                    outside = true;
                    break;
                }
                indices.push(index);
            }
            if (outside || indices.length === 0) {
                continue;
            }
            rules.push({
                kind: 'sum',
                indices,
                operator: constraint.operator,
                value: constraint.right.value,
            });
        } else {
            for (const cell of leftCells) {
                const index = indexOf.get(`${cell.row},${cell.col}`);
                if (index !== undefined) {
                    rules.push({
                        kind: 'cell',
                        index,
                        operator: constraint.operator,
                        value: constraint.right.value,
                    });
                }
            }
        }
    }
    if (rules.length === 0) {
        return (trial: number[]): number[] => [...trial];
    }
    const applyCellRules = (point: number[]): void => {
        for (const rule of rules) {
            if (rule.kind !== 'cell') {
                continue;
            }
            const current = point[rule.index] ?? 0;
            if (rule.operator === '>=') {
                point[rule.index] = Math.max(current, rule.value);
            } else if (rule.operator === '<=') {
                point[rule.index] = Math.min(current, rule.value);
            } else {
                point[rule.index] = rule.value;
            }
        }
    };
    const applySumRules = (point: number[]): void => {
        for (const rule of rules) {
            if (rule.kind !== 'sum') {
                continue;
            }
            let sum = 0;
            for (const index of rule.indices) {
                sum += point[index] ?? 0;
            }
            if (rule.operator === '<=') {
                if (sum > rule.value && sum !== 0) {
                    const factor = rule.value / sum;
                    for (const index of rule.indices) {
                        point[index] = (point[index] ?? 0) * factor;
                    }
                }
            } else if (rule.operator === '>=') {
                if (sum < rule.value && sum > 0) {
                    const factor = rule.value / sum;
                    for (const index of rule.indices) {
                        point[index] = (point[index] ?? 0) * factor;
                    }
                }
            } else if (sum !== rule.value && sum > 0) {
                const factor = rule.value / sum;
                for (const index of rule.indices) {
                    point[index] = (point[index] ?? 0) * factor;
                }
            }
        }
    };
    return (trial: number[]): number[] => {
        const point = [...trial];
        for (let round = 0; round < CONFIG.SOLVER_PROJECTION_ROUNDS; round++) {
            applyCellRules(point);
            applySumRules(point);
        }
        applyCellRules(point);
        return point;
    };
}

/** One macrotask — long enough for Univer's async formula recalc to run. */
function tick(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

/** What a changing cell held before the solve (for Restore). */
export type OriginalCell = {
    /** Formula text (without '='? No — with '=', as stored), or null. */
    formula: string | null;
    /** Raw value, or null when the cell was empty. */
    value: number | string | boolean | null;
};

/** Raw values allowed in a changing range before numeric validation. */
export type SolverCellValue = number | string | boolean | null;

/** One evaluation: objective plus one violation amount per constraint cell. */
export type ModelEvaluation = {
    objective: number | null;
    /** 0 = satisfied, > 0 = amount violated, one entry per constraint cell. */
    violations: number[];
};

export class SolverModel {
    #sheet: FWorksheet;
    /**
     * True once the run was cancelled. An evaluation already in flight
     * may be between its write and its settle when the user cancels; a
     * later evaluation in the same engine step must not write a trial
     * over the restored originals, so evaluate() refuses to write once
     * this is set (it returns a non-finite objective instead, which the
     * engine treats as a worthless trial and then discards with the run).
     */
    #cancelled = false;

    constructor(sheet: FWorksheet) {
        this.#sheet = sheet;
    }

    /** Stop any further trial writes (the run was cancelled). */
    cancel(): void {
        this.#cancelled = true;
    }

    /** Read one cell as a number; null when empty or not a number. */
    readCell(ref: CellRef): number | null {
        const raw = this.#sheet.getRange(cellAddress(ref)).getRawValue();
        return typeof raw === 'number' ? raw : null;
    }

    /** Read raw cell values row-major, preserving non-numeric constants for Restore. */
    readRange(range: RangeRef): SolverCellValue[][] {
        const raw = this.#sheet.getRange(rangeAddress(range)).getRawValues();
        return raw.map((row) =>
            row.map((value) =>
                typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
                    ? value
                    : null,
            ),
        );
    }

    /** Read the formulas of a range ('' means no formula). */
    readFormulas(range: RangeRef): string[][] {
        return this.#sheet.getRange(rangeAddress(range)).getFormulas();
    }

    /**
     * Write a trial vector into a range with ONE setValues call.
     * Values are row-major; the count must match the range size.
     */
    writeValues(range: RangeRef, values: number[]): void {
        if (values.length !== rangeSize(range)) {
            throw new Error('Solver trial vector does not match the changing range.');
        }
        const rows = range.end.row - range.start.row + 1;
        const cols = range.end.col - range.start.col + 1;
        const matrix: number[][] = [];
        for (let r = 0; r < rows; r++) {
            matrix.push(values.slice(r * cols, (r + 1) * cols));
        }
        this.#sheet.getRange(rangeAddress(range)).setValues(matrix);
    }

    /** Snapshot the changing range before solving (values + formulas). */
    readOriginals(range: RangeRef): OriginalCell[][] {
        const values = this.readRange(range);
        const formulas = this.readFormulas(range);
        return values.map((row, r) =>
            row.map((value, c) => ({
                formula: (formulas[r]?.[c] ?? '') === '' ? null : (formulas[r]?.[c] ?? ''),
                value,
            })),
        );
    }

    /** Restore a snapshot taken by readOriginals (values and formulas). */
    writeOriginals(range: RangeRef, originals: OriginalCell[][]): void {
        const cells = rangeCells(range);
        cells.forEach((ref, index) => {
            const row = Math.floor(index / (range.end.col - range.start.col + 1));
            const col = index % (range.end.col - range.start.col + 1);
            const original = originals[row]?.[col];
            if (original === undefined) {
                return;
            }
            const rangeCell = this.#sheet.getRange(cellAddress(ref));
            if (original.formula !== null) {
                rangeCell.setValue(original.formula);
            } else if (original.value !== null) {
                rangeCell.setValue(original.value);
            } else {
                rangeCell.setValue({ v: null, f: null, p: null });
            }
        });
    }

    /**
     * Build the feasibility projector for a solve from the constraints.
     * The left-side formulas are read once here — they do not change
     * during a solve — so the projector itself is pure arithmetic and
     * costs nothing per evaluation.
     */
    projector(changing: RangeRef, constraints: SolverConstraint[]): (trial: number[]) => number[] {
        return buildProjector(changing, constraints, (ref) => {
            const formulas = this.readFormulas({ start: ref, end: ref });
            const formula = formulas[0]?.[0] ?? '';
            return formula === '' ? null : formula;
        });
    }

    /**
     * Wait for the formula engine to recalculate a cell after a write.
     * Univer recalculates asynchronously, debounced by ~10ms: two reads
     * a macrotask apart can both land BEFORE the recalculation fires and
     * agree on the STALE value (measured: the new value appears 0.3ms
     * to 13.6ms after a write). So, when the pre-write value is known,
     * wait until the value moves away from it — that proves the
     * recalculation ran — and then holds still across two reads. When
     * the trial leaves the value unchanged, the stale value IS the true
     * value, so accept it after enough attempts for the recalculation
     * to have fired (five attempts, ~10+ macrotasks).
     */
    async settle(ref: CellRef, previous: number | null = null): Promise<void> {
        let moved = previous === null;
        for (let attempt = 0; attempt < CONFIG.SOLVER_SETTLE_ATTEMPTS; attempt++) {
            await tick();
            const first = this.readCell(ref);
            if (!moved && first !== previous) {
                moved = true;
            }
            await tick();
            const second = this.readCell(ref);
            if (!moved && second !== previous) {
                moved = true;
            }
            if (moved && first === second) {
                return;
            }
            if (!moved && attempt >= 4) {
                return;
            }
        }
    }

    /**
     * Evaluate one trial vector: write it, wait for the recalculation to
     * settle, then read the objective and every constraint side. A range
     * left side is checked cell-wise, like Excel ($BM$31:$BM$49 >= 0 means
     * every cell >= 0). Settling first is what makes this correct for
     * chained formulas (see the module comment): the objective and
     * constraint sides are all recomputed in the same recalculation pass,
     * so once the objective has settled they have too.
     */
    async evaluate(
        objective: CellRef,
        changing: RangeRef,
        trial: number[],
        constraints: SolverConstraint[],
    ): Promise<ModelEvaluation> {
        // Cancelled mid-step: refuse the write, or the trial would land
        // over the originals the cancel just restored.
        if (this.#cancelled) {
            return { objective: null, violations: constraints.map(() => 0) };
        }
        // Read the objective first: settle() waits for it to move away
        // from this value, which is what proves the recalculation ran.
        const objectiveBeforeWrite = this.readCell(objective);
        this.writeValues(changing, trial);
        const needed: CellRef[] = [objective];
        for (const constraint of constraints) {
            needed.push(...rangeCells(constraint.left));
            if (constraint.right.kind === 'cell') {
                needed.push(constraint.right.ref);
            }
        }
        await this.settle(objective, objectiveBeforeWrite);
        const values = new Map<string, number | null>();
        const keyOf = (ref: CellRef): string => `${ref.row},${ref.col}`;
        for (const ref of needed) {
            values.set(keyOf(ref), this.readCell(ref));
        }
        const objectiveValue = values.get(keyOf(objective)) ?? null;
        const violations: number[] = [];
        for (const constraint of constraints) {
            const rightValue =
                constraint.right.kind === 'number'
                    ? constraint.right.value
                    : (values.get(keyOf(constraint.right.ref)) ?? null);
            const leftValues = rangeCells(constraint.left).map(
                (ref) => values.get(keyOf(ref)) ?? null,
            );
            for (const leftValue of leftValues) {
                if (leftValue === null || rightValue === null) {
                    violations.push(CONFIG.SOLVER_MAX_VIOLATION);
                    continue;
                }
                if (constraint.operator === '>=') {
                    violations.push(Math.max(0, rightValue - leftValue));
                } else if (constraint.operator === '<=') {
                    violations.push(Math.max(0, leftValue - rightValue));
                } else {
                    violations.push(Math.abs(leftValue - rightValue));
                }
            }
        }
        return { objective: objectiveValue, violations };
    }
}
