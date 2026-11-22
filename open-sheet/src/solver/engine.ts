/**
 * Pure optimizer: gradient-based (L-BFGS, the GRG path) by default, with
 * a Nelder-Mead simplex as a fallback. Both sit on a quadratic-penalty
 * method for constraints. No Univer dependency, no DOM — the sheet
 * bridge (src/solver/model.ts) supplies the evaluate function.
 *
 * Why a gradient method: Nelder-Mead is trial and error — it never
 * uses the slope of the objective, so in 19 dimensions it needs
 * thousands of tiny steps (measured: 10,000 iterations / 18,625
 * evaluations for the 19-variable ratio, reaching the optimum's
 * neighbourhood by iteration ~150 and then grinding to the cap).
 * L-BFGS uses the gradient, so it converges superlinearly in tens
 * of iterations. The gradient is numerical (central differences of
 * the penalized objective, every probe projected first, so no
 * infeasible trial is ever evaluated); the optimum of a ratio
 * problem sits on the sum boundary, where the projected gradient —
 * the gradient of the composite penalized-after-projection function
 * — is the right search direction and vanishes at the optimum.
 * GRG (reduced gradient, what Excel uses) would need an active-set
 * constraint handler; L-BFGS plus the existing projector and penalty
 * achieves the same end with a compact, well-understood algorithm,
 * and stays general — it works for any objective formula, not just
 * a ratio.
 *
 * Stepwise and asynchronous: createSolver(...) returns a Solver with an
 * async step() (one iteration per call — one L-BFGS iteration, or one
 * simplex iteration for the fallback; the UI drives it in slices so
 * the page stays responsive). step() is async because the sheet's
 * formula engine recalculates asynchronously after a write —
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
 *   onto the feasible set (before they are evaluated or stored), so no
 *   infeasible trial is ever written to the sheet; the penalty remains
 *   the backstop for constraints the projector cannot express.
 * - Non-finite objective values are treated as a large penalty, never a crash.
 * - After the penalty rounds, a transfer polish (see startPolish) slides
 *   the best feasible point along a sum boundary, the move Nelder-Mead
 *   cannot make from a boundary point.
 */
import { CONFIG } from '../config';

export type SolverGoal = 'max' | 'min';

/** Which inner method runs the search: 'grg' is the gradient-based
 * L-BFGS engine (the default); 'nelder-mead' is the derivative-free
 * simplex fallback. */
export type SolverMethod = 'grg' | 'nelder-mead';

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
    /** Inner method: 'grg' (gradient L-BFGS, the default) or
     * 'nelder-mead' (the simplex fallback). */
    method?: SolverMethod;
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

/**
 * Central-difference gradient of a scalar function (exported for
 * tests). `baseValue` is fn(x) — the caller already knows it, so the
 * one-sided fallback below needs no extra evaluation. A side that
 * cannot be evaluated (null / non-finite) falls back to a one-sided
 * difference from the finite side; when neither side is finite the
 * component is 0 (no information there). `step` is the relative
 * finite-difference step (see CONFIG.SOLVER_GRAD_STEP).
 */
export function numericalGradient(
    fn: (x: number[]) => number | null,
    x: number[],
    baseValue: number | null,
    step: number,
): number[] {
    const gradient: number[] = new Array<number>(x.length).fill(0);
    const finite = (value: number | null): value is number =>
        value !== null && Number.isFinite(value);
    for (let i = 0; i < x.length; i++) {
        const h = step * Math.max(Math.abs(x[i] ?? 0), 1);
        const plus = [...x];
        plus[i] = (plus[i] ?? 0) + h;
        const minus = [...x];
        minus[i] = (minus[i] ?? 0) - h;
        const fPlus = fn(plus);
        const fMinus = fn(minus);
        if (finite(fPlus) && finite(fMinus)) {
            gradient[i] = (fPlus - fMinus) / (2 * h);
        } else if (finite(fPlus) && finite(baseValue)) {
            gradient[i] = (fPlus - baseValue) / h;
        } else if (finite(fMinus) && finite(baseValue)) {
            gradient[i] = (baseValue - fMinus) / h;
        } else {
            gradient[i] = 0;
        }
    }
    return gradient;
}

