/**
 * A blank workbook snapshot (IWorkbookData): one empty sheet, no content.
 * Pure data construction — no Univer code runs here, so the blank workbook
 * can be unit-checked without a browser. The user builds their own content.
 */
import type { IWorkbookData } from '@univerjs/core';
import { LocaleType } from '@univerjs/core';
import { CONFIG } from './config';

/** The blank workbook the app opens with when nothing is saved. */
export function buildBlankWorkbookSnapshot(): IWorkbookData {
    return {
        id: CONFIG.WORKBOOK_ID,
        name: CONFIG.WORKBOOK_NAME,
        appVersion: CONFIG.UNIVER_VERSION,
        locale: LocaleType.EN_US,
        styles: {},
        sheetOrder: [CONFIG.SHEET_ID],
        sheets: {
            [CONFIG.SHEET_ID]: {
                id: CONFIG.SHEET_ID,
                name: CONFIG.SHEET_NAME,
                cellData: {},
                rowCount: 100,
                columnCount: 26,
            },
        },
    };
}
