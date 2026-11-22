/**
 * The App: the single state owner for the whole page.
 * It owns the Univer instance, the workbook, and the shell; every change goes
 * through an explicit action (saveWorkbook, exportXlsx, resetWorkbook).
 * The formula engine runs on the main thread (no workerURL): the preset only
 * uses a worker when one is given, and the Phase 1 proof of concept does not
 * need one.
 */
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import type { FUniver } from '@univerjs/presets';
import type { FWorkbook } from '@univerjs/preset-sheets-core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import type { IWorkbookData } from '@univerjs/core';
import { CONFIG } from './config';
import { buildBlankWorkbookSnapshot } from './blank-workbook';
import { deleteSnapshot, loadSnapshot, saveSnapshot } from './storage';
import { exportSnapshotToXlsx } from './exporter';
import { readXlsxFile } from './importer';
import type { ImportedSolverParams } from './importer';
import {
    clearStoredCredential,
    decodeCredential,
    disableGoogleAutoSelect,
    isSignInConfigured,
    loadStoredUser,
    promptGoogleSignIn,
    renderGoogleButton,
    storeCredential,
    waitForGoogleSignIn,
} from './auth';
import type { SignedInUser } from './auth';
import { createShell } from './ui';
import type { Shell, SolverConstraintInput, SolverFormValues } from './ui';
import { createSolver } from './solver/engine';
import type { Solver, SolverEvaluation } from './solver/engine';
import { isEssentiallyOptimal } from './solver/results';
import type { SolverGoal } from './solver/results';
import { SolverModel, parseCellAddress, parseConstraint, parseRange, rangeSize } from './solver/model';
import type { CellRef, OriginalCell, RangeRef, SolverConstraint } from './solver/model';

/** Format a solver number for the results view (— when there is none). */
function formatSolverNumber(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
        return '—';
    }
    if (value !== 0 && (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4)) {
        return value.toExponential(3);
    }
    return String(Math.round(value * 10000) / 10000);
}

/** One Solver run: the engine, the sheet it writes to, and what to restore. */
type SolverRun = {
    engine: Solver;
    model: SolverModel;
    objective: CellRef;
    changing: RangeRef;
    originals: OriginalCell[][];
    objectiveBefore: number | null;
    goal: SolverGoal;
    target: number | null;
    finished: boolean;
    restored: boolean;
    timer: number | undefined;
};

/** Test/debug hook exposed on window (documented in the README). */
export type AiOfficeDebugHandle = {
    setCell: (address: string, value: number | string) => void;
    getStatus: () => string;
    inspectCell: (address: string) => {
        value: unknown;
        rawValue: unknown;
        formula: string;
        displayValue: string;
    } | null;
    listSheets: () => string[];
    getSignedInUser: () => SignedInUser | null;
    isSignInConfigured: () => boolean;
};