/** Dot product (small helper for the L-BFGS two-loop recursion). */
function dot(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += (a[i] ?? 0) * (b[i] ?? 0);
    }
    return sum;
}

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
    const method: SolverMethod = options.method ?? 'grg';

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
     * L-BFGS state (the gradient method only). `current` is the
     * iterate the search moves from, `currentValue` its penalized
     * value; the curvature update is deferred one iteration — the
     * gradient at the new point is computed at the start of the next
     * step, so each iteration costs one gradient (2n evaluations)
     * plus its line search, not two. `pendingStep` / `pendingGradient`
     * hold the move and the gradient before it until that gradient
     * arrives.
     */
    let current: number[] | null = null;
    let currentValue: number | null = null;
    /**
     * Violation (max constraint violation, 0 when feasible) of the
     * point the gradient search is currently standing on, and of the
     * most recently evaluated point. The line search never accepts a
     * step that makes feasibility strictly worse than the current
     * point (see lineSearch). `lastEvaluatedViolation` is set by
     * penalized on every call, so the line search reads the
     * just-evaluated trial's violation right after its own penalized
     * call — no other evaluation interleaves.
     */
    let currentViolation: number | null = null;
    let lastEvaluatedViolation: number | null = null;
    /**
     * Whether any evaluation has returned a (possibly zero)
     * violations array entry — i.e. the problem has constraints.
     * The line-search displacement cap (below) only applies then:
     * without constraints there is nothing a big jump could spike,
     * and the cap would stop the expansion that carries a runaway
     * objective to the unbounded check.
     */
    let seenConstraints = false;
    let pendingStep: number[] | null = null;
    let pendingGradient: number[] | null = null;
    let lbfgsMemory: { s: number[]; y: number[]; rho: number }[] = [];
    /**
     * Whether the gradient search last stopped by stalling (line
     * search found no step, or a microscopic step) rather than by
     * the KKT residual firing. A stalled search is one the transfer
     * polish can still improve — the polish is forced for it (see
     * advanceOuterRound) — while a cleanly converged search needs
     * no polish. Reset at the start of every gradient search/round.
     */
    let gradientStalled = false;

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
        if (evaluation.violations.length > 0) {
            seenConstraints = true;
        }
        const violations = evaluation.violations.map((violation) =>
            Number.isFinite(violation)
                ? Math.max(0, violation)
                : CONFIG.SOLVER_MAX_VIOLATION,
        );
        const violation = violations.length === 0 ? 0 : Math.max(...violations);
        lastEvaluatedViolation = violation;
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

    /** Sort vertices best-first by penalized value. */
    const sortSimplex = (): void => {
        const order = values.map((_value, i) => i);
        order.sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
        vertices = order.map((i) => vertices[i] ?? []);
        values = order.map((i) => values[i] ?? 0);
    };

    let vertices: number[][] = [];
    let values: number[] = [];
    if (method === 'nelder-mead') {
        const built = await buildSimplex(options.initial);
        vertices = built.vertices;
        values = built.values;
        sortSimplex();
    } else {
        // The gradient method starts from the projected start point
        // itself (evaluated once, so the best is seeded before the
        // first step — the same role buildSimplex's centre plays).
        const start = projectPoint(clamp([...options.initial]));
        current = start;
        currentValue = await penalized(start);
        currentViolation = lastEvaluatedViolation;
    }

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
            // Unforced polish needs a better infeasible point — the
            // boundary signal. Under the projector there is never
            // one (every trial is feasible), so the gate would block
            // the polish entirely; the gradient method forces it
            // instead when its search stalled (see advanceOuterRound),
            // because the transfer moves are the refinement that
            // closes the gap a stalled line search leaves.
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
            method === 'nelder-mead' &&
            pendingStatus === 'max-iterations' &&
            Math.abs(polish.objective - polish.startObjective) <=
                tolerance * (1 + Math.abs(polish.startObjective))
        ) {
            // The polish could not improve the starting point by a
            // meaningful amount: the simplex had already reached the
            // optimum and merely crawled there slowly — the projection
            // pins it to the boundary, so its diameter shrinks too
            // slowly to converge before the cap. The run is optimal,
            // not cut short. This is a Nelder-Mead heuristic only:
            // the gradient method has its own convergence test, so a
            // capped gradient run that the polish cannot improve is
            // genuinely unfinished and stays max-iterations.
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
                if (polish.step < CONFIG.SOLVER_POLISH_STEP_FLOOR) {
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
        // Force the transfer polish for a stalled gradient search
        // only when a projector is present. Without one, the outer
        // rounds (growing penalty) are what drive the search back
        // to feasibility, and forcing the polish on a stall would
        // end the solve before they run — the polish's transfers
        // preserve the sum, so they cannot fix an infeasible point.
        // With a projector there is never an infeasible point, so
        // the unforced gate (which needs one) would block the polish
        // entirely and a stall would end the solve unimproved.
        const forcePolish =
            method === 'grg' &&
            gradientStalled &&
            options.project !== null &&
            options.project !== undefined;
        if (bestFeasible !== null && !improved) {
            // A single non-improving round is normal for the
            // penalty method while rho is still small: the
            // penalized optimum sits outside the feasible set, so
            // bestFeasible does not move until rho has grown enough
            // to pull it back. Without a projector, keep growing
            // rho for at least SOLVER_MIN_OUTER_ROUNDS_BEFORE_POLISH
            // rounds before the polish can end the solve; with a
            // projector every point is feasible, so a non-improving
            // round really is a stall and the polish may run.
            const penaltyStillDriving =
                (options.project === null || options.project === undefined) &&
                outerRound < CONFIG.SOLVER_MIN_OUTER_ROUNDS_BEFORE_POLISH;
            if (!penaltyStillDriving) {
                startPolish('optimal', forcePolish);
                return finished;
            }
        }
        if (outerRound + 1 >= CONFIG.SOLVER_MAX_OUTER_ROUNDS) {
            startPolish(
                bestFeasible !== null ? 'max-iterations' : 'infeasible',
                forcePolish,
            );
            return finished;
        }
        previousRoundObjective = bestObjective;
        outerRound += 1;
        rho *= CONFIG.SOLVER_PENALTY_GROWTH;
        const restart =
            bestFeasible?.x ?? bestInfeasible?.x ?? clamp([...options.initial]);
        if (method === 'nelder-mead') {
            const rebuilt = await buildSimplex(restart);
            vertices = rebuilt.vertices;
            values = rebuilt.values;
            sortSimplex();
        } else {
            await resetGradientSearch(restart);
        }
        return false;
    };

    /**
     * Gradient method (the GRG path): L-BFGS with numerical gradients.
     * One iteration is one gradient (2n evaluations) plus an Armijo
     * line search. The curvature update is deferred one iteration —
     * the gradient at the new point is computed at the start of the
     * next step — so an iteration costs one gradient, not two.
     */

    /** Restart the gradient search from a point: clear the curvature
     * memory and re-evaluate the start (its penalized value is the
     * base the gradient differences are taken from). */
    const resetGradientSearch = async (restart: number[]): Promise<void> => {
        lbfgsMemory = [];
        pendingStep = null;
        pendingGradient = null;
        gradientStalled = false;
        const start = projectPoint(clamp([...restart]));
        current = start;
        currentValue = await penalized(start);
        currentViolation = lastEvaluatedViolation;
    };

    /**
     * Result of a gradient computation: the gradient to search along
     * and the stationarity residual the convergence test judges, with
     * the threshold that residual is judged against.
     */
    type GradientResult = {
        gradient: number[];
        residual: number;
        tolerance: number;
    };

    /**
     * Gradient of the penalized objective at a point, plus the
     * stationarity residual. Every probe is projected and clamped
     * before evaluation, so no infeasible trial is ever written to
     * the sheet. Returns null when the run was cancelled or finished
     * mid-gradient (the caller then stops).
     *
     * Two schemes, because the projector changes what a finite
     * difference measures:
     *
     * - No projector: plain coordinate central differences, and the
     *   residual is the projected-gradient mapping ||x - P(x - g)||,
     *   which vanishes at an optimum (including a bound optimum).
     *
     * - With a projector: the sum rule rescales the plus probe by
     *   1/(1+h) while the minus probe is untouched, so a coordinate
     *   central difference measures dF_i - (grad F . x)/2 instead of
     *   dF_i — at an asymmetric boundary optimum every component
     *   comes out shifted by the same -lambda/2, the direction is
     *   nearly uniform (and the projection kills it), and the mapping
     *   never vanishes. So the probes run along the feasible
     *   directions d_i = e_i - x instead: they keep the sum exactly,
     *   so neither probe is rescaled, and the central difference
     *   measures the Riemannian gradient component grad F . (e_i - x)
     *   to O(h^2). The search direction is the bound-projected full
     *   gradient: the true gradient is r + radial * 1 (radial =
     *   grad F . x, from one extra probe at (1-h)x), with a zero
     *   weight's component cut to min(partial, 0) so the direction
     *   never tries to decrease a weight that is already 0. The
     *   residual is the KKT residual: for positive weights |gR_i|,
     *   for zero weights the one-sided forward difference (the
     *   central one is polluted by the clamp on the minus probe),
     *   and the radial part — max(0, -radial) when the sum can still
     *   grow, max(0, radial) when it is at its cap.
     */
    const gradientAt = async (
        point: number[],
        baseValue: number,
    ): Promise<GradientResult | null> => {
        const finite = (value: number): boolean =>
            Number.isFinite(value) && value < CONFIG.SOLVER_NON_FINITE_PENALTY / 2;
        const h = CONFIG.SOLVER_GRAD_STEP;

        if (options.project === null || options.project === undefined) {
            const gradient: number[] = new Array<number>(dimension).fill(0);
            for (let i = 0; i < dimension; i++) {
                if (cancelled || finished) {
                    return null;
                }
                const step = h * Math.max(Math.abs(point[i] ?? 0), 1);
                const plus = [...point];
                plus[i] = (plus[i] ?? 0) + step;
                const minus = [...point];
                minus[i] = (minus[i] ?? 0) - step;
                const fPlus = await penalized(projectPoint(clamp(plus)));
                if (cancelled || finished) {
                    return null;
                }
                const fMinus = await penalized(projectPoint(clamp(minus)));
                if (cancelled || finished) {
                    return null;
                }
                if (finite(fPlus) && finite(fMinus)) {
                    gradient[i] = (fPlus - fMinus) / (2 * step);
                } else if (finite(fPlus)) {
                    gradient[i] = (fPlus - baseValue) / step;
                } else if (finite(fMinus)) {
                    gradient[i] = (baseValue - fMinus) / step;
                } else {
                    gradient[i] = 0;
                }
            }
            return {
                gradient,
                residual: gradientMapping(point, gradient),
                tolerance: CONFIG.SOLVER_GRAD_TOLERANCE * (1 + Math.abs(baseValue)),
            };
        }

        // Projector present: feasible-direction differences.
        const riemannian: number[] = new Array<number>(dimension).fill(0);
        const forward: number[] = new Array<number>(dimension).fill(0);
        for (let i = 0; i < dimension; i++) {
            if (cancelled || finished) {
                return null;
            }
            // d_i = e_i - x: the direction that moves weight into cell
            // i. Both probes keep the sum exactly, so the sum rule
            // never rescales either of them.
            const plus = point.map((value, j) => value + h * ((j === i ? 1 : 0) - value));
            const minus = point.map((value, j) => value - h * ((j === i ? 1 : 0) - value));
            const fPlus = await penalized(projectPoint(clamp(plus)));
            if (cancelled || finished) {
                return null;
            }
            const fMinus = await penalized(projectPoint(clamp(minus)));
            if (cancelled || finished) {
                return null;
            }
            if (finite(fPlus) && finite(fMinus)) {
                riemannian[i] = (fPlus - fMinus) / (2 * h);
            } else if (finite(fPlus)) {
                riemannian[i] = (fPlus - baseValue) / h;
            } else if (finite(fMinus)) {
                riemannian[i] = (baseValue - fMinus) / h;
            } else {
                riemannian[i] = 0;
            }
            // One-sided derivative along d_i: the clean value for a
            // zero weight, whose minus probe is polluted by the clamp.
            // A plus probe that cannot be evaluated means the
            // direction is unevaluable — no improvement is available
            // there, so it contributes 0 to the residual.
            forward[i] = finite(fPlus) ? (fPlus - baseValue) / h : 0;
        }

        // Radial derivative: radial = (F(x) - F((1-h)x)) / h, which
        // tends to grad F . x as h -> 0 — the rate at which F changes
        // when every weight is scaled up together. (Sign matters and
        // is easy to get backwards: F((1-h)x) = F(x) - h*(grad F . x),
        // so the difference quotient is +(grad F . x).) One probe at
        // (1-h)x. It reconstructs the true gradient (partial_i =
        // r_i + radial, since r_i = partial_i - grad F . x) and it
        // feeds the residual's radial part.
        let radial = 0;
        if (cancelled || finished) {
            return null;
        }
        const down = point.map((value) => (1 - h) * value);
        const fDown = await penalized(projectPoint(clamp(down)));
        if (cancelled || finished) {
            return null;
        }
        if (finite(fDown)) {
            radial = (baseValue - fDown) / h;
        }

        // Can the sum still grow? Scale the point up slightly: if the
        // projector leaves it alone the sum rule is not binding.
        const up = point.map((value) => (1 + h) * value);
        const projectedUp = projectPoint(clamp(up));
        let canIncrease = true;
        for (let i = 0; i < dimension; i++) {
            const a = up[i] ?? 0;
            const b = projectedUp[i] ?? 0;
            if (Math.abs(a - b) > 1e-12 * (1 + Math.abs(a))) {
                canIncrease = false;
                break;
            }
        }

        // The Riemannian component is the central difference for a
        // positive weight and the one-sided forward difference for a
        // zero weight (whose central difference is polluted by the
        // clamp on the minus probe).
        const riemannianComponent: number[] = new Array<number>(dimension).fill(0);
        for (let i = 0; i < dimension; i++) {
            const active = (point[i] ?? 0) > CONFIG.SOLVER_FEASIBILITY_TOLERANCE;
            riemannianComponent[i] = active ? (riemannian[i] ?? 0) : (forward[i] ?? 0);
        }

        // Search direction: the bound-projected full gradient.
        // ∂F_i = r_i + radial (r_i is the Riemannian component,
        // radial = grad F . x, so r + radial * 1 is the true
        // gradient). A zero weight can only increase, so its
        // component is min(∂F_i, 0): a good cell (∂F_i < 0) keeps
        // its negative component and the direction increases it; a
        // bad cell (∂F_i > 0) is zeroed. Zeroing matters: the bad
        // zero cells have large positive ∂F_i, so the unprojected
        // gradient is dominated by components that point toward
        // decreasing zero weights — infeasible, the clamp eats them,
        // and the Armijo test, judged on the full gradient norm,
        // overestimates the achievable decrease by an order of
        // magnitude and the line search stalls. Positive weights
        // keep ∂F_i whole. (Neither the raw Riemannian components
        // nor their tangent projection works as the direction: the
        // components are a moving-frame gradient, so the L-BFGS
        // curvature pairs go inconsistent and the search oscillates;
        // the tangent projection's mean is dominated by the bad
        // zero cells and flips the active components' signs.)
        const gradient: number[] = new Array<number>(dimension).fill(0);
        for (let i = 0; i < dimension; i++) {
            const partial = (riemannianComponent[i] ?? 0) + radial;
            const active = (point[i] ?? 0) > CONFIG.SOLVER_FEASIBILITY_TOLERANCE;
            gradient[i] = active ? partial : Math.min(partial, 0);
        }

        // KKT residual: at an optimum the Riemannian components are 0
        // for positive weights and >= 0 for zero weights (min F:
        // moving weight into a zero cell must not help), and the
        // radial part says the sum is right. radial = grad F . x, so
        // when the sum can still grow, growing it helps exactly when
        // radial < 0 (F falls as x scales up); when the sum is at its
        // cap, shrinking it helps exactly when radial > 0.
        let residual = 0;
        for (let i = 0; i < dimension; i++) {
            const active = (point[i] ?? 0) > CONFIG.SOLVER_FEASIBILITY_TOLERANCE;
            if (active) {
                residual = Math.max(residual, Math.abs(riemannian[i] ?? 0));
            } else {
                residual = Math.max(residual, Math.max(0, -(forward[i] ?? 0)));
            }
        }
        residual = Math.max(residual, canIncrease ? Math.max(0, -radial) : Math.max(0, radial));

        return {
            gradient,
            residual,
            tolerance: CONFIG.SOLVER_GRAD_RESIDUAL_TOLERANCE * (1 + Math.abs(baseValue)),
        };
    };

    /**
     * Projected-gradient stationarity: ||x - P(x - g)||, where P is
     * the projector-plus-clamp. Zero at an optimum — including a
     * boundary optimum, where the raw gradient points out of the
     * feasible set and the projection pulls the step back to x.
     */
    const gradientMapping = (point: number[], gradient: number[]): number => {
        const shifted = projectPoint(
            clamp(point.map((value, i) => value - (gradient[i] ?? 0))),
        );
        let mapping = 0;
        for (let i = 0; i < dimension; i++) {
            mapping = Math.max(mapping, Math.abs((point[i] ?? 0) - (shifted[i] ?? 0)));
        }
        return mapping;
    };

    /** L-BFGS two-loop recursion: the descent direction -H*g from the
     * stored (s, y) pairs (Nocedal & Wright, Algorithm 7.4). */
    const lbfgsDirection = (gradient: number[]): number[] => {
        const memory = lbfgsMemory;
        const q = [...gradient];
        const alphas: number[] = new Array<number>(memory.length).fill(0);
        for (let k = memory.length - 1; k >= 0; k--) {
            const pair = memory[k];
            if (pair === undefined) {
                continue;
            }
            const alpha = pair.rho * dot(pair.s, q);
            alphas[k] = alpha;
            for (let j = 0; j < dimension; j++) {
                q[j] = (q[j] ?? 0) - alpha * (pair.y[j] ?? 0);
            }
        }
        let r = [...q];
        const last = memory[memory.length - 1];
        if (last !== undefined) {
            const sy = dot(last.s, last.y);
            const yy = dot(last.y, last.y);
            if (sy > 0 && yy > 0) {
                const scale = sy / yy;
                r = r.map((value) => value * scale);
            }
        }
        for (let k = 0; k < memory.length; k++) {
            const pair = memory[k];
            if (pair === undefined) {
                continue;
            }
            const beta = pair.rho * dot(pair.y, r);
            const alpha = alphas[k] ?? 0;
            for (let j = 0; j < dimension; j++) {
                r[j] = (r[j] ?? 0) + (pair.s[j] ?? 0) * (alpha - beta);
            }
        }
        return r.map((value) => -value);
    };

    /** Record one curvature pair; a pair with no usable curvature
     * (s.y <= 0 — a flat or noisy direction) is skipped, not stored,
     * so a bad pair cannot poison the Hessian estimate. */
    const updateMemory = (s: number[], y: number[]): void => {
        const sy = dot(s, y);
        if (!(sy > 1e-10)) {
            return;
        }
        lbfgsMemory.push({ s, y, rho: 1 / sy });
        if (lbfgsMemory.length > CONFIG.SOLVER_LBFGS_MEMORY) {
            lbfgsMemory.shift();
        }
    };

    /**
     * Backtracking Armijo line search from a point along a direction.
     * Starts at alpha = 1 (the quasi-Newton step) and halves on
     * failure; when the full step is accepted it also tries doubling,
     * which is what carries a runaway (unbounded) objective to the
     * unbounded check in penalized() instead of crawling there one
     * unit at a time. Every trial is projected before evaluation.
     * Returns the accepted trial and its value, or null when no step
     * improves (or the run was cancelled/finished mid-search).
     */
    const lineSearch = async (
        point: number[],
        value: number,
        gradient: number[],
        direction: number[],
    ): Promise<{ point: number[]; value: number; violation: number } | null> => {
        // Cap the trial displacement: never evaluate a step that
        // moves any single variable by more than
        // SOLVER_LINE_SEARCH_MAX_STEP (see the config comment — a
        // huge jump clamps to a concentrated allocation and spikes
        // a formula-side constraint in the sheet while it is being
        // evaluated, even though the trial is rejected). Only when
        // the problem has constraints (see seenConstraints).
        const maxDirection = Math.max(...direction.map((v) => Math.abs(v)));
        const maxAlpha =
            maxDirection > 0
                ? CONFIG.SOLVER_LINE_SEARCH_MAX_STEP / maxDirection
                : 1;
        let alpha = seenConstraints ? Math.min(1, maxAlpha) : 1;
        let accepted: { point: number[]; value: number; violation: number } | null = null;
        let expansions = 0;
        for (let trial = 0; trial < CONFIG.SOLVER_LINE_SEARCH_MAX_TRIALS; trial++) {
            if (cancelled || finished) {
                return null;
            }
            const candidate = projectPoint(
                clamp(point.map((v, i) => v + alpha * (direction[i] ?? 0))),
            );
            const candidateValue = await penalized(candidate);
            if (cancelled || finished) {
                return null;
            }
            const candidateViolation = lastEvaluatedViolation ?? 0;
            const displacement = candidate.map((v, i) => v - (point[i] ?? 0));
            const directional = dot(gradient, displacement);
            const sufficient =
                directional < 0
                    ? candidateValue <= value + CONFIG.SOLVER_LINE_SEARCH_C1 * directional
                    : candidateValue < value;
            // Never accept a step that makes feasibility strictly
            // worse than the point the search is standing on. With a
            // small penalty rho a big objective gain can otherwise
            // swamp the penalty and carry a trial far past a
            // formula-side constraint (volatility to 35% against a
            // 20% cap) even though the final answer respects it.
            // The tolerance is only numerical slack; the search may
            // still stand on an infeasible point and improve from
            // there, it just may not jump to a worse one.
            const feasibleEnough =
                candidateViolation <=
                (currentViolation ?? 0) + CONFIG.SOLVER_FEASIBILITY_TOLERANCE;
            if (!sufficient || !feasibleEnough) {
                if (accepted !== null) {
                    return accepted;
                }
                alpha /= 2;
                continue;
            }
            const isNew =
                accepted === null ||
                accepted.point.some((v, i) => v !== candidate[i]);
            accepted = { point: candidate, value: candidateValue, violation: candidateViolation };
            if (!isNew || expansions >= CONFIG.SOLVER_LINE_SEARCH_MAX_EXPANSIONS) {
                return accepted;
            }
            expansions += 1;
            // Do not expand past the displacement cap (constraints
            // only — see seenConstraints).
            if (seenConstraints && alpha * 2 > maxAlpha) {
                return accepted;
            }
            alpha *= 2;
        }
        return accepted;
    };

    /**
     * Move off a point whose objective cannot be evaluated (a singular
     * start — e.g. all-zero weights in a ratio, where the denominator
     * is 0): probe the axis directions at the 10% step and take the
     * best finite probe, so the gradient has something to work with.
     * Returns true when the solve is finished.
     */
    const stepOffSingularPoint = async (): Promise<boolean> => {
        if (current === null) {
            return advanceOuterRound();
        }
        let best: { point: number[]; value: number; violation: number } | null = null;
        for (let i = 0; i < dimension; i++) {
            if (cancelled || finished) {
                return true;
            }
            const probe = [...current];
            const base = probe[i] ?? 0;
            probe[i] =
                base +
                (base === 0
                    ? CONFIG.SOLVER_STEP_FALLBACK
                    : Math.abs(base) * CONFIG.SOLVER_STEP_FRACTION);
            const projected = projectPoint(clamp(probe));
            const value = await penalized(projected);
            if (cancelled || finished) {
                return true;
            }
            if (
                Number.isFinite(value) &&
                value < CONFIG.SOLVER_NON_FINITE_PENALTY / 2 &&
                (best === null || value < best.value)
            ) {
                best = { point: projected, value, violation: lastEvaluatedViolation ?? 0 };
            }
        }
        if (best === null) {
            // Nothing nearby evaluates: no information to move on.
            return advanceOuterRound();
        }
        current = best.point;
        currentValue = best.value;
        currentViolation = best.violation;
        return false;
    };

    /** One L-BFGS iteration (the gradient method). Returns true when the solve is done. */
    const gradientStep = async (): Promise<boolean> => {
        if (current === null || currentValue === null) {
            return advanceOuterRound();
        }
        if (
            !Number.isFinite(currentValue) ||
            currentValue >= CONFIG.SOLVER_NON_FINITE_PENALTY / 2
        ) {
            // A singular point is a stall, not a convergence: the
            // polish is the move that may still improve it.
            gradientStalled = true;
            return stepOffSingularPoint();
        }
        iterations += 1;
        // The gradient at the current point completes the deferred
        // curvature update from the previous move.
        const result = await gradientAt(current, currentValue);
        if (result === null) {
            if (cancelled) {
                finish('cancelled');
            }
            return true;
        }
        const gradient = result.gradient;
        if (pendingStep !== null && pendingGradient !== null) {
            const y = gradient.map((g, i) => g - (pendingGradient?.[i] ?? 0));
            updateMemory(pendingStep, y);
            pendingStep = null;
            pendingGradient = null;
        }
        // Converged? The stationarity residual is below its threshold
        // — the mapping for an unprojected problem, the KKT residual
        // for a projected one (see gradientAt).
        if (result.residual <= result.tolerance) {
            gradientStalled = false;
            return advanceOuterRound();
        }
        let direction = lbfgsDirection(gradient);
        if (dot(gradient, direction) >= 0) {
            // Stale curvature (or a kink): fall back to steepest descent.
            direction = gradient.map((g) => -g);
        }
        const accepted = await lineSearch(current, currentValue, gradient, direction);
        if (accepted === null) {
            if (cancelled) {
                finish('cancelled');
            }
            if (finished) {
                return true;
            }
            // No step improves: stuck at a kink or on a flat — treat
            // as converged and let the outer rounds / polish decide.
            // Mark it stalled, so the polish is forced: it is the
            // move that refines a point the line search cannot.
            gradientStalled = true;
            return advanceOuterRound();
        }
        const displacement = accepted.point.map((v, i) => v - (current?.[i] ?? 0));
        const maxDisplacement = Math.max(...displacement.map((v) => Math.abs(v)));
        const improvement = Math.abs(accepted.value - currentValue);
        pendingStep = displacement;
        pendingGradient = gradient;
        current = accepted.point;
        currentValue = accepted.value;
        currentViolation = accepted.violation;
        if (
            maxDisplacement <= tolerance &&
            improvement <= tolerance * (1 + Math.abs(accepted.value))
        ) {
            // A microscopic step: the search has settled. Mark it
            // stalled, so the polish is forced (as above).
            gradientStalled = true;
            return advanceOuterRound();
        }
        if (
            bestFeasible !== null &&
            iterations - lastImprovementIteration >= stagnationLimit
        ) {
            startPolish('optimal');
            return finished;
        }
        return finished;
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
        return method === 'nelder-mead' ? nelderMeadStep() : gradientStep();
    };

    /** One Nelder-Mead simplex iteration (the fallback method). */
    const nelderMeadStep = async (): Promise<boolean> => {
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
