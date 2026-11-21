/**
 * Unit tests for the frozen app config (src/config.ts).
 * Guards the web-development rule that every number lives in one frozen
 * config object, and pins the ids the workbook, storage, and export share.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';

describe('CONFIG', () => {
    it('is frozen, so no module can mutate it at runtime', () => {
        expect(Object.isFrozen(CONFIG)).toBe(true);
    });

    it('pins the Univer version the package.json pins', () => {
        expect(CONFIG.UNIVER_VERSION).toBe('1.5.2');
    });

    it('names the Univer mount point', () => {
        expect(CONFIG.UNIVER_CONTAINER_ID).toBe('univer-container');
    });

    it('names the IndexedDB database, store, and key', () => {
        expect(CONFIG.IDB_DB_NAME).toBe('jim-open-office');
        expect(CONFIG.IDB_STORE_NAME).toBe('workbooks');
        expect(CONFIG.IDB_WORKBOOK_KEY).toBe('workbook');
    });

    it('names the workbook and its single sheet', () => {
        expect(CONFIG.WORKBOOK_ID).toBe('open-sheet-workbook');
        expect(CONFIG.WORKBOOK_NAME).toBe('Untitled');
        expect(CONFIG.SHEET_ID).toBe('sheet-1');
        expect(CONFIG.SHEET_NAME).toBe('Sheet1');
    });

    it('waits 800 ms after the last edit before autosaving', () => {
        expect(CONFIG.AUTOSAVE_DELAY_MS).toBe(800);
    });

    it('exports as workbook.xlsx', () => {
        expect(CONFIG.EXPORT_FILE_NAME).toBe('workbook.xlsx');
    });

    it('has no Google client ID yet, so sign-in is unconfigured', () => {
        expect(CONFIG.GOOGLE_CLIENT_ID).toBe('');
    });

    it('keeps the signed-in identity under its own sessionStorage key', () => {
        expect(CONFIG.AUTH_STORAGE_KEY).toBe('open-sheet-auth');
    });

    it('has a non-empty status message for every state', () => {
        const messages = [
            CONFIG.STATUS_LOADING,
            CONFIG.STATUS_READY,
            CONFIG.STATUS_RESTORED,
            CONFIG.STATUS_SAVED,
            CONFIG.STATUS_EXPORTED,
            CONFIG.STATUS_EXPORT_FAILED,
            CONFIG.STATUS_RESET,
            CONFIG.STATUS_SAVE_FAILED,
            CONFIG.STATUS_SIGN_IN_NOT_SET_UP,
            CONFIG.STATUS_SIGN_IN_UNAVAILABLE,
            CONFIG.STATUS_SIGN_IN_FAILED,
            CONFIG.STATUS_SIGNED_OUT,
        ];
        for (const message of messages) {
            expect(typeof message).toBe('string');
            expect(message.length).toBeGreaterThan(0);
        }
    });
});
