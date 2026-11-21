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
};

/** All toolbar buttons carry one of these actions. */
const TOOLBAR_ACTIONS = ['save', 'open', 'export', 'reset', 'signin', 'signout'] as const;
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
        signedInName === null
    ) {
        throw new Error('App shell markup is missing (toolbar, status, dialog, or account area).');
    }

    // Whether Google's own button has rendered into the slot. The signed-out
    // view shows the slot when true, the fallback Sign in button otherwise.
    let googleButtonRendered = false;

    wireSprite(spriteUrl);
    installFocusgroupFallback(toolbar);
    installLightDismissFallback(dialog);
    installLightDismissFallback(openDialog);
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
    };
}
