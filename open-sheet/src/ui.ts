/**
 * The app shell: toolbar, status line, the reset-confirmation dialog, and
 * the Solver dialog. Only the shell is ours — the spreadsheet grid itself
 * is rendered by Univer, so no Modern Web Guidance rule is applied inside it.
 *
 * Applied guides (see the delivery disclosure):
 * - toolbar: role="toolbar", one tab stop via focusgroup with a roving-tabindex
 *   fallback, icon-only buttons keep their aria-label, action buttons have no
 *   aria-pressed, feedback goes to the status live region.
 * - dialog + light-dismiss-a-dialog: native <dialog> with closedby="any",
 *   autofocus on the safe action, returnValue read in the close listener,
 *   backdrop-click fallback where closedby is unsupported.
 * - css: cascade layers and design tokens live in style.css.
 */

import type { SignedInUser } from './auth';
import { CONFIG } from './config';

export type ShellActions = {
    onSave: () => void;
    onExport: () => void;
    /** Called with true when the user confirms the reset, false otherwise. */
    onResetDecision: (confirmed: boolean) => void;
    /** A file was picked in the Open picker. */
    onOpenFile: (file: File) => void;
    /** Called with true when the user confirms opening it, false otherwise. */
    onOpenDecision: (confirmed: boolean) => void;
    /** The fallback Sign in button was clicked. */
    onSignIn: () => void;
    /** The Sign out button was clicked. */
    onSignOut: () => void;
    /** The Solver toolbar button was clicked. */
    onSolverOpen: () => void;
    /** Solve was requested with the dialog's current inputs. */
    onSolverSolve: (values: SolverFormValues, constraints: SolverConstraintInput[]) => void;
    /** Cancel was clicked while a solve was running. */
    onSolverCancelRun: () => void;
    /** Keep Solution was clicked after a solve finished. */
    onSolverKeep: () => void;
    /** Restore Original Values was clicked after a solve finished. */
    onSolverRestore: () => void;
    /** The Solver dialog closed without a button deciding the outcome. */
    onSolverDialogClosed: () => void;
};

/** What the user wants the Solver to do with the objective cell. */
export type SolverGoalInput = 'max' | 'min' | 'value';

/** The Solver dialog's inputs (the constraint list travels separately). */
export type SolverFormValues = {
    objective: string;
    goal: SolverGoalInput;
    targetValue: string;
    changing: string;
    nonNegative: boolean;
    method: string;
};

/** One row of the dialog's constraint list, exactly as typed. */
export type SolverConstraintInput = {
    left: string;
    operator: string;
    right: string;
};

/** The finished-solve view shown in the Solver dialog. */
export type SolverResultView = {
    status: string;
    message: string;
    objectiveBefore: string;
    objectiveAfter: string;
    iterations: number;
    evaluations: number;
    /** The objective barely improved: the start was already (near-)optimal. */
    alreadyOptimal: boolean;
};

export type Shell = {
    setStatus: (message: string) => void;
    openResetDialog: () => void;
    /** Ask whether to replace the workbook with the picked file's contents. */
    openConfirmDialog: (fileName: string) => void;
    /** Show the signed-in state (name + avatar, Sign out button). */
    setSignedIn: (user: SignedInUser) => void;
    /** Show the signed-out state (Sign in button, or Google's button). */
    setSignedOut: () => void;
    /** Hide the fallback Sign in button once Google's button has rendered. */
    setGoogleButtonRendered: (rendered: boolean) => void;
    /** The slot Google's own sign-in button renders into. */
    getGoogleButtonSlot: () => HTMLElement;
    /** Show the Solver dialog, prefilled with the last-used parameters. */
    openSolverDialog: (prefill: SolverFormValues & { constraints: SolverConstraintInput[] }) => void;
    /** Show a validation message in the Solver dialog (null clears it). */
    setSolverError: (message: string | null) => void;
    /** Show or hide the solving state (progress line, Cancel, disabled Solve). */
    setSolverSolving: (solving: boolean) => void;
    /** Show the current solving progress (null hides the line). */
    setSolverProgress: (message: string | null) => void;
    /** Replace the Solver form with the finished-solve results view. */
    showSolverResults: (result: SolverResultView) => void;
    /** Close the Solver dialog if it is open. */
    closeSolverDialog: () => void;
};

