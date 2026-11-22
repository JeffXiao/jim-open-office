# Open Sheet — Univer Sheets (Jim Open Office)

A static Vite + TypeScript app embedding the Univer Sheets editor. It opens
with a blank workbook — the user builds their own content. Part of the
Jim Open Office suite (see the repo root README); no Docs, no agent layer,
no paid Univer features, no server.

## Run it

```sh
npm install
npm run dev      # local development server
npm run build    # tsc + vite build -> dist/
npm run preview  # serve the production build locally
```

## What is in it

- A working Univer Sheets editor (create/edit cells, formulas with
  recalculation, bold and number formats, row/column sizing).
- A blank workbook on open (one empty sheet, "Sheet1"). Nothing is
  pre-loaded; the user builds their own sheet.
- Save/reload from IndexedDB (autosave ~800 ms after the last edit, plus a
  save on page hide).
- One-click .xlsx export via SheetJS, with formulas preserved so Excel
  recalculates.
- A minimal app shell: toolbar (Export .xlsx / Reset),
  the sheet, a status line, and a native-dialog reset confirmation.
- An optional Sign in button (Google). Signing in is never required: the
  sheet works fully without it, and it does not gate anything. See
  "Sign-in (optional)" below.

## Sign-in (optional)

- The toolbar has a Sign in button. When a Google OAuth client ID is
  configured, Google's own "Sign in with Google" button renders there;
  otherwise the plain button explains that setup is needed.
- To enable it, paste the OAuth 2.0 client ID (Web application, Authorized
  JavaScript origin `https://jeffxiao.github.io`) into `GOOGLE_CLIENT_ID`
  in `src/config.ts`. No client secret is used or needed on a static site.
- Signing in only identifies the user (name, email, avatar from the Google
  ID token, whose issuer and expiry are checked in the browser). It does not
  lock the sheet and does not separate workbooks per user — the workbook in
  IndexedDB stays on the device either way. A purely client-side gate cannot
  truly enforce access; real enforcement needs a backend, which Phase 1
  does not have.
- The identity lives in sessionStorage, so closing the tab signs the user
  out. Sign out clears it and tells Google not to sign the user back in
  automatically.

## Browser support

Baseline Widely available: any current Chrome, Edge, Firefox, or Safari.
Features newer than that get the fallback their Modern Web Guidance guide
prescribes; Origin Trial and volatile features are never adopted without an
explicit decision.

## Architecture

Modules split by concern, one state owner (`App`), frozen `CONFIG`,
event delegation in the shell, CSS classes (never `el.style.*`), real SVG
icons under `src/assets/icons/` — see `~/workspace/custom-skills/web-development/SKILL.md`.
Modern Web Guidance is consulted per UI pattern before building it; the
guides that shaped this shell are `toolbar`, `dialog`,
`light-dismiss-a-dialog`, and `css`. The `interactions-in-complex-layouts`
guide was checked and deliberately not applied: the grid is rendered by
Univer, not by our code.

