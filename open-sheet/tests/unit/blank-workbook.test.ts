/**
 * Unit tests for the blank workbook (src/blank-workbook.ts).
 * The blank workbook is the whole starting point of the app since the
 * Sharpe template was removed, so these tests pin its shape — and carry the
 * hard constraint that no Sharpe content may come back, as a regression
 * test rather than a comment.
 */
import { describe, expect, it } from 'vitest';
import { buildBlankWorkbookSnapshot } from '../../src/blank-workbook';
import { CONFIG } from '../../src/config';
import { LocaleType } from '@univerjs/core';

describe('buildBlankWorkbookSnapshot', () => {
    it('builds one empty sheet called Sheet1', () => {
        const snapshot = buildBlankWorkbookSnapshot();
        expect(snapshot.id).toBe(CONFIG.WORKBOOK_ID);
        expect(snapshot.name).toBe(CONFIG.WORKBOOK_NAME);
        expect(snapshot.appVersion).toBe(CONFIG.UNIVER_VERSION);
        expect(snapshot.locale).toBe(LocaleType.EN_US);
        expect(snapshot.styles).toEqual({});
        expect(snapshot.sheetOrder).toEqual([CONFIG.SHEET_ID]);
        const sheet = snapshot.sheets[CONFIG.SHEET_ID];
        expect(sheet).toBeDefined();
        expect(sheet?.name).toBe(CONFIG.SHEET_NAME);
        expect(sheet?.cellData).toEqual({});
        expect(sheet?.rowCount).toBe(100);
        expect(sheet?.columnCount).toBe(26);
    });

    it('returns a fresh object every time, so edits never leak between opens', () => {
        const first = buildBlankWorkbookSnapshot();
        const firstSheet = first.sheets[CONFIG.SHEET_ID];
        if (firstSheet?.cellData !== undefined) {
            firstSheet.cellData['0'] = { '0': { v: 42 } };
        }
        const second = buildBlankWorkbookSnapshot();
        expect(second.sheets[CONFIG.SHEET_ID]?.cellData).toEqual({});
        expect(second).not.toBe(first);
    });

    it('contains no Sharpe content anywhere — the removal is a hard constraint', () => {
        const snapshot = buildBlankWorkbookSnapshot();
        const text = JSON.stringify(snapshot);
        expect(text.toLowerCase()).not.toContain('sharpe');
        const sheetNames = snapshot.sheetOrder.map(
            (id) => snapshot.sheets[id]?.name ?? id,
        );
        expect(sheetNames).toEqual(['Sheet1']);
        expect(sheetNames.join(' ').toLowerCase()).not.toContain('sharpe');
    });
});
