/**
 * Unit tests for the Solver sheet bridge's pure parsing (src/solver/model.ts).
 * Address/range/constraint parsing needs no Univer; the live read/write
 * part is covered by the browser harness instead.
 */
import { describe, expect, it } from 'vitest';
import {
    buildProjector,
    cellAddress,
    indexToColumnLetters,
    parseCellAddress,
    parseConstraint,
    parseConstraintRight,
    parseRange,
    parseSumFormula,
    rangeAddress,
    rangeCells,
    rangeSize,
    columnLettersToIndex,
} from '../../src/solver/model';
import type { CellRef, SolverConstraint } from '../../src/solver/model';

describe('column letters', () => {
    it('converts letters to indexes and back', () => {
        expect(columnLettersToIndex('A')).toBe(0);
        expect(columnLettersToIndex('Z')).toBe(25);
        expect(columnLettersToIndex('AA')).toBe(26);
        expect(columnLettersToIndex('BM')).toBe(64);
        expect(columnLettersToIndex('XFD')).toBe(16383);
        expect(indexToColumnLetters(0)).toBe('A');
        expect(indexToColumnLetters(25)).toBe('Z');
        expect(indexToColumnLetters(26)).toBe('AA');
        expect(indexToColumnLetters(64)).toBe('BM');
        expect(indexToColumnLetters(16383)).toBe('XFD');
    });
});

describe('parseCellAddress', () => {
    it('parses plain, absolute, and lowercase addresses', () => {
        expect(parseCellAddress('A1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('$A$1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('A$1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('$A1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('a1')).toEqual({ row: 0, col: 0 });
        expect(parseCellAddress('BM60')).toEqual({ row: 59, col: 64 });
        expect(parseCellAddress('XFD1048576')).toEqual({ row: 1048575, col: 16383 });
    });

    it('rejects anything that is not a cell inside the sheet', () => {
        expect(parseCellAddress('')).toBeNull();
        expect(parseCellAddress('A0')).toBeNull();
        expect(parseCellAddress('A')).toBeNull();
        expect(parseCellAddress('1')).toBeNull();
        expect(parseCellAddress('A1B')).toBeNull();
        expect(parseCellAddress('A1:B2')).toBeNull();
        expect(parseCellAddress('XFE1')).toBeNull();
        expect(parseCellAddress('A1048577')).toBeNull();
        expect(parseCellAddress('  ')).toBeNull();
    });
});

describe('parseRange', () => {
    it('parses a single cell as a one-cell range', () => {
        expect(parseRange('A1')).toEqual({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } });
        expect(parseRange('$BM$60')).toEqual({
            start: { row: 59, col: 64 },
            end: { row: 59, col: 64 },
        });
    });

    it('parses a range and normalizes reversed ends', () => {
        expect(parseRange('A1:B2')).toEqual({
            start: { row: 0, col: 0 },
            end: { row: 1, col: 1 },
        });
        expect(parseRange('B2:A1')).toEqual({
            start: { row: 0, col: 0 },
            end: { row: 1, col: 1 },
        });
        expect(parseRange('$BM$31:$BM$49')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
    });

    it('rejects malformed ranges', () => {
        expect(parseRange('')).toBeNull();
        expect(parseRange('A1:B2:C3')).toBeNull();
        expect(parseRange('A0:B2')).toBeNull();
        expect(parseRange('A1:')).toBeNull();
        expect(parseRange(':B2')).toBeNull();
    });
});

describe('address formatting and range helpers', () => {
    it('round-trips addresses through parse and format', () => {
        expect(cellAddress({ row: 59, col: 64 })).toBe('BM60');
        expect(rangeAddress({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } })).toBe('A1');
        expect(rangeAddress({ start: { row: 0, col: 0 }, end: { row: 1, col: 1 } })).toBe('A1:B2');
    });

    it('lists range cells row-major with the right size', () => {
        const range = { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } };
        expect(rangeCells(range)).toEqual([
            { row: 0, col: 0 },
            { row: 0, col: 1 },
            { row: 1, col: 0 },
            { row: 1, col: 1 },
        ]);
        expect(rangeSize(range)).toBe(4);
        expect(rangeSize({ start: { row: 30, col: 64 }, end: { row: 48, col: 64 } })).toBe(19);
    });
});

