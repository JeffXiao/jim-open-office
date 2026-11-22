/**
 * Pure optimizer: Nelder-Mead simplex, wrapped in a quadratic-penalty
 * method for constraints. No Univer dependency, no DOM — the sheet bridge
 * (src/solver/model.ts) supplies the evaluate function.
 *
 * Stepwise and asynchronous: createSolver(...) returns a Solver with an
 * async step() (one simplex iteration per call; the UI drives it in
 * slices so the page stays responsive). step() is async because the
 * sheet's formula engine recalculates asynchronously after a write —
 * evaluate may return a Promise, and the engine awaits it. Evaluations
 * always run strictly one at a time, in order, so a sheet-backed
 * evaluate never has two trial vectors in flight at once.
 *
 * How it works, briefly:
 * - The goal is turned into a minimization (maximize f == minimize -f).
 * - Constraints enter through a penalty: penalized(x) = g(x) + rho * sum of
 *   squared violations. rho grows each outer round, pulling the search
 *   toward feasible points.
 * - Bounds are enforced by clamping trial points into the box.
 * - When a `project` function is supplied, trial points are first mapped
 *   onto the feasible set (before they are evaluated or stored as a
 *   simplex vertex), so no infeasible trial is ever written to the
 *   sheet; the penalty remains the backstop for constraints the
 *   projector cannot express.
 * - Non-finite objective values are treated as a large penalty, never a crash.
 * - After the penalty rounds, a transfer polish (see startPolish) slides
 *   the best feasible point along a sum boundary, the move Nelder-Mead
 *   cannot make from a boundary point.
 */
import { CONFIG } from '../config';

export type SolverGoal = 'max' | 'min';

export type SolverStatus =
    | 'running'
    | 'optimal'
    | 'max-iterations'
    | 'infeasible'
    | 'unbounded'
    | 'cancelled';

export type SolverEvaluation = {
    /** Objective value; null means "could not be evaluated". */
    objective: number | null;
    /** One entry per constraint: 0 = satisfied, > 0 = amount violated. */
    violations: number[];
};

export type SolverOptions = {
    goal: SolverGoal;
    initial: number[];
    lowerBounds: (number | null)[];
    upperBounds: (number | null)[];
    /** May be synchronous (pure tests) or async (sheet-backed: the formula
     * engine recalculates after a write, so the bridge awaits the recalc). */
    evaluate: (x: number[]) => SolverEvaluation | Promise<SolverEvaluation>;
    /**
     * Optional feasibility projection: maps each trial point onto the
     * feasible set before it is evaluated — and before it is stored
     * as a simplex vertex, so the engine's view of the search space
     * stays consistent with what was actually evaluated. The sheet
     * bridge supplies this from the constraints; without it, an
     * infeasible trial is written to the sheet and only discouraged
     * by the penalty, so the sheet shows it breaking a rule mid-solve.
     */
    project?: (x: number[]) => number[];
    maxIterations?: number;
    tolerance?: number;
    /** Override CONFIG.SOLVER_STAGNATION_LIMIT (for tests). */
    stagnationLimit?: number;
};

export type SolverState = {
    status: SolverStatus;
    iterations: number;
    evaluations: number;
    /** Best point found (best feasible, else least violating). */
    bestX: number[];
    /** Unpenalized objective at bestX; null when nothing finite was found. */
    bestObjective: number | null;
    /** Largest constraint violation at bestX; 0 = feasible. */
    bestViolation: number;
    message: string;
};

export type Solver = {
    /** Run one simplex iteration. Returns true when the solve is finished. */
    step: () => Promise<boolean>;
    getState: () => SolverState;
    cancel: () => void;
};

const STATUS_MESSAGES: Record<Exclude<SolverStatus, 'running'>, string> = {
    optimal: 'Solver found a solution.',
    'max-iterations':
        'Solver stopped at the iteration limit — the result may not be optimal.',
    infeasible: 'No feasible solution was found.',
    unbounded: 'The objective improves without bound — no optimum exists.',
    cancelled: 'Solver cancelled.',
};

