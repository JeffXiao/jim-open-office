/**
 * Unit tests for IndexedDB persistence (src/storage.ts), run against the
 * in-memory IndexedDB stand-in in fake-indexeddb.ts — no browser needed.
 * The stand-in covers exactly the surface storage.ts uses, and each test
 * starts from an empty database.
 */
import { describe, expect, it } from 'vitest';
import { buildBlankWorkbookSnapshot } from '../../src/blank-workbook';
import { CONFIG } from '../../src/config';
import { deleteSnapshot, loadSnapshot, saveSnapshot } from '../../src/storage';
import { useFakeIndexedDB } from './fake-indexeddb';

describe('storage', () => {
    useFakeIndexedDB();

    it('loads null when nothing was saved yet', async () => {
        await expect(loadSnapshot()).resolves.toBeNull();
    });

    it('round-trips the blank workbook unchanged', async () => {
        const snapshot = buildBlankWorkbookSnapshot();
        await saveSnapshot(snapshot);
        await expect(loadSnapshot()).resolves.toEqual(snapshot);
    });

    it('round-trips a workbook with content, formulas, and styles', async () => {
        const snapshot = buildBlankWorkbookSnapshot();
        const sheet = snapshot.sheets[CONFIG.SHEET_ID];
        if (sheet !== undefined) {
            sheet.cellData = {
                '0': { '0': { v: 2 }, '1': { v: 3 } },
                '1': { '0': { v: 5, f: '=SUM(A1:B1)' } },
            };
        }
        snapshot.styles = { 'fmt-1': { n: { pattern: '0.00%' } } };
        await saveSnapshot(snapshot);
        await expect(loadSnapshot()).resolves.toEqual(snapshot);
    });

    it('overwrites the previous snapshot on save', async () => {
        await saveSnapshot(buildBlankWorkbookSnapshot());
        const edited = buildBlankWorkbookSnapshot();
        const sheet = edited.sheets[CONFIG.SHEET_ID];
        if (sheet !== undefined) {
            sheet.cellData = { '0': { '0': { v: 99 } } };
        }
        await saveSnapshot(edited);
        await expect(loadSnapshot()).resolves.toEqual(edited);
    });

    it('loads null again after delete', async () => {
        await saveSnapshot(buildBlankWorkbookSnapshot());
        await deleteSnapshot();
        await expect(loadSnapshot()).resolves.toBeNull();
    });

    it('deleting an empty store does not throw', async () => {
        await expect(deleteSnapshot()).resolves.toBeUndefined();
        await expect(loadSnapshot()).resolves.toBeNull();
    });
});