export class App {
    #univerAPI: FUniver | null = null;
    #workbook: FWorkbook | null = null;
    #shell: Shell | null = null;
    #saveTimer: number | undefined = undefined;
    #statusMessage: string = CONFIG.STATUS_LOADING;
    /** File read and waiting on the open-confirm dialog, if any. */
    #pendingOpen: {
        fileName: string;
        snapshot: IWorkbookData;
        solverParams: ImportedSolverParams | null;
    } | null = null;
    /** Null while signed out; signing in never gates the sheet. */
    #signedInUser: SignedInUser | null = null;
    /** The Solver run in progress (or just finished, until it is decided). */
    #solverRun: SolverRun | null = null;
    /** The Solver dialog's last-used parameters, for prefilling on reopen. */
    #solverLastParams: (SolverFormValues & { constraints: SolverConstraintInput[] }) | null = null;

    /** Create Univer, load the saved workbook (or a blank one), wire the shell. */
    async start(spriteUrl: string): Promise<void> {
        const { univerAPI } = createUniver({
            locale: LocaleType.EN_US,
            locales: {
                [LocaleType.EN_US]: mergeLocales(UniverPresetSheetsCoreEnUS),
            },
            presets: [
                UniverSheetsCorePreset({
                    container: CONFIG.UNIVER_CONTAINER_ID,
                    header: true,
                    toolbar: true,
                    formulaBar: true,
                }),
            ],
        });
        this.#univerAPI = univerAPI;

        this.#shell = createShell(spriteUrl, {
            onSave: () => {
                void this.saveWorkbook();
            },
            onExport: () => {
                this.exportXlsx();
            },
            onResetDecision: (confirmed) => {
                if (confirmed) {
                    void this.resetWorkbook();
                }
            },
            onOpenFile: (file) => {
                void this.handleOpenFile(file);
            },
            onOpenDecision: (confirmed) => {
                void this.handleOpenDecision(confirmed);
            },
            onSignIn: () => {
                this.handleSignInClick();
            },
            onSignOut: () => {
                this.handleSignOut();
            },
            onSolverOpen: () => {
                this.handleSolverOpen();
            },
            onSolverSolve: (values, constraints) => {
                void this.handleSolverSolve(values, constraints).catch((error: unknown) => {
                    console.error('Solver failed to start.', error);
                    this.#shell?.setSolverError('The Solver could not start — see the browser console.');
                    this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
                });
            },
            onSolverCancelRun: () => {
                this.handleSolverCancelRun();
            },
            onSolverKeep: () => {
                this.handleSolverKeep();
            },
            onSolverRestore: () => {
                this.handleSolverRestore();
            },
            onSolverDialogClosed: () => {
                this.handleSolverDialogClosed();
            },
        });

        // Restore the signed-in identity for this tab, if it is still valid.
        // Signing in is optional: a null user simply means "signed out",
        // and the sheet works exactly the same either way.
        this.#signedInUser = loadStoredUser();
        if (this.#signedInUser !== null) {
            this.#shell.setSignedIn(this.#signedInUser);
        } else {
            this.#shell.setSignedOut();
            void this.setupGoogleSignIn();
        }

        const saved = await loadSnapshot().catch((error: unknown) => {
            console.error('Failed to load the saved workbook; starting from a blank workbook.', error);
            return null;
        });
        this.openWorkbook(saved ?? buildBlankWorkbookSnapshot());
        this.setStatus(saved === null ? CONFIG.STATUS_READY : CONFIG.STATUS_RESTORED);

        window.addEventListener('pagehide', () => {
            void this.saveWorkbook();
        });
        this.exposeDebugHandle();
    }

    /** Open a workbook from a snapshot and subscribe the autosave. */
    private openWorkbook(snapshot: Parameters<FUniver['createWorkbook']>[0]): void {
        if (this.#univerAPI === null) {
            throw new Error('Univer is not started yet.');
        }
        this.#workbook = this.#univerAPI.createWorkbook(snapshot);
        this.#workbook.onCommandExecuted(() => {
            this.scheduleAutosave();
        });
    }

    /** Save the current workbook snapshot to IndexedDB. */
    async saveWorkbook(): Promise<void> {
        if (this.#workbook === null) {
            return;
        }
        try {
            await saveSnapshot(this.#workbook.save());
            this.setStatus(CONFIG.STATUS_SAVED);
        } catch (error) {
            console.error('Failed to save the workbook.', error);
            this.setStatus(CONFIG.STATUS_SAVE_FAILED);
        }
    }

    /** Schedule a debounced autosave after the latest edit. */
    private scheduleAutosave(): void {
        window.clearTimeout(this.#saveTimer);
        this.#saveTimer = window.setTimeout(() => {
            void this.saveWorkbook();
        }, CONFIG.AUTOSAVE_DELAY_MS);
    }

    /** Export the current workbook as an .xlsx download. */
    private exportXlsx(): void {
        if (this.#workbook === null) {
            return;
        }
        try {
            exportSnapshotToXlsx(this.#workbook.save());
            this.setStatus(CONFIG.STATUS_EXPORTED);
        } catch (error) {
            console.error('Failed to export the workbook.', error);
            this.setStatus(CONFIG.STATUS_EXPORT_FAILED);
        }
    }

    /** Replace the current workbook with a snapshot and save it. */
    private async replaceWorkbook(snapshot: IWorkbookData, status: string): Promise<void> {
        if (this.#univerAPI === null || this.#workbook === null) {
            return;
        }
        // The Solver dialog is modeless, so the user can replace the
        // workbook mid-solve; the run writes to the sheet being disposed,
        // so cancel it first (restoring the originals) and close the
        // dialog — its parameters belonged to the old workbook. A
        // finished run just needs its state cleared.
        if (this.#solverRun !== null) {
            if (!this.#solverRun.finished) {
                this.handleSolverCancelRun();
            } else {
                this.#solverRun = null;
                this.#shell?.closeSolverDialog();
            }
        }
        window.clearTimeout(this.#saveTimer);
        this.#univerAPI.disposeUnit(this.#workbook.getId());
        this.openWorkbook(snapshot);
        await this.saveWorkbook();
        this.setStatus(status);
    }

    /** Replace the workbook with a fresh blank one. */
    private async resetWorkbook(): Promise<void> {
        await deleteSnapshot().catch((error: unknown) => {
            console.error('Failed to delete the saved snapshot.', error);
        });
        await this.replaceWorkbook(buildBlankWorkbookSnapshot(), CONFIG.STATUS_RESET);
    }

    /** Read a picked file and ask whether to replace the workbook with it. */
    private async handleOpenFile(file: File): Promise<void> {
        let opened: Awaited<ReturnType<typeof readXlsxFile>>;
        try {
            opened = await readXlsxFile(file);
        } catch (error) {
            console.error('Failed to open the file.', error);
            this.setStatus(CONFIG.STATUS_OPEN_FAILED);
            return;
        }
        this.#pendingOpen = {
            fileName: file.name,
            snapshot: opened.snapshot,
            solverParams: opened.solverParams,
        };
        this.#shell?.openConfirmDialog(file.name);
    }

    /** Replace the workbook with the pending file, when the user confirms. */
    private async handleOpenDecision(confirmed: boolean): Promise<void> {
        const pending = this.#pendingOpen;
        this.#pendingOpen = null;
        if (!confirmed || pending === null) {
            return;
        }
        // A file with a saved Solver model prefills the dialog; a file
        // without one leaves the last-used parameters untouched.
        if (pending.solverParams !== null) {
            this.#solverLastParams = { ...pending.solverParams };
        }
        await this.replaceWorkbook(pending.snapshot, `Opened ${pending.fileName}.`);
    }

    /** Render Google's sign-in button once its script has loaded. */
    private async setupGoogleSignIn(): Promise<void> {
        if (!isSignInConfigured() || this.#signedInUser !== null) {
            return;
        }
        const ready = await waitForGoogleSignIn();
        if (!ready || this.#shell === null) {
            return;
        }
        const rendered = renderGoogleButton(this.#shell.getGoogleButtonSlot(), (credential) => {
            this.handleGoogleCredential(credential);
        });
        this.#shell.setGoogleButtonRendered(rendered);
    }

    /** Accept a Google ID token: identify the user, never gate the sheet. */
    private handleGoogleCredential(credential: string): void {
        const user = decodeCredential(credential);
        if (user === null) {
            this.setStatus(CONFIG.STATUS_SIGN_IN_FAILED);
            return;
        }
        storeCredential(credential);
        this.#signedInUser = user;
        this.#shell?.setSignedIn(user);
        this.setStatus(`Signed in as ${user.name}.`);
    }

    /** The fallback Sign in button: explain, or fall back to One Tap. */
    private handleSignInClick(): void {
        if (this.#signedInUser !== null) {
            return;
        }
        if (!isSignInConfigured()) {
            this.setStatus(CONFIG.STATUS_SIGN_IN_NOT_SET_UP);
            return;
        }
        if (!promptGoogleSignIn()) {
            this.setStatus(CONFIG.STATUS_SIGN_IN_UNAVAILABLE);
        }
    }

    /** Sign out: forget the identity, keep the workbook as it is. */
    private handleSignOut(): void {
        clearStoredCredential();
        disableGoogleAutoSelect();
        this.#signedInUser = null;
        this.#shell?.setSignedOut();
        this.setStatus(CONFIG.STATUS_SIGNED_OUT);
    }

    /** Open the Solver dialog, prefilled with the last-used parameters. */
    private handleSolverOpen(): void {
        this.#shell?.openSolverDialog(
            this.#solverLastParams ?? {
                objective: '',
                goal: 'max',
                targetValue: '',
                changing: '',
                nonNegative: true,
                method: 'grg',
                constraints: [],
            },
        );
    }

    /** Validate the dialog's inputs and start a Solver run on the active sheet. */
    private async handleSolverSolve(
        values: SolverFormValues,
        constraints: SolverConstraintInput[],
    ): Promise<void> {
        const sheet = this.#workbook?.getActiveSheet();
        if (sheet === undefined || sheet === null) {
            this.#shell?.setSolverError('No workbook is open.');
            return;
        }
        const objective = parseCellAddress(values.objective);
        if (objective === null) {
            this.#shell?.setSolverError('Set Objective must be a cell address, e.g. BM60.');
            this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
            return;
        }
        const changing = parseRange(values.changing);
        if (changing === null) {
            this.#shell?.setSolverError(
                'By Changing Variable Cells must be a cell or a range, e.g. BM31:BM49.',
            );
            this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
            return;
        }
        if (
            objective.row >= changing.start.row &&
            objective.row <= changing.end.row &&
            objective.col >= changing.start.col &&
            objective.col <= changing.end.col
        ) {
            this.#shell?.setSolverError('The objective cell cannot be one of the changing cells.');
            this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
            return;
        }
        let target: number | null = null;
        if (values.goal === 'value') {
            target = Number(values.targetValue);
            if (values.targetValue === '' || !Number.isFinite(target)) {
                this.#shell?.setSolverError('Value Of needs a number, e.g. 0.5.');
                this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
                return;
            }
        }
        if (values.method !== 'grg') {
            this.#shell?.setSolverError('Only the GRG Nonlinear method is implemented in this version.');
            this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
            return;
        }
        const parsedConstraints: SolverConstraint[] = [];
        for (let index = 0; index < constraints.length; index++) {
            const input = constraints[index];
            const parsed = parseConstraint(input?.left ?? '', input?.operator ?? '', input?.right ?? '');
            if (parsed === null) {
                this.#shell?.setSolverError(
                    `Constraint ${index + 1} is not valid — check its cell or range, operator, and number or cell.`,
                );
                this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
                return;
            }
            parsedConstraints.push(parsed);
        }
        const model = new SolverModel(sheet);
        // Let any just-entered formula calculate before reading the start.
        const objectiveCurrent = model.readCell(objective);
        await model.settle(objective, objectiveCurrent);
        const initial = model
            .readRange(changing)
            .flat()
            .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));
        const originals = model.readOriginals(changing);
        const objectiveBefore = model.readCell(objective);
        if (objectiveBefore === null) {
            this.#shell?.setSolverError('The objective cell does not contain a number yet.');
            this.setStatus(CONFIG.STATUS_SOLVER_INVALID);
            return;
        }
        // Remember the parameters so the dialog reopens prefilled.
        this.#solverLastParams = {
            ...values,
            constraints: constraints.map((constraint) => ({ ...constraint })),
        };
        const targetValue = target;
        const evaluate = async (trial: number[]): Promise<SolverEvaluation> => {
            const result = await model.evaluate(objective, changing, trial, parsedConstraints);
            if (values.goal === 'value' && targetValue !== null) {
                // Value Of: minimize the distance to the target.
                return {
                    objective: result.objective === null ? null : Math.abs(result.objective - targetValue),
                    violations: result.violations,
                };
            }
            return result;
        };
        const count = rangeSize(changing);
        const engine = await createSolver({
            goal: values.goal === 'min' || values.goal === 'value' ? 'min' : 'max',
            initial,
            lowerBounds: Array.from({ length: count }, () => (values.nonNegative ? 0 : null)),
            upperBounds: Array.from({ length: count }, () => null as number | null),
            evaluate,
        });
        this.#solverRun = {
            engine,
            model,
            objective,
            changing,
            originals,
            objectiveBefore,
            goal: values.goal,
            target,
            finished: false,
            restored: false,
            timer: undefined,
        };
        this.#shell?.setSolverError(null);
        this.#shell?.setSolverSolving(true);
        this.setStatus('Solving…');
        this.#solverRun.timer = window.setTimeout(() => {
            void this.runSolverSlice();
        }, 0);
    }

    /** Run one slice of the stepwise engine, then schedule the next. */
    private async runSolverSlice(): Promise<void> {
        const run = this.#solverRun;
        if (run === null || run.finished) {
            return;
        }
        let finished = false;
        for (let index = 0; index < CONFIG.SOLVER_STEPS_PER_SLICE; index++) {
            // A cancel (or a new run) clears #solverRun mid-slice: stop.
            if (this.#solverRun !== run) {
                return;
            }
            if (await run.engine.step()) {
                finished = true;
                break;
            }
        }
        if (this.#solverRun !== run) {
            return;
        }
        const state = run.engine.getState();
        this.#shell?.setSolverProgress(
            `Iteration ${state.iterations} — ${state.evaluations} evaluations — objective ${formatSolverNumber(state.bestObjective)}`,
        );
        if (finished) {
            void this.finishSolverRun();
        } else {
            run.timer = window.setTimeout(() => {
                void this.runSolverSlice();
            }, 0);
        }
    }

    /** A run finished: apply the solution (when there is one) and show results. */
    private async finishSolverRun(): Promise<void> {
        const run = this.#solverRun;
        if (run === null) {
            return;
        }
        run.finished = true;
        window.clearTimeout(run.timer);
        const state = run.engine.getState();
        const { model, objective, changing, originals } = run;
        let objectiveAfter: number | null = null;
        let message = '';
        if (state.status === 'optimal' || state.status === 'max-iterations') {
            const objectiveBeforeWrite = model.readCell(objective);
            if (state.bestX.length > 0) {
                model.writeValues(changing, state.bestX);
            }
            // The write lands synchronously but the formula recalculates
            // asynchronously, so read only after the value has settled.
            await model.settle(objective, objectiveBeforeWrite);
            objectiveAfter = model.readCell(objective);
            if (state.status === 'max-iterations') {
                message =
                    'The solver stopped at the iteration limit; the values shown are the best found so far.';
            }
        } else {
            // Infeasible, unbounded, or cancelled: no solution to keep.
            const objectiveBeforeWrite = model.readCell(objective);
            if (!run.restored) {
                model.writeOriginals(changing, originals);
                run.restored = true;
            }
            await model.settle(objective, objectiveBeforeWrite);
            objectiveAfter = model.readCell(objective);
            if (state.status === 'infeasible') {
                message = 'No point satisfies all the constraints; the original values were restored.';
            } else if (state.status === 'unbounded') {
                message =
                    'The objective kept improving with no bound, so no solution was kept and the original values were restored.';
            } else {
                message = 'The solve was cancelled; the original values were restored.';
            }
        }
        const statusLabels: Record<string, string> = {
            optimal: 'Optimal solution found',
            'max-iterations': 'Stopped at the iteration limit',
            infeasible: 'Infeasible — no point satisfies all constraints',
            unbounded: 'Unbounded — the objective keeps improving',
            cancelled: 'Cancelled',
        };
        const statusLabel = statusLabels[state.status] ?? state.status;
        // A kept solution that barely improved the objective means the
        // start was already (near-)optimal — say so in the results view.
        // Only a converged solve can show it: a run that stopped at the
        // iteration limit may still have been climbing, so a small
        // improvement there says nothing about the start. Restored runs
        // (infeasible, unbounded, cancelled) never show it.
        const alreadyOptimal =
            state.status === 'optimal' &&
            isEssentiallyOptimal(run.goal, run.objectiveBefore, objectiveAfter, run.target);
        this.#shell?.showSolverResults({
            status: statusLabel,
            message,
            objectiveBefore: formatSolverNumber(run.objectiveBefore),
            objectiveAfter: formatSolverNumber(objectiveAfter),
            iterations: state.iterations,
            evaluations: state.evaluations,
            alreadyOptimal,
        });
        if (state.status === 'infeasible') {
            this.setStatus(CONFIG.STATUS_SOLVER_INFEASIBLE);
        } else if (state.status === 'cancelled') {
            this.setStatus(CONFIG.STATUS_SOLVER_CANCELLED);
        } else {
            this.setStatus(
                `Solver finished: ${statusLabel.toLowerCase()} — objective ${formatSolverNumber(objectiveAfter)} (was ${formatSolverNumber(run.objectiveBefore)}).`,
            );
        }
    }

    /** Cancel a running solve, restore the originals, and close the dialog. */
    private handleSolverCancelRun(): void {
        const run = this.#solverRun;
        if (run === null) {
            return;
        }
        this.#solverRun = null;
        window.clearTimeout(run.timer);
        run.engine.cancel();
        // Flag the model first: an evaluation already in flight must not
        // write another trial over the originals being restored.
        run.model.cancel();
        if (!run.restored) {
            run.model.writeOriginals(run.changing, run.originals);
            run.restored = true;
        }
        this.#shell?.setSolverSolving(false);
        this.#shell?.setSolverProgress(null);
        this.#shell?.closeSolverDialog();
        this.setStatus(CONFIG.STATUS_SOLVER_CANCELLED);
    }

    /** Keep Solution: the solved values stay in the sheet; close the dialog. */
    private handleSolverKeep(): void {
        const run = this.#solverRun;
        this.#solverRun = null;
        if (run !== null) {
            window.clearTimeout(run.timer);
        }
        this.#shell?.closeSolverDialog();
    }

    /** Restore Original Values: write the pre-solve values back; close the dialog. */
    private handleSolverRestore(): void {
        const run = this.#solverRun;
        this.#solverRun = null;
        if (run !== null) {
            window.clearTimeout(run.timer);
            if (!run.restored) {
                run.model.writeOriginals(run.changing, run.originals);
                run.restored = true;
            }
        }
        this.#shell?.closeSolverDialog();
        this.setStatus(CONFIG.STATUS_SOLVER_RESTORED);
    }

    /** The dialog closed without a button deciding the outcome. */
    private handleSolverDialogClosed(): void {
        const run = this.#solverRun;
        if (run === null) {
            return;
        }
        if (!run.finished) {
            // Dismissed mid-solve (Esc, backdrop, or Close): cancel it.
            this.handleSolverCancelRun();
            return;
        }
        // Dismissed on the results view: the solution stays (same as Keep).
        this.#solverRun = null;
    }

    private setStatus(message: string): void {
        this.#statusMessage = message;
        this.#shell?.setStatus(message);
    }

    private exposeDebugHandle(): void {
        const handle: AiOfficeDebugHandle = {
            setCell: (address, value) => {
                this.#workbook
                    ?.getSheetByName(CONFIG.SHEET_NAME)
                    ?.getRange(address)
                    .setValue(value);
            },
            getStatus: () => this.#statusMessage,
            inspectCell: (address) => {
                const sheet = this.#workbook?.getSheetByName(CONFIG.SHEET_NAME);
                if (sheet === null || sheet === undefined) {
                    return null;
                }
                const range = sheet.getRange(address);
                return {
                    value: range.getValue(),
                    rawValue: range.getRawValue(),
                    formula: range.getFormula(),
                    displayValue: range.getDisplayValue(),
                };
            },
            listSheets: () =>
                this.#workbook?.getSheets().map((sheet) => sheet.getSheetName()) ?? [],
            getSignedInUser: () => this.#signedInUser,
            isSignInConfigured: () => isSignInConfigured(),
        };
        (window as unknown as { __aiOffice?: AiOfficeDebugHandle }).__aiOffice = handle;
    }
}
