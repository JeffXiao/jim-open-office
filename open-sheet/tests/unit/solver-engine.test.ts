/**
 * Unit tests for the Solver engine (src/solver/engine.ts).
 * Pure optimizer — no Univer, no DOM. Every problem here has a known
 * answer, checked against the answer itself or an independent grid search.
 * The risk-adjusted return test uses a ratio objective, not any
 * app-visible content: the word for that ratio never appears in the app.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { createSolver, numericalGradient } from '../../src/solver/engine';
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

    it('maximizes an asymmetric three-asset ratio with a projector, matching a grid search', async () => {
        // Regression for the projector gradient bias: three assets
        // with different returns, volatilities and correlations, so
        // the optimum is asymmetric (0.356, 0.274, 0.370 — the
        // tangency portfolio) and sits on the sum boundary. The
        // symmetric problems mask the bias — at their optima the
        // projected-gradient mapping vanishes by symmetry — but here
        // a biased gradient stalls short of the optimum (the pre-fix
        // engine stopped at 3.6593 on the real file's asymmetric
        // optimum instead of 3.6605). The oracle is a fine grid over
        // the 2-simplex.
        const mu = [0.12, 0.08, 0.05];
        const sigma = [0.2, 0.15, 0.1];
        const rho = [
            [1, 0.3, 0.1],
            [0.3, 1, 0.2],
            [0.1, 0.2, 1],
        ];
        const riskFree = 0.02;
        const ratio = (w: number[]): number => {
            const ret =
                (w[0] ?? 0) * (mu[0] ?? 0) +
                (w[1] ?? 0) * (mu[1] ?? 0) +
                (w[2] ?? 0) * (mu[2] ?? 0);
            let variance = 0;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    variance +=
                        (w[i] ?? 0) *
                        (w[j] ?? 0) *
                        (sigma[i] ?? 0) *
                        (sigma[j] ?? 0) *
                        (rho[i]?.[j] ?? 0);
                }
            }
            return (ret - riskFree) / Math.sqrt(variance);
        };
        // Independent oracle: a fine grid over the 2-simplex
        // (w0, w1, w2 = 1 - w0 - w1).
        let gridBestW: number[] = [0, 0, 1];
        let gridBestRatio = Number.NEGATIVE_INFINITY;
        const step = 0.002;
        for (let i = 0; i <= 1 / step; i++) {
            for (let j = 0; j <= 1 / step - i; j++) {
                const w = [i * step, j * step, 1 - i * step - j * step];
                const value = ratio(w);
                if (value > gridBestRatio) {
                    gridBestRatio = value;
                    gridBestW = w;
                }
            }
        }
        const project = (point: number[]): number[] => {
            const capped = point.map((value) => Math.min(0.6, Math.max(0, value)));
            const sum = capped.reduce((a, b) => a + b, 0);
            if (sum <= 1) {
                return capped;
            }
            const factor = 1 / sum;
            return capped.map((value) => value * factor);
        };
        const solver = await createSolver({
            goal: 'max',
            initial: [0.3, 0.3, 0.3],
            lowerBounds: [0, 0, 0],
            upperBounds: [null, null, null],
            evaluate: (w: number[]): SolverEvaluation => ({
                objective: ratio(w),
                violations: [
                    Math.max(0, (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0) - 1),
                    Math.max(0, (w[0] ?? 0) - 0.6),
                    Math.max(0, (w[1] ?? 0) - 0.6),
                    Math.max(0, (w[2] ?? 0) - 0.6),
                ],
            }),
            project,
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(gridBestRatio, 3);
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(gridBestW[0] ?? 0, 2);
        expect(state.bestX[1] ?? Number.NaN).toBeCloseTo(gridBestW[1] ?? 0, 2);
        expect(state.bestX[2] ?? Number.NaN).toBeCloseTo(gridBestW[2] ?? 0, 2);
        expect(state.bestX.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    });

    it('stops a flat problem early via the stagnation limit, keeping the answer', async () => {
        // 19-variable shallow quadratic: the total improvement
        // available (19e-8) is below the convergence tolerance, so no
        // improvement is ever "meaningful" and the gradient is already
        // below the stationarity threshold at the start — the gradient
        // engine converges there in a couple of iterations, with or
        // without the stagnation limit. The regression this guards is
        // the old Nelder-Mead behaviour: a flat 19-variable portfolio
        // problem found its best at step 60 and then ground 9940
        // iterations without improving it; the stop ended that run at
        // ~5060 iterations with the identical answer. The assertions
        // that survive the engine change: both runs report optimal
        // with the same (near-zero) answer, and the limited run ends
        // early — the gradient engine converges directly, so the
        // unlimited run is fast too (it used to grind past 1000
        // iterations).
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
        expect(full.iterations).toBeLessThanOrEqual(150);
        expect(limited.bestObjective ?? Number.NaN).toBeCloseTo(
            full.bestObjective ?? Number.NaN,
            6,
        );
    });

    it('never evaluates an infeasible point when a projector is supplied', async () => {
        // Maximize -(x-0.7)^2-(y-0.7)^2 subject to x+y<=1, x,y>=0.
        // The unconstrained optimum (0.7, 0.7) sums to 1.4, so the
        // simplex's expansions would probe totals over 1 — the live
        // report was a total of 112.14% mid-solve. With the projector
        // every evaluated point is feasible, and the answer is still
        // the boundary optimum (0.5, 0.5), objective -0.08.
        const seen: number[][] = [];
        const project = (point: number[]): number[] => {
            const clamped = point.map((value) => Math.max(0, value));
            const sum = (clamped[0] ?? 0) + (clamped[1] ?? 0);
            if (sum <= 1) {
                return clamped;
            }
            const factor = 1 / sum;
            return clamped.map((value) => value * factor);
        };
        const solver = await createSolver({
            goal: 'max',
            initial: [0.4, 0.4],
            lowerBounds: [0, 0],
            upperBounds: [null, null],
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => {
                seen.push([x, y]);
                return {
                    objective: -((x - 0.7) ** 2 + (y - 0.7) ** 2),
                    violations: [Math.max(0, x + y - 1)],
                };
            },
            project,
        });
        await runToCompletion(solver);
        expect(seen.length).toBeGreaterThan(0);
        for (const [x = 0, y = 0] of seen) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(x + y).toBeLessThanOrEqual(1 + 1e-9);
        }
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(-0.08, 3);
        expect(state.bestX[0] ?? Number.NaN).toBeCloseTo(0.5, 2);
        expect(state.bestX[1] ?? Number.NaN).toBeCloseTo(0.5, 2);
    });

    it('reports optimal (not max-iterations) for a projected 19-variable ratio', async () => {
        // Same 19-variable ratio as above, but with the projector
        // applied: every trial is clamped to >= 0, capped at 0.2 and
        // scaled so the sum never exceeds 1 — the live Problem 2
        // shape. The gradient engine reaches the boundary optimum in
        // a single iteration (the first line search jumps there) and
        // finishes in 3 iterations / 118 evaluations; the old
        // Nelder-Mead run used the full iteration budget before the
        // cap-time polish, which is why this test used to need longer
        // than the default timeout.
        const n = 19;
        const seen: number[][] = [];
        const ratio = (w: number[]): number => {
            const sum = w.reduce((a, b) => a + b, 0);
            const squares = w.reduce((a, b) => a + b * b, 0);
            return (0.08 * sum - 0.02) / (0.2 * Math.sqrt(squares));
        };
        const project = (point: number[]): number[] => {
            const capped = point.map((value) => Math.min(0.2, Math.max(0, value)));
            const sum = capped.reduce((a, b) => a + b, 0);
            if (sum <= 1) {
                return capped;
            }
            const factor = 1 / sum;
            return capped.map((value) => value * factor);
        };
        const solver = await createSolver({
            goal: 'max',
            initial: Array.from({ length: n }, () => 0.05),
            lowerBounds: Array.from({ length: n }, () => 0),
            upperBounds: Array.from({ length: n }, () => null),
            evaluate: (w: number[]): SolverEvaluation => {
                seen.push([...w]);
                return {
                    objective: ratio(w),
                    violations: [
                        Math.max(0, w.reduce((a, b) => a + b, 0) - 1),
                        ...w.map((v) => Math.max(0, v - 0.2)),
                    ],
                };
            },
            project,
        });
        await runToCompletion(solver);
        expect(seen.length).toBeGreaterThan(0);
        for (const w of seen) {
            expect(w.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
            for (const value of w) {
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(0.2 + 1e-9);
            }
        }
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(0.3 * Math.sqrt(19), 3);
        for (const weight of state.bestX) {
            expect(weight).toBeCloseTo(1 / 19, 2);
        }
    }, 60000);

    it('matches an analytic gradient (central differences)', async () => {
        // f(x, y) = (x - 1)^2 + 3(y + 2)^2: analytic gradient
        // (2(x - 1), 6(y + 2)). The finite-difference gradient must
        // agree to ~1e-5 at an ordinary point, and the one-sided
        // fallback must stay small where the function is unevaluable
        // on one side (f(x) = x^2 for x >= 0, null below: the true
        // derivative at 0 is 0, the one-sided difference gives h).
        const fn = ([x = 0, y = 0]: number[]): number | null =>
            (x - 1) ** 2 + 3 * (y + 2) ** 2;
        const gradient = numericalGradient(fn, [0.5, 1], fn([0.5, 1]), CONFIG.SOLVER_GRAD_STEP);
        expect(gradient[0] ?? Number.NaN).toBeCloseTo(-1, 5);
        expect(gradient[1] ?? Number.NaN).toBeCloseTo(18, 5);
        const oneSided = numericalGradient(
            ([x = 0]: number[]): number | null => (x < 0 ? null : x * x),
            [0],
            0,
            CONFIG.SOLVER_GRAD_STEP,
        );
        expect(Math.abs(oneSided[0] ?? Number.NaN)).toBeLessThan(1e-3);
    });

    it('reaches the 19-variable ratio optimum in a handful of gradient iterations', async () => {
        // Headline regression: Nelder-Mead took 10,000 iterations /
        // 18,625 evaluations for this problem (reaching the optimum's
        // neighbourhood at iteration 147 from the 0.05 start and 3195
        // from the 0.8764/19 start). The gradient engine reaches it in
        // 1 iteration and finishes in 3, with 118 evaluations. The
        // bounds below have wide headroom over the measured 3/118.
        const n = 19;
        const ratio = (w: number[]): number => {
            const sum = w.reduce((a, b) => a + b, 0);
            const squares = w.reduce((a, b) => a + b * b, 0);
            return (0.08 * sum - 0.02) / (0.2 * Math.sqrt(squares));
        };
        const project = (point: number[]): number[] => {
            const capped = point.map((value) => Math.min(0.2, Math.max(0, value)));
            const sum = capped.reduce((a, b) => a + b, 0);
            if (sum <= 1) {
                return capped;
            }
            const factor = 1 / sum;
            return capped.map((value) => value * factor);
        };
        for (const start of [0.05, 0.8764 / 19]) {
            const solver = await createSolver({
                goal: 'max',
                initial: Array.from({ length: n }, () => start),
                lowerBounds: Array.from({ length: n }, () => 0),
                upperBounds: Array.from({ length: n }, () => null),
                evaluate: (w: number[]): SolverEvaluation => ({
                    objective: ratio(w),
                    violations: [
                        Math.max(0, w.reduce((a, b) => a + b, 0) - 1),
                        ...w.map((v) => Math.max(0, v - 0.2)),
                    ],
                }),
                project,
            });
            await runToCompletion(solver);
            const state = solver.getState();
            expect(state.status).toBe('optimal');
            expect(state.iterations).toBeLessThanOrEqual(20);
            expect(state.evaluations).toBeLessThanOrEqual(500);
            expect(state.bestObjective ?? Number.NaN).toBeCloseTo(0.3 * Math.sqrt(19), 3);
            for (const weight of state.bestX) {
                expect(weight).toBeCloseTo(1 / 19, 2);
            }
        }
    });

    it('Nelder-Mead fallback still solves the 19-variable ratio', async () => {
        // The fallback path (method 'nelder-mead') keeps the old
        // engine available: same problem, same answer, slower.
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
            method: 'nelder-mead',
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(0.3 * Math.sqrt(19), 3);
        for (const weight of state.bestX) {
            expect(weight).toBeCloseTo(1 / 19, 2);
        }
    }, 60000);

    it('evaluates infeasible points without a projector (negative control)', async () => {
        // The same problem, no projector: the simplex must probe
        // totals over 1 on its way to the boundary optimum. This is
        // the control proving the test above would catch the old
        // behaviour — it is not a failure of the penalty method,
        // which still finds the answer.
        const seen: number[][] = [];
        const solver = await createSolver({
            goal: 'max',
            initial: [0.4, 0.4],
            lowerBounds: [0, 0],
            upperBounds: [null, null],
            evaluate: ([x = 0, y = 0]: number[]): SolverEvaluation => {
                seen.push([x, y]);
                return {
                    objective: -((x - 0.7) ** 2 + (y - 0.7) ** 2),
                    violations: [Math.max(0, x + y - 1)],
                };
            },
        });
        await runToCompletion(solver);
        expect(seen.some(([x = 0, y = 0]) => x + y > 1)).toBe(true);
        const state = solver.getState();
        expect(state.status).toBe('optimal');
        expect(state.bestObjective ?? Number.NaN).toBeCloseTo(-0.08, 3);
    });

    it('reports infeasible (not max-iterations) when no feasible point exists', async () => {
        // Maximize x subject to x <= -1 with x >= 0: no point satisfies
        // both. The iteration cap is the one path that could report
        // max-iterations with no feasible point saved — and the caller
        // writes the saved best back on max-iterations, so that would
        // put an infeasible "solution" in the sheet. The saved best
        // must only ever hold a feasible allocation, so the run is
        // infeasible instead and the caller restores the originals.
        // maxIterations 1 forces the cap path deterministically: the
        // first step cannot converge the simplex, so the second step
        // hits the cap.
        const solver = await createSolver({
            goal: 'max',
            initial: [0],
            lowerBounds: [0],
            upperBounds: [null],
            evaluate: ([x = 0]: number[]): SolverEvaluation => ({
                objective: x,
                violations: [Math.max(0, x + 1)],
            }),
            maxIterations: 1,
        });
        await runToCompletion(solver);
        const state = solver.getState();
        expect(state.status).toBe('infeasible');
        expect(state.bestViolation).toBeGreaterThan(1e-6);
    });
});
