/**
 * App-wide constants. One frozen object; no magic numbers anywhere else.
 * See the web-development skill: "Constants: name every number".
 */

export const CONFIG = Object.freeze({
    /** Univer packages are pinned to this exact version (see package.json). */
    UNIVER_VERSION: '1.5.2',
    /** DOM id of the element the Univer editor mounts into. */
    UNIVER_CONTAINER_ID: 'univer-container',
    /** IndexedDB database / store / key for the workbook snapshot. */
    IDB_DB_NAME: 'jim-open-office',
    IDB_STORE_NAME: 'workbooks',
    IDB_WORKBOOK_KEY: 'workbook',
    /** Workbook and sheet ids (stable across save / reload). */
    WORKBOOK_ID: 'open-sheet-workbook',
    WORKBOOK_NAME: 'Untitled',
    SHEET_ID: 'sheet-1',
    SHEET_NAME: 'Sheet1',
    /** How long to wait after the last edit before autosaving, in ms. */
    AUTOSAVE_DELAY_MS: 800,
    /** Solver (gradient L-BFGS + quadratic penalty, Nelder-Mead fallback) tuning. */
    SOLVER_MAX_ITERATIONS: 10000,
    SOLVER_TOLERANCE: 1e-6,
    /**
     * Gradient method (the GRG path): central-difference step, as a
     * fraction of max(|x|, 1) per coordinate — small enough that the
     * truncation error is negligible, large enough that the sheet's
     * double-precision values still move measurably over the step.
     * 1e-6 (not 1e-5): the one-sided differences the projected
     * gradient needs carry an O(h) error, and that error must stay
     * below the residual tolerance below.
     */
    SOLVER_GRAD_STEP: 1e-6,
    /**
     * Gradient-method convergence: the projected gradient is
     * (near-)stationary when ||x - P(x - g)|| is below this, relative
     * to 1 + |F| — P is the projector-plus-clamp, so a boundary
     * optimum counts as stationary even though the raw gradient
     * points out of the feasible set there. (No projector only: with
     * a projector the KKT residual below is used instead — the
     * rescaling projector makes the mapping measure the wrong thing,
     * see gradientAt.)
     */
    SOLVER_GRAD_TOLERANCE: 1e-6,
    /**
     * Projected-gradient convergence: the KKT residual (the largest
     * directional derivative along a feasible direction, plus the
     * radial one) must be below this, relative to 1 + |F|. Looser
     * than the mapping tolerance because the one-sided differences
     * behind it carry an O(h) error (~2e-6 at the step above).
     */
    SOLVER_GRAD_RESIDUAL_TOLERANCE: 1e-5,
    /** L-BFGS memory: how many (s, y) curvature pairs are kept. */
    SOLVER_LBFGS_MEMORY: 5,
    /** Armijo backtracking line search: halvings, then doublings. */
    SOLVER_LINE_SEARCH_MAX_TRIALS: 20,
    SOLVER_LINE_SEARCH_MAX_EXPANSIONS: 10,
    SOLVER_LINE_SEARCH_C1: 1e-4,
    /**
     * Line search: largest change any single variable may make in
     * one evaluated trial. A huge jump (the gradient norm can be
     * ~14) clamps to a concentrated allocation whose formula-side
     * constraint (e.g. volatility) spikes far past its cap in the
     * sheet while the trial is being evaluated — even though the
     * trial is rejected and the final answer is feasible. Capping
     * the displacement keeps every evaluated trial near the current
     * point; the search still moves up to this far per iteration,
     * so convergence stays fast.
     */
    SOLVER_LINE_SEARCH_MAX_STEP: 0.15,
    /**
     * Stagnation stop: simplex iterations without a meaningful
     * improvement to the best feasible point before the solve is
     * treated as converged. On a flat 19-variable portfolio problem
     * the best is found early (step ~60) and the simplex then grinds
     * ~9940 iterations without improving it; the stop ends that run
     * at ~5060 iterations with the same answer. The limit must exceed
     * the longest improvement gap in the test problems (3528 steps on
     * the 19-variable ratio problem, which improves late), so it is
     * set well above that gap and well below the observed grind.
     */
    SOLVER_STAGNATION_LIMIT: 5000,
    SOLVER_FEASIBILITY_TOLERANCE: 1e-6,
    /**
     * Feasibility projection: rounds of alternating cell-rule and
     * sum-rule passes when repairing a trial point (see
     * buildProjector in src/solver/model.ts). One round suffices when
     * the rules agree, as they do for a portfolio (non-negative
     * weights, total capped); the extra rounds settle the cases where
     * clamping and scaling pull against each other.
     */
    SOLVER_PROJECTION_ROUNDS: 3,
    SOLVER_INITIAL_PENALTY: 1,
    SOLVER_PENALTY_GROWTH: 10,
    SOLVER_MAX_OUTER_ROUNDS: 8,
    /**
     * Outer rounds before the "no improvement" polish may end a
     * solve, when there is no projector. The penalty method needs
     * several rounds before the feasible optimum can win: while rho
     * is still small the penalized optimum sits outside the
     * feasible set, so bestFeasible does not move for a round or
     * two — that is normal progress, not convergence, and polishing
     * then would end the solve before the penalty has pulled the
     * search back to feasibility. With a projector every point is
     * feasible, so this guard does not apply.
     */
    SOLVER_MIN_OUTER_ROUNDS_BEFORE_POLISH: 4,
    SOLVER_SETTLE_ATTEMPTS: 10,
    SOLVER_POLISH_MAX_EVALUATIONS: 6000,
    SOLVER_POLISH_PAIRS_PER_STEP: 10,
    /**
     * Transfer polish: stop refining once the transfer step falls
     * below this. A transfer of this size moves the objective by
     * ~1e-4 at most (the directional derivatives near an optimum
     * are < 1), and leaves the weights within ~1e-3 of the optimum
     * — inside the answer tolerance — while refining to the 1e-6
     * solver tolerance would cost ~10 extra full sweeps after the
     * optimum is already found, for nothing.
     */
    SOLVER_POLISH_STEP_FLOOR: 2.5e-4,
    SOLVER_STEP_FRACTION: 0.1,
    SOLVER_STEP_FALLBACK: 0.1,
    SOLVER_STEPS_PER_SLICE: 10,
    SOLVER_NON_FINITE_PENALTY: 1e15,
    SOLVER_MAX_VIOLATION: 1e6,
    SOLVER_UNBOUNDED_VALUE: 1e10,
    SOLVER_NM_REFLECTION: 1,
    SOLVER_NM_EXPANSION: 2,
    SOLVER_NM_CONTRACTION: 0.5,
    SOLVER_NM_SHRINK: 0.5,
    /** Sheet limits (Excel-compatible): columns A–XFD, rows 1–1048576. */
    SOLVER_MAX_COLUMNS: 16384,
    SOLVER_MAX_ROWS: 1048576,
    /** Exported file name. */
    EXPORT_FILE_NAME: 'workbook.xlsx',
    /** File types the Open picker accepts. */
    OPEN_ACCEPT: '.xlsx,.xls',
    /** Refuse very large uploads before allocating their contents in memory. */
    OPEN_MAX_FILE_BYTES: 50 * 1024 * 1024,
    /** Keep sheet-backed numerical solving responsive and bounded. */
    SOLVER_MAX_VARIABLES: 100,
    SOLVER_MAX_CONSTRAINTS: 100,
    SOLVER_MAX_CONSTRAINT_CELLS: 1000,
    /**
     * Google sign-in (optional). Paste the OAuth 2.0 client ID here
     * (ends in .apps.googleusercontent.com; Authorized JavaScript origin
     * https://jeffxiao.github.io). Empty means sign-in is not configured
     * yet: the Sign in button stays, but explains that setup is needed.
     * The sheet works fully without signing in either way.
     */
    GOOGLE_CLIENT_ID: '',
    /** sessionStorage key for the signed-in identity (cleared on sign-out). */
    AUTH_STORAGE_KEY: 'open-sheet-auth',
    /** How long to wait for the Google sign-in script to load, in ms. */
    GIS_WAIT_TIMEOUT_MS: 5000,
    /** Poll interval while waiting for the Google sign-in script, in ms. */
    GIS_POLL_INTERVAL_MS: 100,
    /** Status messages. */
    STATUS_LOADING: 'Loading…',
    STATUS_READY: 'Ready — blank workbook.',
    STATUS_RESTORED: 'Ready — restored your saved workbook.',
    STATUS_SAVED: 'Workbook saved.',
    STATUS_EXPORTED: 'Exported workbook.xlsx.',
    STATUS_EXPORT_FAILED: 'Export failed — see the browser console.',
    STATUS_RESET: 'Workbook reset to a blank sheet.',
    STATUS_OPEN_FAILED: 'Couldn’t open that file — it may not be a valid spreadsheet file.',
    STATUS_OPEN_TOO_LARGE: 'That spreadsheet is over the 50 MiB import limit.',
    STATUS_SAVE_FAILED: 'Save failed — see the browser console.',
    STATUS_SIGN_IN_NOT_SET_UP:
        'Google sign-in isn’t set up yet — add a client ID to use it.',
    STATUS_SIGN_IN_UNAVAILABLE:
        'Google sign-in couldn’t load — check your connection, or keep working without signing in.',
    STATUS_SIGN_IN_FAILED:
        'Google sign-in didn’t work — try again or keep working without signing in.',
    STATUS_SIGNED_OUT: 'Signed out — your workbook stays on this device.',
    STATUS_SOLVER_INVALID: 'Solver parameters are not valid — check the dialog.',
    STATUS_SOLVER_CANCELLED: 'Solver cancelled — original values restored.',
    STATUS_SOLVER_INFEASIBLE:
        'Solver could not find a feasible solution — original values restored.',
    STATUS_SOLVER_RESTORED: 'Solver solution discarded — original values restored.',
});
