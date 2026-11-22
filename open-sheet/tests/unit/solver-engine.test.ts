/**
 * Unit tests for the Solver engine (src/solver/engine.ts).
 * Pure optimizer — no Univer, no DOM. Every problem here has a known
 * answer, checked against the answer itself or an independent grid search.
 * The risk-adjusted return test uses a ratio objective, not any
 * app-visible content: the word for that ratio never appears in the app.
 */
import { describe, expect, it } from 'vitest';
import { createSolver } from '../../src/solver/engine';
import type { SolverEvaluation } from '../../src/solver/engine';

/** Drive a solver to completion (safety cap guards against a hung engine). */
async function runToCompletion(solver: Awaited<ReturnType<typeof createSolver>>): Promise<void> {
    for (let i = 0; i < 50000; i++) {
        if (await solver.step()) {
            return;
        }
    }
    throw new Error('Solver did not finish within 50000 steps.');
}

const NO_BOUNDS: (number | null)[] = [null, null];

describe('createSolver', () => {
    it('minimizes Rosenbrock to (1, 1)', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0, 0],
            lowerBounds: NO_BOUNDS,
            upperBounds: NO_BOUNDS,
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => ({
                objective: (1 - x) ** 2 + 100 * (y - x * x) ** 2,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeLessThan(1e-6);
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(1, 3);
        expect(state.bestX[1] ?? Number.NaN).toBeCloseTo(1, 3);
    });

    it('minimizes a quadratic to (3, -2)', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0, 0],
            lowerBounds: NO_BOUNDS,
            upperBounds: NO_BOUNDS,
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => ({
                objective: (x - 3) ** 2 + (y + 2) ** 2,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(3, 3);
        expect(state.bestX[1] ?? Number.NaN).toBeCloseTo(-2, 3);
    });

    it('solves a constrained problem: min x^2+y^2 s.t. x+y>=1 is (0.5, 0.5)', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0, 0],
            lowerBounds: NO_BOUNDS,
            upperBounds: NO_BOUNDS,
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => ({
                objective: x * x + y * y,
                violations: [Math.max(0, 1 - (x + y))],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestViolation).toBeLessThanOrEqual(1e-6);
        // The objective is flat near the optimum (quadratic), so the
        // coordinates land within ~1e-3 while the objective is exact.
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(0.5, 2);
        expect(state.bestX[1] ?? Number.NaN).toBeCloseTo(0.5, 2);
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(0.5, 3);
    });

    it('respects bounds: min (x+1)^2 with x>=0 stops at the boundary 0', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [2],
            lowerBounds: [0],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                objective: (x + 1) ** 2,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(0, 3);
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(1, 3);
    });

    it('clamps a start outside the bounds into the box', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [-5],
            lowerBounds: [0],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                objective: (x - 1) ** 2,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(1, 3);
    });

    it('solves a single-variable problem', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0],
            lowerBounds: [null],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                objective: (x - 4) ** 2,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(4, 3);
    });

    it('reports infeasible when the constraints cannot all hold', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0],
            lowerBounds: [null],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                objective: x,
                violations: [Math.max(0, 1 - x), Math.max(0, x - 0)],
            }),
        });
        await runToCompletion(solver);
        expect(solver.getState().status).toBe('infeasible');
    });

    it('reports max-iterations when the budget runs out', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0, 0],
            lowerBounds: NO_BOUNDS,
            upperBounds: NO_BOUNDS,
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => ({
                objective: (1 - x) ** 2 + 100 * (y - x * x) ** 2,
                violations: [],
            }),
            maxIterations: 5,
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('max-iterations');
        expect(state.iterations).toBeLessThanOrEqual(5);
    });

    it('reports unbounded when the objective runs away', async () => {
        const solver = await createSolver({
            goal: 'max',
            initial: [0],
            lowerBounds: [0],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                objective: x,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        expect(solver.getState().status).toBe('unbounded');
    });

    it('survives non-finite objective values without crashing', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [1],
            lowerBounds: [null],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                // Unevaluable left of zero; a clean minimum at x = 2.
                objective: x < 0 ? null : (x - 2) ** 2,
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(2, 3);
    });

    it('cancels mid-run and reports cancelled', async () => {
        const solver = await createSolver({
            goal: 'min',
            initial: [0, 0],
            lowerBounds: NO_BOUNDS,
            upperBounds: NO_BOUNDS,
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => ({
                objective: (1 - x) ** 2 + 100 * (y - x * x) ** 2,
                violations: [],
            }),
        });
        expect(solver.getState().status).toBe('running');
        expect(await solver.step()).toBe(false);
        solver.cancel();
        expect(await solver.step()).toBe(true);
        expect(solver.getState().status).toBe('cancelled');
    });

    it('maximizes a two-asset risk-adjusted return ratio, matching a grid search', async () => {
        const returns = [0.1, 0.06];
        const volatilities = [0.15, 0.1];
        const riskFree = 0.02;
        const ratio = (w: number): number => {
            const ret = w * (returns[0] ?? 0) + (1 - w) * (returns[1] ?? 0);
            const risk = Math.sqrt(
                (w * (volatilities[0] ?? 0)) ** 2 + ((1 - w) * (volatilities[1] ?? 0)) ** 2,
            );
            return (ret - riskFree) / risk;
        };
        // Independent oracle: a fine grid over w in [0, 1].
        let gridBestW = 0;
        let gridBestRatio = Number.NEGATIVE_INFINITY;
        for (let i = 0; i <= 2000; i++) {
            const w = i / 2000;
            const value = ratio(w);
            if (value > gridBestRatio) {
                gridBestRatio = value;
                gridBestW = w;
            }
        }
        const solver = await createSolver({
            goal: 'max',
            initial: [0.5],
            lowerBounds: [0],
            upperBounds: [1],
            evaluate: ([w = 0]: number[]): SolverEvaluation => ({
                objective: ratio(w),
                violations: [],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(gridBestRatio, 3);
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(gridBestW, 2);
    });

    it('maximizes a 19-variable ratio with a sum constraint and a per-variable cap', async () => {
        // Nineteen identical assets: the optimum splits evenly (1/19 each),
        // sum 1, each under the 0.2 cap. Same shape as the real problem:
        // the optimum sits on the sum boundary, where the simplex alone
        // stalls and the transfer polish has to finish the job.
        const n = 19;
        const ratio = (w: number[]): number => {
            const sum = w.reduce((a, b) => a + b, 0);
            const squares = w.reduce((a, b) => a + b * b, 0);
            return (0.08 * sum - 0.02) / (0.2 * Math.sqrt(squares));
        };
        const solver = await createSolver({
            goal: 'max',
            initial: Array.from({ length: n }, () => 0.05),
            lowerBounds: Array.from({ length: n }, () => 0),
            upperBounds: Array.from({ length: n }, () => null),
            evaluate: (w: number[]): SolverEvaluation => ({
                objective: ratio(w),
                violations: [
                    Math.max(0, w.reduce((a, b) => a + b, 0) - 1),
                    ...w.map((v) => Math.max(0, v - 0.2)),
                ],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(0.3 * Math.sqrt(19), 3);
        for (const weight of state.bestX) {
            expect(weight).toBeCloseTo(1 / 19, 2);
        }
    });

    it('maximizes a ratio with a sum constraint and a per-variable cap', async () => {
        // Three identical assets: the optimum splits evenly (1/3 each),
        // sum 1, each under the 0.5 cap. Same shape as the real problem.
        const ratio = (w: number[]): number => {
            const sum = w[0] + w[1] + w[2];
            const squares = w[0] ** 2 + w[1] ** 2 + w[2] ** 2;
            return (0.08 * sum - 0.02) / (0.2 * Math.sqrt(squares));
        };
        const solver = await createSolver({
            goal: 'max',
            initial: [0.1, 0.1, 0.1],
            lowerBounds: [0, 0, 0],
            upperBounds: [null, null, null],
            evaluate: (w: number[]): SolverEvaluation => ({
                objective: ratio(w),
                violations: [
                    Math.max(0, (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0) - 1),
                    Math.max(0, (w[0] ?? 0) - 0.5),
                    Math.max(0, (w[1] ?? 0) - 0.5),
                    Math.max(0, (w[2] ?? 0) - 0.5),
                ],
            }),
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestViolation).toBeLessThanOrEqual(1e-6);
        for (const weight of state.bestX) {
            expect(weight).toBeCloseTo(1 / 3, 2);
        }
    });

    it('stops a flat problem early via the stagnation limit, keeping the answer', async () => {
        // 19-variable shallow quadratic: the total improvement
        // available (19e-8) is below the convergence tolerance, so no
        // improvement is ever "meaningful" and the stagnation clock
        // never resets. Without the stop the run grinds to natural
        // convergence (6818 iterations); with a small limit it ends at
        // the limit with the best essentially at the true minimum (0).
        // Regression: a flat 19-variable portfolio problem found its
        // best at step 60 and then ground 9940 iterations without
        // improving it; the stop ends that run at ~5060 iterations
        // with the identical answer.
        const n = 19;
        const objective = (x: number[]): number =>
            1e-8 * x.reduce((a, v) => a + (v - 1) ** 2, 0);
        const run = async (stagnationLimit: number) => {
            const solver = await createSolver({
                goal: 'min',
                initial: Array.from({ length: n }, () => 0),
                lowerBounds: Array.from({ length: n }, () => null),
                upperBounds: Array.from({ length: n }, () => null),
                evaluate: (x: number[]): SolverEvaluation => ({
                    objective: objective(x),
                    violations: [],
                }),
                stagnationLimit,
            });
            await runToCompletion(solver);
            return solver.getState();
        };
        const limited = await run(100);
        expect(limited.status).toBe('optimal');
        expect(limited.iterations).toBeLessThanOrEqual(150);
        expect(limited.bestObjective ?? Number.NaN).toBeLessThan(1e-6);
        const full = await run(100000);
        expect(full.status).toBe('optimal');
        expect(full.iterations).toBeGreaterThan(1000);
        expect(limited.bestObjective ?? Number.NaN).toBeCloseTo(
            full.bestObjective ?? Number.NaN,
            6,
        );
    });
});