describe('parseConstraintRight', () => {
    it('parses numbers and cell addresses', () => {
        expect(parseConstraintRight('0.2')).toEqual({ kind: 'number', value: 0.2 });
        expect(parseConstraintRight('0')).toEqual({ kind: 'number', value: 0 });
        expect(parseConstraintRight('-1')).toEqual({ kind: 'number', value: -1 });
        expect(parseConstraintRight('1e3')).toEqual({ kind: 'number', value: 1000 });
        expect(parseConstraintRight('BM50')).toEqual({
            kind: 'cell',
            ref: { row: 49, col: 64 },
        });
        expect(parseConstraintRight('$BM$50')).toEqual({
            kind: 'cell',
            ref: { row: 49, col: 64 },
        });
    });

    it('rejects empty and unparseable right sides', () => {
        expect(parseConstraintRight('')).toBeNull();
        expect(parseConstraintRight('  ')).toBeNull();
        expect(parseConstraintRight('abc')).toBeNull();
        expect(parseConstraintRight('Infinity')).toBeNull();
    });
});

describe('parseConstraint', () => {
    it('parses a range constraint with a numeric right side', () => {
        expect(parseConstraint('BM31:BM49', '>=', '0')).toEqual({
            left: { start: { row: 30, col: 64 }, end: { row: 48, col: 64 } },
            operator: '>=',
            right: { kind: 'number', value: 0 },
        });
    });

    it('parses a cell constraint with a cell right side', () => {
        expect(parseConstraint('BM50', '<=', 'BM51')).toEqual({
            left: { start: { row: 49, col: 64 }, end: { row: 49, col: 64 } },
            operator: '<=',
            right: { kind: 'cell', ref: { row: 50, col: 64 } },
        });
    });

    it('rejects bad operators and bad sides', () => {
        expect(parseConstraint('A1', '>', '0')).toBeNull();
        expect(parseConstraint('A1', '=>', '0')).toBeNull();
        expect(parseConstraint('A0', '>=', '0')).toBeNull();
        expect(parseConstraint('A1', '>=', '')).toBeNull();
        expect(parseConstraint('A1', '=', 'abc')).toBeNull();
    });
});

