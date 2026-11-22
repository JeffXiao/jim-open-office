/**
 * Sheet bridge for the Solver: the only module that touches Univer.
 * Address/range parsing is pure (unit-tested without Univer); the class
 * below reads and writes the live sheet through the Facade API.
 *
 * One evaluation is one sheet round trip: write a trial vector into the
 * changing range with a single setValues call, then read the objective
 * cell and each constraint side. The reads need fresh formula values, but
 * Univer's sheet recalculation is debounced (~10ms) and asynchronous —
 * a read in the same turn as a write still shows the previous value
 * (measured). So formula cells are evaluated directly with the formula
 * engine's batch API (executeFormulas), which computes them against the
 * just-written trial values without waiting for the debounced recalc;
 * plain-value cells are read straight from the sheet (fresh after a
 * write). If the batch evaluation ever fails, the model falls back to
 * waiting for the sheet recalculation to settle.
 */
import type { FWorksheet } from '@univerjs/preset-sheets-core';
import type { FUniver } from '@univerjs/presets';
import type { IFormulaStringMap } from '@univerjs/engine-formula';
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

/** One evaluation: objective plus one violation amount per constraint cell. */
export type ModelEvaluation = {
    objective: number | null;
    /** 0 = satisfied, > 0 = amount violated, one entry per constraint cell. */
    violations: number[];
};

export class SolverModel {
    #sheet: FWorksheet;
    #formula: ReturnType<FUniver['getFormula']>;
    #unitId: string;
    #sheetId: string;
    /** Formula strings for the cells this solve reads (cached on first use;
     * the solve only writes values, never formulas, so they cannot change). */
    #formulaCache = new Map<string, string | null>();
    /** True once the batch evaluation has failed — use settle-and-read after. */
    #batchFailed = false;

    constructor(sheet: FWorksheet, formula: ReturnType<FUniver['getFormula']>, unitId: string) {
        this.#sheet = sheet;
        this.#formula = formula;
        this.#unitId = unitId;
        this.#sheetId = sheet.getSheetId();
    }

    /** Read one cell as a number; null when empty or not a number. */
    readCell(ref: CellRef): number | null {
        const raw = this.#sheet.getRange(cellAddress(ref)).getRawValue();
        return typeof raw === 'number' ? raw : null;
    }

    /** Read a range as numbers, row-major; nulls where empty/non-numeric. */
    readRange(range: RangeRef): (number | null)[][] {
        const raw = this.#sheet.getRange(rangeAddress(range)).getRawValues();
        return raw.map((row) =>
            row.map((value) => (typeof value === 'number' ? value : null)),
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
            } else if (typeof original.value === 'number') {
                rangeCell.setValue(original.value);
            } else {
                rangeCell.setValue({ v: null, f: null, p: null });
            }
        });
    }

    /**
     * Wait for the formula engine to recalculate a cell after a write.
     * Univer recalculates asynchronously: a read in the same turn as a
     * write still shows the previous value (measured: a fresh value
     * appears within a macrotask for an established formula, up to ~10ms
     * for a newly entered one). Yield, then read twice a macrotask
     * apart; when the two reads agree, the value has settled.
     */
    async settle(ref: CellRef): Promise<void> {
        for (let attempt = 0; attempt < CONFIG.SOLVER_SETTLE_ATTEMPTS; attempt++) {
            await tick();
            const first = this.readCell(ref);
            await tick();
            const second = this.readCell(ref);
            if (first === second) {
                return;
            }
        }
    }

    /** A cell's formula string, or null when it holds a plain value. */
    private formulaOf(ref: CellRef): string | null {
        const key = `${ref.row},${ref.col}`;
        const cached = this.#formulaCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const formula = this.#sheet.getRange(cellAddress(ref)).getFormula();
        const result = formula === '' ? null : formula;
        this.#formulaCache.set(key, result);
        return result;
    }

    /** The batch-evaluation map for a list of formula cells. */
    private buildFormulaMap(cells: { ref: CellRef; formula: string }[]): IFormulaStringMap {
        const rows: Record<number, Record<number, string[]>> = {};
        for (const { ref, formula } of cells) {
            (rows[ref.row] ??= {})[ref.col] = [formula];
        }
        return { [this.#unitId]: { [this.#sheetId]: rows } };
    }

    /**
     * Evaluate one trial vector: write it, then read the objective and
     * every constraint side. A range left side is checked cell-wise, like
     * Excel ($BM$31:$BM$49 >= 0 means every cell >= 0).
     *
     * Formula cells are batch-evaluated against the just-written trial
     * values (executeFormulas runs the interpreter directly, so it does
     * not wait for the sheet's debounced recalculation); plain-value
     * cells are read straight from the sheet, where a write lands
     * synchronously. If the batch evaluation ever fails, the model falls
     * back to waiting for the sheet recalculation to settle.
     */
    async evaluate(
        objective: CellRef,
        changing: RangeRef,
        trial: number[],
        constraints: SolverConstraint[],
    ): Promise<ModelEvaluation> {
        this.writeValues(changing, trial);
        const needed: CellRef[] = [objective];
        for (const constraint of constraints) {
            needed.push(...rangeCells(constraint.left));
            if (constraint.right.kind === 'cell') {
                needed.push(constraint.right.ref);
            }
        }
        const formulaCells: { ref: CellRef; formula: string }[] = [];
        const plainCells: CellRef[] = [];
        for (const ref of needed) {
            const formula = this.formulaOf(ref);
            if (formula !== null) {
                formulaCells.push({ ref, formula });
            } else {
                plainCells.push(ref);
            }
        }
        const values = new Map<string, number | null>();
        const keyOf = (ref: CellRef): string => `${ref.row},${ref.col}`;
        for (const ref of plainCells) {
            values.set(keyOf(ref), this.readCell(ref));
        }
        if (formulaCells.length > 0 && !this.#batchFailed) {
            try {
                const results = await this.#formula.executeFormulas(
                    this.buildFormulaMap(formulaCells),
                    CONFIG.SOLVER_FORMULA_TIMEOUT_MS,
                );
                for (const { ref } of formulaCells) {
                    const item = results[this.#unitId]?.[this.#sheetId]?.[ref.row]?.[ref.col]?.[0];
                    values.set(keyOf(ref), typeof item?.value === 'number' ? item.value : null);
                }
            } catch (error) {
                console.warn(
                    'Solver batch formula evaluation failed; falling back to waiting for recalculation.',
                    error,
                );
                this.#batchFailed = true;
                await this.settle(objective);
                for (const { ref } of formulaCells) {
                    values.set(keyOf(ref), this.readCell(ref));
                }
            }
        } else if (formulaCells.length > 0) {
            await this.settle(objective);
            for (const { ref } of formulaCells) {
                values.set(keyOf(ref), this.readCell(ref));
            }
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