/** All toolbar buttons carry one of these actions. */
const TOOLBAR_ACTIONS = ['save', 'open', 'export', 'reset', 'solver', 'signin', 'signout'] as const;
type ToolbarAction = (typeof TOOLBAR_ACTIONS)[number];

function isToolbarAction(value: string | null): value is ToolbarAction {
    return value !== null && (TOOLBAR_ACTIONS as readonly string[]).includes(value);
}

/**
 * Install a roving-tabindex fallback for toolbars where the focusgroup
 * attribute is unsupported (Chrome 150+ / Edge 150+ only, at time of writing).
 * Only one button is in the tab order; arrow keys move focus within the group.
 */
function installFocusgroupFallback(toolbar: HTMLElement): void {
    if ('focusGroup' in HTMLElement.prototype) {
        return;
    }
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button'));
    buttons.forEach((button, index) => {
        button.tabIndex = index === 0 ? 0 : -1;
    });
    toolbar.addEventListener('keydown', (event) => {
        const current = document.activeElement;
        // Only visible buttons take part: Sign out is hidden while signed
        // out, and the fallback Sign in is hidden once Google's button renders.
        const visible = buttons.filter((button) => !button.classList.contains('hidden'));
        if (!(current instanceof HTMLButtonElement) || !visible.includes(current)) {
            return;
        }
        const index = visible.indexOf(current);
        let next: number | null = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            next = (index + 1) % visible.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            next = (index - 1 + visible.length) % visible.length;
        } else if (event.key === 'Home') {
            next = 0;
        } else if (event.key === 'End') {
            next = visible.length - 1;
        }
        if (next === null) {
            return;
        }
        event.preventDefault();
        for (const button of buttons) {
            button.tabIndex = button === visible[next] ? 0 : -1;
        }
        visible[next].focus();
    });
}

/**
 * Backdrop-click (light dismiss) fallback for <dialog closedby="any">
 * where the attribute is unsupported (Safari, at time of writing).
 * Both pointerdown and pointerup must land outside the dialog, so a
 * text-selection drag ending on the backdrop does not dismiss it.
 */
function installLightDismissFallback(dialog: HTMLDialogElement): void {
    if ('closedBy' in HTMLDialogElement.prototype) {
        return;
    }
    let pointerDownOutside = false;
    dialog.addEventListener('pointerdown', (event) => {
        pointerDownOutside = event.target === dialog;
    });
    dialog.addEventListener('pointerup', (event) => {
        if (pointerDownOutside && event.target === dialog) {
            dialog.close();
        }
        pointerDownOutside = false;
    });
}

/** Point every <use data-icon> in the shell at the bundled sprite file. */
function wireSprite(spriteUrl: string): void {
    for (const use of document.querySelectorAll<SVGUseElement>('use[data-icon]')) {
        const icon = use.getAttribute('data-icon');
        if (icon !== null) {
            use.setAttribute('href', `${spriteUrl}#${icon}`);
        }
    }
}

