/**
 * The app shell: toolbar, status line, and the reset-confirmation dialog.
 * Only the shell is ours — the spreadsheet grid itself is rendered by Univer,
 * so no Modern Web Guidance rule is applied inside it.
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

export type ShellActions = {
    onSave: () => void;
    onExport: () => void;
    /** Called with true when the user confirms the reset, false otherwise. */
    onResetDecision: (confirmed: boolean) => void;
};

export type Shell = {
    setStatus: (message: string) => void;
    openResetDialog: () => void;
};

/** All toolbar buttons carry one of these actions. */
const TOOLBAR_ACTIONS = ['save', 'export', 'reset'] as const;
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
        if (!(current instanceof HTMLButtonElement) || !buttons.includes(current)) {
            return;
        }
        const index = buttons.indexOf(current);
        let next: number | null = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            next = (index + 1) % buttons.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            next = (index - 1 + buttons.length) % buttons.length;
        } else if (event.key === 'Home') {
            next = 0;
        } else if (event.key === 'End') {
            next = buttons.length - 1;
        }
        if (next === null) {
            return;
        }
        event.preventDefault();
        buttons.forEach((button, buttonIndex) => {
            button.tabIndex = buttonIndex === next ? 0 : -1;
        });
        buttons[next].focus();
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
    if (toolbar === null || status === null || dialog === null) {
        throw new Error('App shell markup is missing (toolbar, status, or dialog).');
    }

    wireSprite(spriteUrl);
    installFocusgroupFallback(toolbar);
    installLightDismissFallback(dialog);

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
        } else if (action === 'export') {
            actions.onExport();
        } else {
            dialog.showModal();
        }
    });

    // The dialog reports its outcome through returnValue; '' means dismissed
    // without choosing (Esc, backdrop click, or the close control).
    dialog.addEventListener('close', () => {
        const confirmed = dialog.returnValue === 'confirm';
        dialog.returnValue = '';
        actions.onResetDecision(confirmed);
    });

    return {
        setStatus(message: string): void {
            status.textContent = message;
        },
        openResetDialog(): void {
            dialog.showModal();
        },
    };
}