describe('parseSumFormula', () => {
    it('parses a bare SUM of one range', () => {
        expect(parseSumFormula('SUM(BM31:BM49)')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
        expect(parseSumFormula('=SUM(BM31:BM49)')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
        expect(parseSumFormula('=SUM($BM$31:$BM$49)')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
        expect(parseSumFormula('sum(bm31:bm49)')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
        expect(parseSumFormula('SUM( BM31 : BM49 )')).toEqual({
            start: { row: 30, col: 64 },
            end: { row: 48, col: 64 },
        });
        expect(parseSumFormula('=SUM(A1:A2)')).toEqual({
            start: { row: 0, col: 0 },
            end: { row: 1, col: 0 },
        });
    });

    it('rejects anything that is not a bare SUM of one range', () => {
        expect(parseSumFormula('BL56*SQRT(365)')).toBeNull();
        expect(parseSumFormula('MAX(BM31:BM49)')).toBeNull();
        expect(parseSumFormula('A1')).toBeNull();
        expect(parseSumFormula('')).toBeNull();
        expect(parseSumFormula('SUM(BM31:BM49)+1')).toBeNull();
        expect(parseSumFormula('SUM(BM31:BM49,BM50)')).toBeNull();
        expect(parseSumFormula('SUMPRODUCT(BM31:BM49,BM31:BM49)')).toBeNull();
    });
});

describe('buildProjector', () => {
    /** Jeff's constraints: weights >= 0, total BM50 <= 1, volatility BM56 <= 0.2. */
    const jeffChanging = parseRange('BM31:BM49') as { start: CellRef; end: CellRef };
    const jeffConstraints = [
        parseConstraint('BM31:BM49', '>=', '0') as SolverConstraint,
        parseConstraint('BM50', '<=', '1') as SolverConstraint,
        parseConstraint('BM56', '<=', '0.2') as SolverConstraint,
    ];
    const jeffFormulaOf = (ref: CellRef): string | null => {
        if (ref.row === 49 && ref.col === 64) return '=SUM(BM31:BM49)';
        if (ref.row === 55 && ref.col === 64) return '=BL56*SQRT(365)';
        return null;
    };
    const jeffProject = buildProjector(jeffChanging, jeffConstraints, jeffFormulaOf);

    it('scales a total over 100% back to exactly 100%, keeping the mix', () => {
        // The live report: a mid-solve trial showed the total at 112.14%.
        const trial = [
            0.6443, 0.2322, 0.15, 0.07, 0.0249, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        expect(trial.reduce((a, b) => a + b, 0)).toBeCloseTo(1.1214, 9);
        const projected = jeffProject(trial);
        expect(projected.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        // Proportional scaling: each weight keeps its share of the total.
        expect(projected[0] ?? 0).toBeCloseTo(0.6443 / 1.1214, 9);
        expect(projected[1] ?? 0).toBeCloseTo(0.2322 / 1.1214, 9);
        expect(projected[2] ?? 0).toBeCloseTo(0.15 / 1.1214, 9);
        for (const value of projected) {
            expect(value ?? 0).toBeGreaterThanOrEqual(0);
        }
        // The input is not mutated.
        expect(trial.reduce((a, b) => a + b, 0)).toBeCloseTo(1.1214, 9);
    });

    it('clamps a negative weight to zero and leaves a feasible total alone', () => {
        const projected = jeffProject([
            -0.05, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        expect(projected[0]).toBe(0);
        expect(projected[1]).toBe(0.5);
        expect(projected[2]).toBe(0.5);
        expect(projected.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    });

    it('leaves a feasible trial untouched (Jeff’s 87.64% start)', () => {
        const trial = [
            0.2322, 0.6443, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        expect(jeffProject(trial)).toEqual(trial);
    });

    it('does not try to project a formula it cannot read (volatility)', () => {
        // BM56 <= 0.2 is a formula cell, not a SUM: the projector has
        // no rule for it, so a trial is unchanged by that constraint
        // (the penalty method still handles it).
        const changing = parseRange('A1:A2') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('C1', '<=', '0.2') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => '=BL56*SQRT(365)');
        expect(project([0.5, 0.5])).toEqual([0.5, 0.5]);
    });

    it('clamps each cell to a per-cell cap', () => {
        const changing = parseRange('A1:A3') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('A1:A3', '<=', '0.2') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => null);
        expect(project([0.5, 0.1, 0.3])).toEqual([0.2, 0.1, 0.2]);
    });

    it('sets each cell to a per-cell equality', () => {
        const changing = parseRange('A1:A3') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('A1:A3', '=', '0.1') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => null);
        expect(project([0.5, 0.2, 0.3])).toEqual([0.1, 0.1, 0.1]);
    });

    it('scales a sum up to a minimum total', () => {
        const changing = parseRange('A1:A2') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('C1', '>=', '1') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => '=SUM(A1:A2)');
        expect(project([0.3, 0.3])).toEqual([0.5, 0.5]);
    });

    it('scales only the cells a SUM covers', () => {
        const changing = parseRange('A1:A4') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('C1', '<=', '0.5') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => '=SUM(A1:A2)');
        expect(project([0.4, 0.4, 0.3, 0.3])).toEqual([0.25, 0.25, 0.3, 0.3]);
    });

    it('skips a SUM that also covers cells outside the changing range', () => {
        const changing = parseRange('A1:A2') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('C1', '<=', '1') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => '=SUM(A1:A3)');
        expect(project([0.6, 0.6])).toEqual([0.6, 0.6]);
    });

    it('skips a cell right side (it can move during the solve)', () => {
        const changing = parseRange('A1:A2') as { start: CellRef; end: CellRef };
        const constraints = [parseConstraint('C1', '<=', 'D1') as SolverConstraint];
        const project = buildProjector(changing, constraints, () => '=SUM(A1:A2)');
        expect(project([0.6, 0.6])).toEqual([0.6, 0.6]);
    });

    it('is the identity when nothing is projectable', () => {
        const changing = parseRange('A1:A2') as { start: CellRef; end: CellRef };
        const project = buildProjector(changing, [], () => null);
        expect(project([0.6, 0.6])).toEqual([0.6, 0.6]);
    });
});
