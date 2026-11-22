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
  Save button and save on page hide).
- One-click .xlsx export via SheetJS, with formulas preserved so Excel
  recalculates.
- A minimal app shell: toolbar (Save / Export .xlsx / Reset),
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
| `src/solver/engine.ts` | Pure optimizer (Nelder-Mead + penalty): no Univer dependency. |
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
The engine is a pure Nelder-Mead simplex with a quadratic penalty for
constraints, plus a sum-preserving transfer polish for boundary optima;
it runs stepwise so the UI stays responsive, with progress in the status
line and a Cancel button. Before any trial is written to the sheet it is
projected onto the feasible set the constraints describe — per-cell
bounds are clamped and a total (a `SUM` of the changing cells) is scaled
back to its cap — so the sheet never shows a trial breaking a rule the
projection can express (a total over 100%, a negative weight, a weight
over its cap). A constraint whose left side is a formula the projection
cannot read (for example a volatility cell) still relies on the penalty:
the final answer respects it, but a trial mid-solve may show it over its
limit. The sheet bridge writes each trial vector with
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
constraints, and a 19-variable problem takes about six minutes to solve
(each evaluation waits for the sheet recalculation, ~10ms on a small
workbook and ~30–50ms on a workbook with a long formula chain, and
Nelder-Mead needs ~10,000 evaluations in 19 variables).

## Versions (pinned)

- `@univerjs/preset-sheets-core` **1.5.2** (exact), plus
  `@univerjs/presets` **1.5.2** for `createUniver`.
- `xlsx` (SheetJS) **0.18.5**.
- The formula engine runs on the main thread (no workerURL): the preset
  only uses a worker when one is given, and Phase 1 does not need one.