/** Build the shell: wire the toolbar, status line, and reset dialog. */
export function createShell(spriteUrl: string, actions: ShellActions): Shell {
    const toolbar = document.querySelector<HTMLElement>('#app-toolbar');
    const status = document.querySelector<HTMLElement>('#status');
    const dialog = document.querySelector<HTMLDialogElement>('#reset-dialog');
    const openDialog = document.querySelector<HTMLDialogElement>('#open-dialog');
    const openFileName = document.querySelector<HTMLElement>('#open-file-name');
    const fileInput = document.querySelector<HTMLInputElement>('#open-file-input');
    const googleSlot = document.querySelector<HTMLElement>('#google-signin-button');
    const signinButton = document.querySelector<HTMLButtonElement>('#signin-button');
    const signoutButton = document.querySelector<HTMLButtonElement>('#signout-button');
    const signedInUser = document.querySelector<HTMLElement>('#signed-in-user');
    const signedInAvatar = document.querySelector<HTMLImageElement>('#signed-in-avatar');
    const signedInName = document.querySelector<HTMLElement>('#signed-in-name');
    const solverDialog = document.querySelector<HTMLDialogElement>('#solver-dialog');
    const solverForm = document.querySelector<HTMLFormElement>('#solver-form');
    const solverObjective = document.querySelector<HTMLInputElement>('#solver-objective');
    const solverTarget = document.querySelector<HTMLInputElement>('#solver-target');
    const solverChanging = document.querySelector<HTMLInputElement>('#solver-changing');
    const solverNonNegative = document.querySelector<HTMLInputElement>('#solver-nonnegative');
    const solverMethod = document.querySelector<HTMLSelectElement>('#solver-method');
    const solverError = document.querySelector<HTMLElement>('#solver-error');
    const solverProgress = document.querySelector<HTMLElement>('#solver-progress');
    const solverConstraintsList = document.querySelector<HTMLElement>('#solver-constraints');
    const solverConstraintLeft = document.querySelector<HTMLInputElement>('#solver-constraint-left');
    const solverConstraintOperator =
        document.querySelector<HTMLSelectElement>('#solver-constraint-operator');
    const solverConstraintRight =
        document.querySelector<HTMLInputElement>('#solver-constraint-right');
    const solverAddConstraint = document.querySelector<HTMLButtonElement>('#solver-add-constraint');
    const solverChangeConstraint =
        document.querySelector<HTMLButtonElement>('#solver-change-constraint');
    const solverDeleteConstraint =
        document.querySelector<HTMLButtonElement>('#solver-delete-constraint');
    const solverSolveButton = document.querySelector<HTMLButtonElement>('#solver-solve');
    const solverCancelRunButton = document.querySelector<HTMLButtonElement>('#solver-cancel-run');
    const solverCloseButton = document.querySelector<HTMLButtonElement>('#solver-close');
    const solverResults = document.querySelector<HTMLElement>('#solver-results');
    const solverResultsList = document.querySelector<HTMLElement>('#solver-results-list');
    const solverOptimalNote = document.querySelector<HTMLElement>('#solver-optimal-note');
    const solverKeepButton = document.querySelector<HTMLButtonElement>('#solver-keep');
    const solverRestoreButton = document.querySelector<HTMLButtonElement>('#solver-restore');
    if (
        toolbar === null ||
        status === null ||
        dialog === null ||
        openDialog === null ||
        openFileName === null ||
        fileInput === null ||
        googleSlot === null ||
        signinButton === null ||
        signoutButton === null ||
        signedInUser === null ||
        signedInAvatar === null ||
        signedInName === null ||
        solverDialog === null ||
        solverForm === null ||
        solverObjective === null ||
        solverTarget === null ||
        solverChanging === null ||
        solverNonNegative === null ||
        solverMethod === null ||
        solverError === null ||
        solverProgress === null ||
        solverConstraintsList === null ||
        solverConstraintLeft === null ||
        solverConstraintOperator === null ||
        solverConstraintRight === null ||
        solverAddConstraint === null ||
        solverChangeConstraint === null ||
        solverDeleteConstraint === null ||
        solverSolveButton === null ||
        solverCancelRunButton === null ||
        solverCloseButton === null ||
        solverResults === null ||
        solverResultsList === null ||
        solverOptimalNote === null ||
        solverKeepButton === null ||
        solverRestoreButton === null
    ) {
        throw new Error('App shell markup is missing (toolbar, status, dialog, or account area).');
    }

    // Whether Google's own button has rendered into the slot. The signed-out
    // view shows the slot when true, the fallback Sign in button otherwise.
    let googleButtonRendered = false;

    // The Solver dialog's constraint list lives here (form state, owned by
    // the shell); the app reads the finished list when Solve is clicked.
    let solverConstraints: SolverConstraintInput[] = [];
    let selectedConstraint: number | null = null;

    /** Render the constraint list from the shell's list state. */
    const renderSolverConstraints = (): void => {
        solverConstraintsList.replaceChildren();
        if (solverConstraints.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'solver-empty';
            empty.textContent = 'No constraints yet.';
            solverConstraintsList.append(empty);
            return;
        }
        solverConstraints.forEach((constraint, index) => {
            const item = document.createElement('li');
            item.dataset.index = String(index);
            if (index === selectedConstraint) {
                item.classList.add('selected');
            }
            item.textContent = `${constraint.left} ${constraint.operator} ${constraint.right}`;
            solverConstraintsList.append(item);
        });
    }

    /** Read the constraint edit row (null when either side is blank). */
    const readConstraintEdit = (): SolverConstraintInput | null => {
        const left = solverConstraintLeft.value.trim();
        const right = solverConstraintRight.value.trim();
        if (left === '' || right === '') {
            return null;
        }
        return { left, operator: solverConstraintOperator.value, right };
    }

    /** Fill the constraint edit row from a list entry. */
    const fillConstraintEdit = (constraint: SolverConstraintInput): void => {
        solverConstraintLeft.value = constraint.left;
        solverConstraintOperator.value = constraint.operator;
        solverConstraintRight.value = constraint.right;
    }

    /** Read the dialog's goal radio (defaults to Max when none is checked). */
    const readSolverGoal = (): SolverGoalInput => {
        const checked = solverForm.querySelector<HTMLInputElement>(
            'input[name="solver-goal"]:checked',
        );
        const value = checked?.value ?? 'max';
        return value === 'min' || value === 'value' ? value : 'max';
    }

    /** Enable the target input only when Value Of is the selected goal. */
    const syncSolverTarget = (): void => {
        solverTarget.disabled = readSolverGoal() !== 'value';
    }

    /** Read the whole Solver form (the constraint list travels separately). */
    const readSolverForm = (): SolverFormValues => {
        return {
            objective: solverObjective.value.trim(),
            goal: readSolverGoal(),
            targetValue: solverTarget.value.trim(),
            changing: solverChanging.value.trim(),
            nonNegative: solverNonNegative.checked,
            method: solverMethod.value,
        };
    }

    /** Show or clear the inline validation message in the Solver dialog. */
    const setSolverErrorText = (message: string | null): void => {
        solverError.textContent = message ?? '';
        solverError.classList.toggle('hidden', message === null);
    }

    /** Show or hide the solving state on the dialog's buttons and inputs. */
    const setSolverSolvingState = (solving: boolean): void => {
        solverSolveButton.disabled = solving;
        solverAddConstraint.disabled = solving;
        solverChangeConstraint.disabled = solving;
        solverDeleteConstraint.disabled = solving;
        solverObjective.disabled = solving;
        solverChanging.disabled = solving;
        solverTarget.disabled = solving || readSolverGoal() !== 'value';
        solverNonNegative.disabled = solving;
        solverMethod.disabled = solving;
        solverCancelRunButton.classList.toggle('hidden', !solving);
    }

/** Results-view note shown when the start was already (near-)optimal. */
const SOLVER_ALREADY_OPTIMAL_NOTE =
    'Your current values are already (near-)optimal — the solution is essentially your starting values.';

    /** Swap the dialog between its parameter form and its results view. */
    const showSolverForm = (): void => {
        solverForm.classList.remove('hidden');
        solverResults.classList.add('hidden');
        solverOptimalNote.textContent = '';
        solverOptimalNote.classList.add('hidden');
    }

    const showSolverResultsView = (result: SolverResultView): void => {
        solverForm.classList.add('hidden');
        solverResultsList.replaceChildren();
        const rows: [string, string][] = [
            ['Status', result.status],
            ['Objective before', result.objectiveBefore],
            ['Objective after', result.objectiveAfter],
            ['Iterations', String(result.iterations)],
            ['Evaluations', String(result.evaluations)],
        ];
        if (result.message !== '') {
            rows.push(['Note', result.message]);
        }
        for (const [term, value] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = term;
            const dd = document.createElement('dd');
            dd.textContent = value;
            solverResultsList.append(dt, dd);
        }
        solverOptimalNote.textContent = result.alreadyOptimal ? SOLVER_ALREADY_OPTIMAL_NOTE : '';
        solverOptimalNote.classList.toggle('hidden', !result.alreadyOptimal);
        solverResults.classList.remove('hidden');
        solverKeepButton.focus();
    }

    wireSprite(spriteUrl);
    installFocusgroupFallback(toolbar);
    installLightDismissFallback(dialog);
    installLightDismissFallback(openDialog);
    // The Solver dialog is modeless (show, not showModal) so the sheet
    // stays interactive while it is open; it has closedby="closerequest",
    // so Esc closes it and a click outside does not dismiss it. No light
    // dismiss fallback: an outside click must never close it mid-solve.
    fileInput.accept = CONFIG.OPEN_ACCEPT;

    // One delegated click listener for the whole toolbar (see the skill:
    // event delegation, never a fresh listener per button).
    toolbar.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest('button');
        if (button === null) {
            return;
        }
        const action = button.getAttribute('data-action');
        if (!isToolbarAction(action)) {
            return;
        }
        if (action === 'save') {
            actions.onSave();
        } else if (action === 'open') {
            fileInput.click();
        } else if (action === 'export') {
            actions.onExport();
        } else if (action === 'solver') {
            actions.onSolverOpen();
        } else if (action === 'signin') {
            actions.onSignIn();
        } else if (action === 'signout') {
            actions.onSignOut();
        } else {
            dialog.showModal();
        }
    });

    // The file picker reports through change; clearing the value lets the
    // user pick the same file again afterwards.
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file !== undefined) {
            actions.onOpenFile(file);
        }
    });

    // The dialog reports its outcome through returnValue; '' means dismissed
    // without choosing (Esc, backdrop click, or the close control).
    dialog.addEventListener('close', () => {
        const confirmed = dialog.returnValue === 'confirm';
        dialog.returnValue = '';
        actions.onResetDecision(confirmed);
    });

    openDialog.addEventListener('close', () => {
        const confirmed = openDialog.returnValue === 'confirm';
        openDialog.returnValue = '';
        actions.onOpenDecision(confirmed);
    });

    // The Solver form submits on Solve; the app validates and runs the solve.
    solverForm.addEventListener('submit', (event) => {
        event.preventDefault();
        setSolverErrorText(null);
        actions.onSolverSolve(readSolverForm(), [...solverConstraints]);
    });

    // The target value only applies to the Value Of goal.
    solverForm.addEventListener('change', (event) => {
        const input = event.target as HTMLElement;
        if (input instanceof HTMLInputElement && input.name === 'solver-goal') {
            syncSolverTarget();
        }
    });

    // One delegated listener for the constraint list: a row click selects it
    // and fills the edit row for Change or Delete.
    solverConstraintsList.addEventListener('click', (event) => {
        const item = (event.target as HTMLElement).closest('li');
        if (item === null || item.dataset.index === undefined) {
            return;
        }
        const index = Number(item.dataset.index);
        const constraint = solverConstraints[index];
        if (constraint === undefined) {
            return;
        }
        selectedConstraint = index;
        fillConstraintEdit(constraint);
        renderSolverConstraints();
    });

    solverAddConstraint.addEventListener('click', () => {
        const constraint = readConstraintEdit();
        if (constraint === null) {
            setSolverErrorText('Enter a cell or range and a number or cell for the constraint.');
            return;
        }
        solverConstraints.push(constraint);
        selectedConstraint = solverConstraints.length - 1;
        setSolverErrorText(null);
        renderSolverConstraints();
    });

    solverChangeConstraint.addEventListener('click', () => {
        if (selectedConstraint === null) {
            setSolverErrorText('Select a constraint to change first.');
            return;
        }
        const constraint = readConstraintEdit();
        if (constraint === null) {
            setSolverErrorText('Enter a cell or range and a number or cell for the constraint.');
            return;
        }
        solverConstraints[selectedConstraint] = constraint;
        setSolverErrorText(null);
        renderSolverConstraints();
    });

    solverDeleteConstraint.addEventListener('click', () => {
        if (selectedConstraint === null) {
            setSolverErrorText('Select a constraint to delete first.');
            return;
        }
        solverConstraints.splice(selectedConstraint, 1);
        selectedConstraint = null;
        solverConstraintLeft.value = '';
        solverConstraintRight.value = '';
        setSolverErrorText(null);
        renderSolverConstraints();
    });

    solverCancelRunButton.addEventListener('click', () => {
        actions.onSolverCancelRun();
    });

    solverCloseButton.addEventListener('click', () => {
        solverDialog.close();
    });

    solverKeepButton.addEventListener('click', () => {
        actions.onSolverKeep();
    });

    solverRestoreButton.addEventListener('click', () => {
        actions.onSolverRestore();
    });

    // Dismissing the dialog without a decision (Esc, backdrop, or the Close
    // button) is itself a decision the app must act on: cancel a running
    // solve, or keep a finished solution.
    solverDialog.addEventListener('close', () => {
        setSolverSolvingState(false);
        actions.onSolverDialogClosed();
    });

    return {
        setStatus(message: string): void {
            status.textContent = message;
        },
        openResetDialog(): void {
            dialog.showModal();
        },
        openConfirmDialog(fileName: string): void {
            openFileName.textContent = fileName;
            openDialog.showModal();
        },
        setSignedIn(user: SignedInUser): void {
            googleSlot.classList.add('hidden');
            signinButton.classList.add('hidden');
            if (user.picture !== '') {
                signedInAvatar.src = user.picture;
                signedInAvatar.classList.remove('hidden');
            } else {
                signedInAvatar.removeAttribute('src');
                signedInAvatar.classList.add('hidden');
            }
            signedInName.textContent = user.name;
            signedInUser.classList.remove('hidden');
            signoutButton.classList.remove('hidden');
        },
        setSignedOut(): void {
            signedInUser.classList.add('hidden');
            signoutButton.classList.add('hidden');
            signedInAvatar.removeAttribute('src');
            signedInName.textContent = '';
            if (googleButtonRendered) {
                googleSlot.classList.remove('hidden');
                signinButton.classList.add('hidden');
            } else {
                googleSlot.classList.add('hidden');
                signinButton.classList.remove('hidden');
            }
        },
        setGoogleButtonRendered(rendered: boolean): void {
            googleButtonRendered = rendered;
            if (rendered) {
                googleSlot.classList.remove('hidden');
                signinButton.classList.add('hidden');
            }
        },
        getGoogleButtonSlot(): HTMLElement {
            return googleSlot;
        },
        openSolverDialog(prefill: SolverFormValues & { constraints: SolverConstraintInput[] }): void {
            // Modeless: reopening while it is already open just focuses
            // it — never reset the form mid-solve or discard a finished
            // result, and never call show() on an open dialog (it throws).
            if (solverDialog.open) {
                solverDialog.focus();
                return;
            }
            solverObjective.value = prefill.objective;
            solverChanging.value = prefill.changing;
            solverTarget.value = prefill.targetValue;
            solverNonNegative.checked = prefill.nonNegative;
            solverMethod.value = prefill.method;
            const goal = solverForm.querySelector<HTMLInputElement>(
                `input[name="solver-goal"][value="${prefill.goal}"]`,
            );
            if (goal !== null) {
                goal.checked = true;
            }
            solverConstraints = [...prefill.constraints];
            selectedConstraint = null;
            solverConstraintLeft.value = '';
            solverConstraintRight.value = '';
            setSolverErrorText(null);
            setSolverSolvingState(false);
            solverProgress.textContent = '';
            solverProgress.classList.add('hidden');
            showSolverForm();
            syncSolverTarget();
            renderSolverConstraints();
            // Modeless (show, not showModal): the sheet stays clickable
            // and editable while the dialog is open, before solving and
            // on the results view.
            solverDialog.show();
        },
        setSolverError(message: string | null): void {
            setSolverErrorText(message);
        },
        setSolverSolving(solving: boolean): void {
            setSolverSolvingState(solving);
        },
        setSolverProgress(message: string | null): void {
            solverProgress.textContent = message ?? '';
            solverProgress.classList.toggle('hidden', message === null);
        },
        showSolverResults(result: SolverResultView): void {
            setSolverSolvingState(false);
            solverProgress.textContent = '';
            solverProgress.classList.add('hidden');
            showSolverResultsView(result);
        },
        closeSolverDialog(): void {
            if (solverDialog.open) {
                solverDialog.close();
            }
        },
    };
}
