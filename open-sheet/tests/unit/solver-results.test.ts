/**
 * Unit tests for the "already optimal" decision (src/solver/results.ts).
 * Pure helper — no Univer, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { isEssentiallyOptimal } from '../../src/solver/results';

describe('isEssentiallyOptimal — Max', () => {
    it('a clear improvement is not already optimal', () => {
        expect(isEssentiallyOptimal('max', 1.0, 1.5)).toBe(false);
        expect(isEssentiallyOptimal('max', 0, 0.5)).toBe(false);
    });
    it('a barely improved objective is already optimal', () => {
        // Jeff's case: Sharpe 3.6605, unchanged after the solve.
        expect(isEssentiallyOptimal('max', 3.6605, 3.6605)).toBe(true);
        // 0.0003 on 3.6605 is ~0.008% — well under the 0.1% limit.
        expect(isEssentiallyOptimal('max', 3.6605, 3.6608)).toBe(true);
        // 0.5 on 1000 is 0.05% — under the limit.
        expect(isEssentiallyOptimal('max', 1000, 1000.5)).toBe(true);
    });
    it('exactly 0.1% improvement is not negligible', () => {
        // 1 on 1000 is exactly 0.1%: the limit is a strict less-than.
        expect(isEssentiallyOptimal('max', 1000, 1001)).toBe(false);
    });
    it('a starting objective of 0 uses the absolute floor', () => {
        expect(isEssentiallyOptimal('max', 0, 0)).toBe(true);
        expect(isEssentiallyOptimal('max', 0, 1e-10)).toBe(true);
        expect(isEssentiallyOptimal('max', 0, 0.5)).toBe(false);
    });
});

describe('isEssentiallyOptimal — Min', () => {
    it('a clear improvement is not already optimal', () => {
        expect(isEssentiallyOptimal('min', 1.0, 0.5)).toBe(false);
        expect(isEssentiallyOptimal('min', 0, -0.5)).toBe(false);
    });
    it('a barely improved objective is already optimal', () => {
        expect(isEssentiallyOptimal('min', 0.5, 0.5)).toBe(true);
        // 0.0001 on 0.5 is 0.02% — under the limit.
        expect(isEssentiallyOptimal('min', 0.5, 0.4999)).toBe(true);
    });
});

describe('isEssentiallyOptimal — Value Of', () => {
    it('closing most of the distance to the target is not already optimal', () => {
        expect(isEssentiallyOptimal('value', 8, 9.9, 10)).toBe(false);
    });
    it('barely closing the distance is already optimal', () => {
        // 0.0000005 of a 0.01 starting distance is 0.005%.
        expect(isEssentiallyOptimal('value', 9.99, 9.9900005, 10)).toBe(true);
    });
    it('starting at the target is already optimal', () => {
        expect(isEssentiallyOptimal('value', 10, 10, 10)).toBe(true);
        expect(isEssentiallyOptimal('value', 10, 10.0000000001, 10)).toBe(true);
    });
    it('needs a target to judge', () => {
        expect(isEssentiallyOptimal('value', 8, 9.9, null)).toBe(false);
    });
});

describe('isEssentiallyOptimal — the objective moving the wrong way', () => {
    it('is not already optimal when the start was infeasible', () => {
        // Minimizing x^2+y^2 from (0, 0) under x+y>=1 moves the objective
        // 0 -> 0.5: the start violated the constraint, so the solver had
        // to trade objective for feasibility. The harness caught this:
        // an early version returned true here and showed the note after
        // a genuine improvement.
        expect(isEssentiallyOptimal('min', 0, 0.5)).toBe(false);
    });
    it('is not already optimal when the objective gets worse', () => {
        expect(isEssentiallyOptimal('max', 1.0, 0.9)).toBe(false);
        // Value Of: the distance to the target did not close (2 -> 2)
        // even though the values moved a long way (8 -> 12).
        expect(isEssentiallyOptimal('value', 8, 12, 10)).toBe(false);
    });
});

describe('isEssentiallyOptimal — missing or non-finite values', () => {
    it('never shows the note without both objectives', () => {
        expect(isEssentiallyOptimal('max', null, 1)).toBe(false);
        expect(isEssentiallyOptimal('max', 1, null)).toBe(false);
        expect(isEssentiallyOptimal('max', Number.NaN, 1)).toBe(false);
        expect(isEssentiallyOptimal('max', 1, Number.POSITIVE_INFINITY)).toBe(false);
    });
});