| File | Job |
| --- | --- |
| `src/main.ts` | Entry: imports CSS, starts the App. |
| `src/app.ts` | The App — owns Univer, the workbook, and the shell. |
| `src/auth.ts` | Optional Google sign-in (GIS): token decoding, session, button. |
| `src/config.ts` | Frozen constants (ids, IndexedDB names, status text). |
| `src/blank-workbook.ts` | Builds the blank workbook snapshot (pure data). |
| `src/storage.ts` | IndexedDB save/load/delete of the snapshot. |
| `src/exporter.ts` | Snapshot → SheetJS .xlsx (formulas preserved). |
| `src/importer.ts` | Local .xlsx/.xls file → snapshot (the exporter's mirror). |
| `src/ui.ts` | Toolbar, status live region, reset, open, and Solver dialogs. |
| `src/style.css` | Shell stylesheet (cascade layers, design tokens). |
| `src/solver/engine.ts` | Pure optimizer (gradient L-BFGS + penalty, Nelder-Mead fallback): no Univer dependency. |
| `src/solver/model.ts` | Sheet bridge: address parsing, trial writes, formula evaluation. |

## Test hook

`window.__aiOffice` exposes `{ setCell(address, value), getStatus(),
inspectCell(address), listSheets() }` for the automated harness and manual
checks. It is a development hook, not a user feature.

## Testing

Two layers, each covering what the other cannot reach:

- `npm test` — unit tests (Vitest) in `tests/unit/`, no browser needed:
  the frozen config, the blank workbook (including a regression test that
  no Sharpe content can come back), the .xlsx exporter (cell types,
  formulas with cached values, number formats, column widths, used range,
  multiple sheets), the .xlsx importer (values, formulas, formats, column
  widths, multiple sheets, grid growth, an export→import round-trip, and
  the saved Solver model in a file's defined names),
  IndexedDB persistence (save/load/overwrite/delete, against a minimal
  in-memory IndexedDB stand-in), Google sign-in token decoding
  (valid, wrong-issuer, expired, and malformed tokens), and the Solver
  engine and address parsing (Rosenbrock and quadratic minima, a
  constrained optimum, bounds, infeasible and unbounded problems,
  max-iterations, cancellation, and a 19-variable ratio problem against
  its known answer).
- `node tests/verify.mjs` — the served-build check (Playwright): the app
  boots in a real browser, the Univer sheet renders, formulas recalculate,
  save/reload persists, export downloads, and the reset dialog works.
  The browser parts the unit tests cannot reach — the Univer editor itself
  and the toolbar/dialog shell — are covered here, not by fakes.
- `npx vite build --outDir dist-import && node tests/verify-import.mjs` —
  the Open flow in a real browser (its own port, 4174, so it never clashes
  with the main harness): picking a file asks for confirmation, Cancel
  leaves the workbook untouched, Confirm replaces it with the file's
  contents (values, a recalculated formula, a formatted cell), and the
  import survives a reload. Delete `dist-import/` afterwards — it is a
  verification artifact, not part of the project.
- `npx vite build --outDir dist-solver && node tests/verify-solver.mjs` —
  the Solver in a real browser (its own port, 4175): a 2-variable
  constrained optimum, a 19-variable ratio problem with the same shape as
  a portfolio-weight problem (weights ≥ 0, sum ≤ 1, each ≤ 0.2), the
  modeless dialog (the sheet stays editable while it is open, before
  solving and on the results view; its inputs are enabled when it reopens
  after a solve), Keep leaving the solution in the cells, Restore
  reverting to the originals, Esc after a solve keeping the solution,
  Cancel restoring the original values, the dialog reopening prefilled,
  a validation error on an empty objective, and opening a file with a
  saved Solver model prefilling the dialog. Delete `dist-solver/`
  afterwards — it is a verification artifact, not part of the project.

## Solver

A free, Excel-style Solver in the toolbar (no subscription). Set Objective,
Max / Min / Value Of, By Changing Variable Cells (one contiguous range),
constraints (cell or range, `>=` / `<=` / `=` against a number or a cell),
"Make Unconstrained Variables Non-Negative", and GRG Nonlinear as the
method (LP Simplex and Evolutionary are listed but not yet implemented).
The dialog is modeless: it stays open while the sheet stays clickable,
selectable, and editable — while setting the problem up, while a solve
is running, and on the results view, so the solved values can be looked
at in the sheet before choosing Keep Solution or Restore Original Values.
Esc or the Close button dismisses it; dismissing after a solve keeps the
solution (the same as Keep Solution), while dismissing mid-solve cancels
the run and restores the original values. Opening an .xlsx that carries
a saved Excel Solver model (the `solver_*` defined names) prefills the
dialog with that model — objective, goal, changing cells, constraints,
non-negative, and method; a file without one leaves the dialog as it was.
The engine is a gradient-based optimizer (L-BFGS, the GRG path) with a
quadratic penalty for constraints, plus a sum-preserving transfer polish
for boundary optima; Nelder-Mead remains as a fallback path. The gradient
is numerical (central differences of the penalized objective, every probe
projected first), so it works for any objective formula, and it converges
in a handful of iterations where the simplex needed ~10,000 evaluations
in 19 variables. The engine runs stepwise so the UI stays responsive, with progress in the status
line and a Cancel button. Before any trial is written to the sheet it is
projected onto the feasible set the constraints describe — per-cell
bounds are clamped and a total (a `SUM` of the changing cells) is scaled
back to its cap — so the sheet never shows a trial breaking a rule the
projection can express (a total over 100%, a negative weight, a weight
over its cap). A constraint whose left side is a formula the projection
cannot read (for example a volatility cell) still relies on the penalty,
but the line search caps each trial to a 0.15 change per variable and
never accepts a step that makes feasibility worse, so such a constraint
stays near its limit mid-solve; the final answer respects it. The sheet bridge writes each trial vector with
one `setValues` call and waits for the sheet recalculation to settle
before reading the objective and constraint sides — the only read that
is correct when the objective is a formula built on other formulas
(a direct batch evaluation reads the stale cached values of those
precedents, so the solver saw a constant objective and never changed
the cells). Results show the objective before/after, iterations, and
status; Keep Solution leaves the new values, Restore Original Values
puts the pre-solve values back. When the objective barely improved,
the results also note that the starting values were already
(near-)optimal. Two caveats: edits to the changing or
objective cells during an active solve may be overwritten by the next
trial write, and Reset or Open during a solve cancels it first. v1
limits: one contiguous changing range, GRG-style only, no integer
constraints, and a 19-variable problem now solves in seconds — 3
iterations / 120 evaluations on the harness problems (the simplex
needed ~10,000 iterations / ~18,600 evaluations, about six minutes).
Each evaluation still waits for the sheet recalculation, ~10ms on a
small workbook and ~30–50ms on a workbook with a long formula chain,
so a 19-variable solve on a heavy workbook is on the order of ten
seconds.

## How the Solver works

In plain terms: you pick one objective cell to maximize, minimize, or
drive to a target value; you pick a range of variable cells it may
change; and you add constraints (for example, every weight at least
zero, and the total at most 100%). The Solver then searches for the
combination of variable values that gives the best objective without
breaking a constraint.

**The gradient strategy (the default engine).** The engine is a
gradient-based optimizer — GRG-style, using the L-BFGS method, the same
family Excel's GRG Nonlinear solver belongs to. It works like this:

1. **Measure the slope.** For each variable in turn, it nudges the
   value a tiny amount up and then down (a step of 0.000001) and reads
   how much the objective moves — that gives the slope (the gradient)
   in every direction at once. The slope has to be measured this way,
   by trying small changes, because the objective is a formula in the
   sheet, not a known equation the program can differentiate.
2. **Move everything together.** Instead of changing one cell at a
   time, it moves *all* the variables at once, in the uphill direction
   the slope points to. A line search then decides how far to step:
   it tries a step, and shortens it until the objective genuinely
   improves.
3. **Repeat until the improvements become tiny.** Each round re-measures
   the slope at the new point and steps again, until a step barely
   changes the objective — that means it has arrived.

L-BFGS improves on plain uphill climbing by remembering the last few
steps (five, in this build) and using them to pick a better direction
than the raw slope alone — roughly, it learns the shape of the hill as
it climbs, so it wastes fewer steps zig-zagging.

**Why a gradient method instead of Nelder-Mead.** The previous engine,
Nelder-Mead, is trial and error: it never measures the slope, so it
feels its way forward in thousands of tiny steps — in 19 variables it
needed about 10,000 iterations. The gradient method uses the slope, so
it walks straight at the answer and converges in tens of iterations.
Nelder-Mead is kept as a fallback path in the engine.

**Constraints.** Before any trial is written to the sheet, a projector
repairs it against every rule it can express: a weight below zero is
clamped to zero, a weight over its cap is clamped to the cap, and a
total over its cap is scaled back proportionally — so the sheet never
shows a trial breaking one of those rules, not even mid-solve. A
constraint the projector cannot read — one whose left side is a formula
rather than a plain total, such as a volatility cell — is handled by a
quadratic penalty instead: breaking it makes the objective look worse,
so the search steers away from it. The line search also caps each trial
to a 0.15 change per variable and never accepts a step that makes
feasibility worse. The final answer always respects every constraint,
and best-feasible tracking means the answer written back is always the
best *feasible* point found — never an infeasible one, even if the run
stopped at the iteration limit.

**The transfer polish.** A finishing step for when the optimum sits on
the sum boundary (the total exactly at its cap): it moves value between
pairs of variables while keeping the total fixed, squeezing out the
last improvement the main search cannot reach by stepping uphill.

**How much faster, in practice.** On the 19-variable test problem the
old engine took 10,000 iterations and about six minutes; the gradient
engine takes 3 iterations and 120 evaluations. On a real portfolio file
(maximize the Sharpe ratio from a zeroed start) the old engine took
about 5,060 iterations and 5.6 minutes; the gradient engine takes 31
iterations, 2,600 evaluations, and 134 seconds — and reaches the same
optimum (Sharpe 3.6605).

**Honest limits.** A gradient step is pricier than a single trial:
measuring the slope costs two evaluations per variable (one nudge up,
one down), so a 19-variable gradient costs 38 evaluations before the
step is even taken — the win comes from needing far fewer steps. A
formula-side constraint can in principle still read over its limit
mid-solve (the displacement cap makes it unlikely, and the final answer
always respects it). And the method assumes a smooth objective: it
climbs the slope it can measure, so a jagged or discontinuous formula
can mislead it where a trial-and-error method would keep feeling
around.

## Versions (pinned)

- `@univerjs/preset-sheets-core` **1.5.2** (exact), plus
  `@univerjs/presets` **1.5.2** for `createUniver`.
- `xlsx` (SheetJS) **0.18.5**.
- The formula engine runs on the main thread (no workerURL): the preset
  only uses a worker when one is given, and Phase 1 does not need one.
