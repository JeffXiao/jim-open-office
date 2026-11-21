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
import type { Shell } from './ui';

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
    #pendingOpen: { fileName: string; snapshot: IWorkbookData } | null = null;
    /** Null while signed out; signing in never gates the sheet. */
    #signedInUser: SignedInUser | null = null;

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
        let snapshot: IWorkbookData;
        try {
            snapshot = await readXlsxFile(file);
        } catch (error) {
            console.error('Failed to open the file.', error);
            this.setStatus(CONFIG.STATUS_OPEN_FAILED);
            return;
        }
        this.#pendingOpen = { fileName: file.name, snapshot };
        this.#shell?.openConfirmDialog(file.name);
    }

    /** Replace the workbook with the pending file, when the user confirms. */
    private async handleOpenDecision(confirmed: boolean): Promise<void> {
        const pending = this.#pendingOpen;
        this.#pendingOpen = null;
        if (!confirmed || pending === null) {
            return;
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