/** One evaluated point, kept for the final answer. */
type Candidate = {
    x: number[];
    objective: number;
    violation: number;
};

export async function createSolver(options: SolverOptions): Promise<Solver> {
    const dimension = options.initial.length;
    if (dimension === 0) {
        throw new Error('Solver needs at least one changing cell.');
    }
    if (
        options.lowerBounds.length !== dimension ||
        options.upperBounds.length !== dimension
    ) {
        throw new Error('Solver bounds must match the number of changing cells.');
    }
    for (let i = 0; i < dimension; i++) {
        const lower = options.lowerBounds[i];
        const upper = options.upperBounds[i];
        if (lower !== null && lower !== undefined && upper !== null && upper !== undefined && lower > upper) {
            throw new Error('Solver lower bound is above the upper bound.');
        }
    }
    const maxIterations = options.maxIterations ?? CONFIG.SOLVER_MAX_ITERATIONS;
    const tolerance = options.tolerance ?? CONFIG.SOLVER_TOLERANCE;
    const stagnationLimit = options.stagnationLimit ?? CONFIG.SOLVER_STAGNATION_LIMIT;

    /** Project a trial point onto the feasible set (identity when no projector). */
    const projectPoint = (point: number[]): number[] =>
        options.project ? options.project(point) : point;

    let status: SolverStatus = 'running';
    let iterations = 0;
    let evaluations = 0;
    let outerRound = 0;
    let rho = CONFIG.SOLVER_INITIAL_PENALTY;
    let previousRoundObjective: number | null = null;
    let cancelled = false;
    let finished = false;

    let bestFeasible: Candidate | null = null;
    let bestInfeasible: Candidate | null = null;

    /**
     * Stagnation tracking: the iteration and objective of the last
     * meaningful improvement to the best feasible point. A meaningful
     * improvement is one larger than the convergence tolerance (same
     * test as the outer-round "improved" check). When the best has
     * not improved meaningfully for SOLVER_STAGNATION_LIMIT simplex
     * iterations, the solve is treated as converged — the simplex is
     * grinding on a flat surface and further rounds will not move it.
     * This is a global counter (not reset per outer round), so a
     * problem that improves late still gets its full window.
     */
    let lastImprovementIteration = 0;
    let lastImprovementValue: number | null = null;

    const isBetter = (a: number, b: number): boolean =>
        options.goal === 'max' ? a > b : a < b;

    /** Clamp a point into the bounds box (returns a new array). */
    const clamp = (point: number[]): number[] =>
        point.map((value, i) => {
            const lower = options.lowerBounds[i];
            const upper = options.upperBounds[i];
            let clamped = value;
            if (lower !== null && lower !== undefined) {
                clamped = Math.max(clamped, lower);
            }
            if (upper !== null && upper !== undefined) {
                clamped = Math.min(clamped, upper);
            }
            return clamped;
        });

    /** Penalized value of a point; records candidates and spots runaway goals. */
    const penalized = async (point: number[]): Promise<number> => {
        evaluations += 1;
        const evaluation = await options.evaluate(point);
        const violations = evaluation.violations.map((violation) =>
            Number.isFinite(violation)
                ? Math.max(0, violation)
                : CONFIG.SOLVER_MAX_VIOLATION,
        );
        const violation = violations.length === 0 ? 0 : Math.max(...violations);
        const objective = evaluation.objective;

        if (objective !== null && Number.isFinite(objective)) {
            if (
                (options.goal === 'max' && objective >= CONFIG.SOLVER_UNBOUNDED_VALUE) ||
                (options.goal === 'min' && objective <= -CONFIG.SOLVER_UNBOUNDED_VALUE)
            ) {
                finish('unbounded');
                return CONFIG.SOLVER_NON_FINITE_PENALTY;
            }
            const candidate: Candidate = { x: [...point], objective, violation };
            if (violation <= CONFIG.SOLVER_FEASIBILITY_TOLERANCE) {
                if (bestFeasible === null || isBetter(objective, bestFeasible.objective)) {
                    bestFeasible = candidate;
                    // Reset the stagnation clock only on a meaningful
                    // improvement; micro-improvements below the
                    // tolerance do not count as progress.
                    if (
                        lastImprovementValue === null ||
                        Math.abs(objective - lastImprovementValue) >
                            tolerance * (1 + Math.abs(objective))
                    ) {
                        lastImprovementValue = objective;
                        lastImprovementIteration = iterations;
                    }
                }
            } else if (
                bestInfeasible === null ||
                violation < bestInfeasible.violation ||
                (violation === bestInfeasible.violation &&
                    isBetter(objective, bestInfeasible.objective))
            ) {
                bestInfeasible = candidate;
            }
        }

        const goalValue =
            objective === null || !Number.isFinite(objective)
                ? CONFIG.SOLVER_NON_FINITE_PENALTY
                : options.goal === 'max'
                  ? -objective
                  : objective;
        let penalty = 0;
        for (const violationAmount of violations) {
            penalty += violationAmount * violationAmount;
        }
        return goalValue + rho * penalty;
    };

    /**
     * End the run. The saved best is the best FEASIBLE point found: a
     * "solution" status (optimal, max-iterations) promises the caller
     * a point it may write back, so it is only ever reported when such
     * a point exists. When no feasible point was found — the start was
     * infeasible and no trial ever satisfied every constraint — the
     * run is infeasible instead, and the caller restores the originals
     * rather than writing back the least-violating infeasible point.
     * (The one path that could report max-iterations with no feasible
     * point is the iteration cap in step(), which does not check
     * first; the outer-round path already passes 'infeasible' there.)
     */
    const finish = (next: Exclude<SolverStatus, 'running'>): void => {
        if (finished) {
            return;
        }
        finished = true;
        status =
            bestFeasible === null && (next === 'optimal' || next === 'max-iterations')
                ? 'infeasible'
                : next;
    };

    /**
     * Initial simplex around a center: one vertex per axis, 10% steps.
     * Evaluated sequentially — a sheet-backed evaluate must never have
     * two trial vectors in flight at once.
     */
    const buildSimplex = async (
        center: number[],
    ): Promise<{ vertices: number[][]; values: number[] }> => {
        const vertices: number[][] = [projectPoint(clamp([...center]))];
        for (let i = 0; i < dimension; i++) {
            const vertex = [...center];
            const base = vertex[i] ?? 0;
            vertex[i] =
                base +
                (base === 0 ? CONFIG.SOLVER_STEP_FALLBACK : Math.abs(base) * CONFIG.SOLVER_STEP_FRACTION);
            vertices.push(projectPoint(clamp(vertex)));
        }
        const values: number[] = [];
        for (const vertex of vertices) {
            values.push(await penalized(vertex));
        }
        return { vertices, values };
    };

    let { vertices, values } = await buildSimplex(options.initial);

    /** Sort vertices best-first by penalized value. */
    const sortSimplex = (): void => {
        const order = values.map((_value, i) => i);
        order.sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
        vertices = order.map((i) => vertices[i] ?? []);
        values = order.map((i) => values[i] ?? 0);
    };
    sortSimplex();

    /** Largest coordinate spread across the simplex. */
    const simplexDiameter = (): number => {
        let diameter = 0;
        for (let j = 0; j < dimension; j++) {
            let low = Number.POSITIVE_INFINITY;
            let high = Number.NEGATIVE_INFINITY;
            for (const vertex of vertices) {
                const value = vertex[j] ?? 0;
                low = Math.min(low, value);
                high = Math.max(high, value);
            }
            diameter = Math.max(diameter, high - low);
        }
        return diameter;
    };

    /** Converged when the simplex is small and its values agree. */
    const converged = (): boolean => {
        const spread = Math.max(...values) - Math.min(...values);
        return spread <= tolerance && simplexDiameter() <= tolerance;
    };

    /**
     * Transfer polish state. After the penalty rounds, the best feasible
     * point is improved by moving weight between pairs of variables. A
     * transfer keeps the sum of the changing cells fixed, so it slides
     * along a sum boundary — the move Nelder-Mead cannot make from a
     * boundary point, where its reflections either cross the boundary or
     * move one variable alone. The polish runs when an infeasible point
     * near the boundary beats the best feasible objective — the signature
     * of a boundary optimum the simplex walked past — or, forced, at the
     * iteration cap, where the projection can leave no infeasible point
     * to signal it. Only feasible improvements are accepted. It runs
     * stepwise (a few pairs per step) so the UI stays responsive during
     * a long polish.
     */
    let polish: {
        point: number[];
        objective: number;
        startObjective: number;
        step: number;
        pairIndex: number;
        improvedInSweep: boolean;
        pendingStatus: Exclude<SolverStatus, 'running'>;
        startEvaluations: number;
    } | null = null;

    /** Begin the transfer polish, or finish at once when it cannot help.
     * With force=true the polish runs from the best feasible point even
     * when no infeasible point beats it — the projection can leave no
     * infeasible point at all, so the usual signal is absent. The polish
     * only accepts feasible improvements, so forcing it cannot make the
     * answer infeasible. */
    const startPolish = (
        pendingStatus: Exclude<SolverStatus, 'running'>,
        force = false,
    ): void => {
        if (bestFeasible === null) {
            finish(pendingStatus);
            return;
        }
        if (!force) {
            if (bestInfeasible === null) {
                finish(pendingStatus);
                return;
            }
            if (!isBetter(bestInfeasible.objective, bestFeasible.objective)) {
                finish(pendingStatus);
                return;
            }
            const gap = Math.abs(bestInfeasible.objective - bestFeasible.objective);
            if (gap <= tolerance * (1 + Math.abs(bestFeasible.objective))) {
                finish(pendingStatus);
                return;
            }
        }
        let step =
            Math.max(...bestFeasible.x.map((value) => Math.abs(value))) *
            CONFIG.SOLVER_STEP_FRACTION;
        if (step === 0 || !Number.isFinite(step)) {
            step = CONFIG.SOLVER_STEP_FALLBACK;
        }
        polish = {
            point: [...bestFeasible.x],
            objective: bestFeasible.objective,
            startObjective: bestFeasible.objective,
            step,
            pairIndex: 0,
            improvedInSweep: false,
            pendingStatus,
            startEvaluations: evaluations,
        };
    };

    /** Apply the polish result and finish the solve with its status. */
    const finishPolish = (): void => {
        if (polish === null) {
            return;
        }
        if (bestFeasible !== null && isBetter(polish.objective, bestFeasible.objective)) {
            bestFeasible = { x: polish.point, objective: polish.objective, violation: 0 };
        }
        let pendingStatus = polish.pendingStatus;
        if (
            pendingStatus === 'max-iterations' &&
            Math.abs(polish.objective - polish.startObjective) <=
                tolerance * (1 + Math.abs(polish.startObjective))
        ) {
            // The polish could not improve the starting point by a
            // meaningful amount: the simplex had already reached the
            // optimum and merely crawled there slowly — the projection
            // pins it to the boundary, so its diameter shrinks too
            // slowly to converge before the cap. The run is optimal,
            // not cut short.
            pendingStatus = 'optimal';
        }
        polish = null;
        finish(pendingStatus);
    };

    /** One chunk of the transfer polish; returns true when the solve is done. */
    const polishStep = async (): Promise<boolean> => {
        if (polish === null) {
            return true;
        }
        let processed = 0;
        while (processed < CONFIG.SOLVER_POLISH_PAIRS_PER_STEP) {
            if (evaluations - polish.startEvaluations >= CONFIG.SOLVER_POLISH_MAX_EVALUATIONS) {
                finishPolish();
                return true;
            }
            if (polish.pairIndex >= dimension * dimension) {
                // Sweep done: halve the step when nothing improved.
                if (!polish.improvedInSweep) {
                    polish.step /= 2;
                }
                polish.pairIndex = 0;
                polish.improvedInSweep = false;
                if (polish.step < tolerance) {
                    finishPolish();
                    return true;
                }
                continue;
            }
            const pair = polish.pairIndex;
            polish.pairIndex += 1;
            const i = Math.floor(pair / dimension);
            const j = pair % dimension;
            if (i === j) {
                continue;
            }
            const lowerI = options.lowerBounds[i];
            const upperJ = options.upperBounds[j];
            let amount = polish.step;
            if (lowerI !== null && lowerI !== undefined) {
                amount = Math.min(amount, (polish.point[i] ?? 0) - lowerI);
            }
            if (upperJ !== null && upperJ !== undefined) {
                amount = Math.min(amount, upperJ - (polish.point[j] ?? 0));
            }
            if (amount <= 0) {
                continue;
            }
            const trialBase = [...polish.point];
            trialBase[i] = (trialBase[i] ?? 0) - amount;
            trialBase[j] = (trialBase[j] ?? 0) + amount;
            const trial = projectPoint(trialBase);
            evaluations += 1;
            const result = await options.evaluate(trial);
            processed += 1;
            if (result.objective === null || !Number.isFinite(result.objective)) {
                continue;
            }
            const violation =
                result.violations.length === 0
                    ? 0
                    : Math.max(
                          ...result.violations.map((value) =>
                              Number.isFinite(value)
                                  ? Math.max(0, value)
                                  : CONFIG.SOLVER_MAX_VIOLATION,
                          ),
                      );
            if (violation > CONFIG.SOLVER_FEASIBILITY_TOLERANCE) {
                continue;
            }
            if (isBetter(result.objective, polish.objective)) {
                polish.point = trial;
                polish.objective = result.objective;
                polish.improvedInSweep = true;
                // Keep the reported best live, so the progress line moves.
                bestFeasible = { x: trial, objective: result.objective, violation: 0 };
            }
        }
        return false;
    };

    /** Centroid of every vertex except the worst. */
    const centroid = (): number[] => {
        const center = new Array<number>(dimension).fill(0);
        for (let i = 0; i < dimension; i++) {
            for (let j = 0; j < dimension; j++) {
                center[j] = (center[j] ?? 0) + (vertices[i]?.[j] ?? 0);
            }
        }
        return center.map((sum) => sum / dimension);
    };

    /** Advance one outer penalty round; returns true when the solve ends. */
    const advanceOuterRound = async (): Promise<boolean> => {
        const bestObjective = bestFeasible?.objective ?? null;
        const improved =
            previousRoundObjective === null ||
            bestObjective === null ||
            Math.abs(bestObjective - previousRoundObjective) >
                tolerance * (1 + Math.abs(bestObjective));
        if (bestFeasible !== null && !improved) {
            startPolish('optimal');
            return finished;
        }
        if (outerRound + 1 >= CONFIG.SOLVER_MAX_OUTER_ROUNDS) {
            startPolish(bestFeasible !== null ? 'max-iterations' : 'infeasible');
            return finished;
        }
        previousRoundObjective = bestObjective;
        outerRound += 1;
        rho *= CONFIG.SOLVER_PENALTY_GROWTH;
        const restart =
            bestFeasible?.x ?? bestInfeasible?.x ?? clamp([...options.initial]);
        const rebuilt = await buildSimplex(restart);
        vertices = rebuilt.vertices;
        values = rebuilt.values;
        sortSimplex();
        return false;
    };

    const step = async (): Promise<boolean> => {
        if (finished) {
            return true;
        }
        if (cancelled) {
            finish('cancelled');
            return true;
        }
        if (polish !== null) {
            return polishStep();
        }
        if (iterations >= maxIterations) {
            // Force the polish: with the projection there may be no
            // infeasible point to signal a boundary optimum, and the
            // polish is the move that finishes one. finishPolish
            // reports optimal when the polish confirms the point.
            startPolish('max-iterations', true);
            return finished;
        }
        sortSimplex();
        iterations += 1;

        const best = vertices[0] ?? [];
        const worst = vertices[dimension] ?? [];
        const bestValue = values[0] ?? 0;
        const worstValue = values[dimension] ?? 0;
        const secondWorstValue = values[dimension - 1] ?? 0;
        const center = centroid();

        /** Point from the centroid in a direction, scaled by factor. */
        const fromCenter = (direction: number[], factor: number): number[] =>
            center.map((value, j) => value + factor * ((direction[j] ?? 0) - value));

        // Reflection: through the centroid, away from the worst vertex.
        const reflected = projectPoint(
            clamp(
                center.map(
                    (value, j) =>
                        value + CONFIG.SOLVER_NM_REFLECTION * (value - (worst[j] ?? 0)),
                ),
            ),
        );
        const reflectedValue = await penalized(reflected);
        if (reflectedValue < bestValue) {
            // Expansion: further in the reflected direction.
            const expanded = projectPoint(clamp(fromCenter(reflected, CONFIG.SOLVER_NM_EXPANSION)));
            const expandedValue = await penalized(expanded);
            if (expandedValue < reflectedValue) {
                vertices[dimension] = expanded;
                values[dimension] = expandedValue;
            } else {
                vertices[dimension] = reflected;
                values[dimension] = reflectedValue;
            }
        } else if (reflectedValue < secondWorstValue) {
            vertices[dimension] = reflected;
            values[dimension] = reflectedValue;
        } else {
            // Contraction: outside when the reflection beat the worst,
            // inside otherwise.
            const contractDirection = reflectedValue < worstValue ? reflected : worst;
            const contracted = projectPoint(
                clamp(fromCenter(contractDirection, CONFIG.SOLVER_NM_CONTRACTION)),
            );
            const contractedValue = await penalized(contracted);
            const contractTarget = reflectedValue < worstValue ? reflectedValue : worstValue;
            if (contractedValue < contractTarget) {
                vertices[dimension] = contracted;
                values[dimension] = contractedValue;
            } else {
                // Shrink toward the best vertex.
                for (let i = 1; i <= dimension; i++) {
                    const shrunk = projectPoint(
                        clamp(
                            (vertices[i] ?? []).map(
                                (value, j) =>
                                    (best[j] ?? 0) +
                                    CONFIG.SOLVER_NM_SHRINK * (value - (best[j] ?? 0)),
                            ),
                        ),
                    );
                    vertices[i] = shrunk;
                    values[i] = await penalized(shrunk);
                }
            }
        }

        if (finished) {
            return true;
        }
        sortSimplex();
        if (converged() && (await advanceOuterRound())) {
            return true;
        }
        if (
            bestFeasible !== null &&
            iterations - lastImprovementIteration >= stagnationLimit
        ) {
            // The best feasible point has not improved meaningfully
            // for a long run: the simplex is grinding on a flat
            // surface. Treat the solve as converged rather than
            // burning the remaining iteration budget.
            startPolish('optimal');
            return finished;
        }
        return finished;
    };

    const getState = (): SolverState => {
        const best = bestFeasible ?? bestInfeasible;
        let message = STATUS_MESSAGES[status as Exclude<SolverStatus, 'running'>] ?? '';
        if (status === 'infeasible' && bestFeasible === null && bestInfeasible === null) {
            message = 'The objective could not be evaluated at any tried point.';
        }
        return {
            status,
            iterations,
            evaluations,
            bestX: best?.x ?? projectPoint(clamp([...options.initial])),
            bestObjective: best?.objective ?? null,
            bestViolation: best?.violation ?? Number.POSITIVE_INFINITY,
            message,
        };
    };

    return {
        step,
        getState,
        cancel: () => {
            cancelled = true;
        },
    };
}
