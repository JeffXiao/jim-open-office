/**
 * The App: the single state owner for the whole page.
 * It owns the Univer instance, the workbook, and the shell; every change goes
 * through an explicit action (saveWorkbook, exportXlsx, resetTemplate).
 * The formula engine runs on the main thread (no workerURL): the preset only
 * uses a worker when one is given, and the Phase 1 proof of concept does not
 * need one.
 */
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import type { FUniver } from '@univerjs/presets';
import type { FWorkbook } from '@univerjs/preset-sheets-core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import { CONFIG } from './config';
import { buildSharpeTemplateSnapshot, SHARPE_RESULT_ADDRESS } from './sharpe-template';
import { deleteSnapshot, loadSnapshot, saveSnapshot } from './storage';
import { exportSnapshotToXlsx } from './exporter';
import { createShell } from './ui';
import type { Shell } from './ui';

/** Test/debug hook exposed on window (documented in the README). */
export type AiOfficeDebugHandle = {
    getSharpe: () => number | null;
    setCell: (address: string, value: number | string) => void;
    getStatus: () => string;
    inspectCell: (address: string) => {
        value: unknown;
        rawValue: unknown;
        formula: string;
        displayValue: string;
    } | null;
    listSheets: () => string[];
};

export class App {
    #univerAPI: FUniver | null = null;
    #workbook: FWorkbook | null = null;
    #shell: Shell | null = null;
    #saveTimer: number | undefined = undefined;
    #statusMessage: string = CONFIG.STATUS_LOADING;

    /** Create Univer, load the saved workbook (or the template), wire the shell. */
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
                    void this.resetTemplate();
                }
            },
        });

        const saved = await loadSnapshot().catch((error: unknown) => {
            console.error('Failed to load the saved workbook; starting from the template.', error);
            return null;
        });
        this.openWorkbook(saved ?? buildSharpeTemplateSnapshot());
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

    /** The Sharpe ratio currently calculated in the sheet, or null. */
    getSharpeValue(): number | null {
        const sheet = this.#workbook?.getSheetByName(CONFIG.SHEET_NAME);
        // getValue() returns the formatted display string ("1.8189") for a
        // cell with a number format; getRawValue() returns the number.
        const value = sheet?.getRange(SHARPE_RESULT_ADDRESS).getRawValue();
        return typeof value === 'number' ? value : null;
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

    /** Replace the workbook with a fresh Sharpe template. */
    private async resetTemplate(): Promise<void> {
        if (this.#univerAPI === null || this.#workbook === null) {
            return;
        }
        window.clearTimeout(this.#saveTimer);
        this.#univerAPI.disposeUnit(this.#workbook.getId());
        await deleteSnapshot().catch((error: unknown) => {
            console.error('Failed to delete the saved snapshot.', error);
        });
        this.openWorkbook(buildSharpeTemplateSnapshot());
        await this.saveWorkbook();
        this.setStatus(CONFIG.STATUS_RESET);
    }

    private setStatus(message: string): void {
        this.#statusMessage = message;
        this.#shell?.setStatus(message);
    }

    private exposeDebugHandle(): void {
        const handle: AiOfficeDebugHandle = {
            getSharpe: () => this.getSharpeValue(),
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
        };
        (window as unknown as { __aiOffice?: AiOfficeDebugHandle }).__aiOffice = handle;
    }
}
