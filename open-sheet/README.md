# AI Office — Univer Sheets proof of concept (Phase 1)

A static Vite + TypeScript app embedding the Univer Sheets editor, with Jeff's
Sharpe Ratio template pre-loaded so it can be judged side-by-side against
GridBook. Phase 1 of the AI Built Office plan only — no Docs, no agent layer,
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
  recalculation, bold and number formats, row/column sizing, two sheets).
- The Sharpe template as the default workbook: 12 monthly returns, mean,
  sample standard deviation, risk-free rate, and a formula-driven Sharpe
  ratio cell (expected value **1.8189**, matching GridBook's one-click
  Sharpe template).
- Save/reload from IndexedDB (autosave ~800 ms after the last edit, plus a
  Save button and save on page hide).
- One-click .xlsx export via SheetJS, with formulas preserved so Excel
  recalculates.
- A minimal app shell: toolbar (Save / Export .xlsx / Reset template),
  the sheet, a status line, and a native-dialog reset confirmation.

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
| `src/config.ts` | Frozen constants (ids, IndexedDB names, template numbers). |
| `src/sharpe-template.ts` | Builds the template workbook snapshot (pure data). |
| `src/storage.ts` | IndexedDB save/load/delete of the snapshot. |
| `src/exporter.ts` | Snapshot → SheetJS .xlsx (formulas preserved). |
| `src/ui.ts` | Toolbar, status live region, reset dialog. |
| `src/style.css` | Shell stylesheet (cascade layers, design tokens). |

## Template assumption

The Phase 1 plan does not specify the template's exact cells, and GridBook's
template lives in a Muse artifact whose source is not readable from here. So
the template is the standard worked example (returns column, mean, sample
stdev, risk-free rate, Sharpe cell), with the monthly returns chosen so the
computed Sharpe reproduces GridBook's worked-example value, 1.8189. If
GridBook's actual returns differ, the numbers — not the formulas — are what
differs.

## Test hook

`window.__aiOffice` exposes `{ getSharpe(), setCell(address, value),
getStatus() }` for the automated harness and manual checks. It is a
development hook, not a user feature.

## Versions (pinned)

- `@univerjs/preset-sheets-core` **1.5.2** (exact), plus
  `@univerjs/presets` **1.5.2** for `createUniver`.
- `xlsx` (SheetJS) **0.18.5**.
- The formula engine runs on the main thread (no workerURL): the preset
  only uses a worker when one is given, and Phase 1 does not need one.
