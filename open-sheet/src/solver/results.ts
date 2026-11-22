/**
 * "Already optimal" decision for the Solver results view: did the solve
 * barely improve the objective, so the starting values were already
 * (near-)optimal? Pure — no Univer, no DOM.
 *
 * The rule: the improvement is negligible when it is less than 0.1% of
 * the starting objective's magnitude, with an absolute floor (|after -
 * before| <= 1e-9) so a starting objective of 0 still works.
 * "Improvement" is goal-relative: Max gains (after - before), Min saves
 * (before - after), Value Of closes the distance to the target
 * (|before - target| - |after - target|).
 *
 * An improvement that is zero or negative is NOT "already optimal":
 * the objective moving the wrong way means the start was infeasible
 * (the solver traded objective for feasibility — e.g. minimizing
 * x^2+y^2 from (0, 0) under x+y>=1 moves the objective 0 -> 0.5),
 * not that it was optimal. The only exception is no move at all,
 * caught by the absolute floor above.
 */
export type SolverGoal = 'max' | 'min' | 'value';

/** Relative improvement below this counts as negligible (0.1%). */
const RELATIVE_IMPROVEMENT_LIMIT = 0.001;

/** An objective move this small counts as no move at all. */
const ABSOLUTE_IMPROVEMENT_FLOOR = 1e-9;

export function isEssentiallyOptimal(
    goal: SolverGoal,
    before: number | null,
    after: number | null,
    target: number | null = null,
): boolean {
    if (before === null || after === null) {
        return false;
    }
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
        return false;
    }
    // The objective did not move at all (covers a starting value of 0).
    if (Math.abs(after - before) <= ABSOLUTE_IMPROVEMENT_FLOOR) {
        return true;
    }
    let improvement: number;
    let reference: number;
    if (goal === 'max') {
        improvement = after - before;
        reference = Math.abs(before);
    } else if (goal === 'min') {
        improvement = before - after;
        reference = Math.abs(before);
    } else {
        if (target === null || !Number.isFinite(target)) {
            return false;
        }
        improvement = Math.abs(before - target) - Math.abs(after - target);
        reference = Math.abs(before - target);
    }
    if (!Number.isFinite(improvement)) {
        return false;
    }
    // The objective went the wrong way: the start was infeasible (the
    // solver traded objective for feasibility), not optimal.
    if (improvement <= 0) {
        return false;
    }
    if (reference === 0) {
        return improvement <= ABSOLUTE_IMPROVEMENT_FLOOR;
    }
    return improvement < RELATIVE_IMPROVEMENT_LIMIT * reference;
}
