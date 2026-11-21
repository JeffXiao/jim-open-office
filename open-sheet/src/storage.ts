/**
 * IndexedDB persistence for the workbook snapshot (Univer JSON).
 * One tiny promise wrapper — no library. The snapshot is stored as a plain
 * object under a single key, so save/load are just put/get.
 */
import type { IWorkbookData } from '@univerjs/core';
import { CONFIG } from './config';

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.IDB_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(CONFIG.IDB_STORE_NAME)) {
                request.result.createObjectStore(CONFIG.IDB_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function runTransaction(
    mode: IDBTransactionMode,
    task: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
    return openDatabase().then(
        (db) =>
            new Promise((resolve, reject) => {
                const tx = db.transaction(CONFIG.IDB_STORE_NAME, mode);
                const request = task(tx.objectStore(CONFIG.IDB_STORE_NAME));
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => db.close();
                tx.onerror = () => reject(tx.error);
            }),
    );
}

/** Save the workbook snapshot, overwriting the previous one. */
export function saveSnapshot(snapshot: IWorkbookData): Promise<void> {
    return runTransaction('readwrite', (store) =>
        store.put(snapshot, CONFIG.IDB_WORKBOOK_KEY),
    ).then(() => undefined);
}

/** Load the saved workbook snapshot, or null when nothing was saved yet. */
export function loadSnapshot(): Promise<IWorkbookData | null> {
    return runTransaction('readonly', (store) =>
        store.get(CONFIG.IDB_WORKBOOK_KEY),
    ).then((value) => (value as IWorkbookData | undefined) ?? null);
}

/** Delete the saved snapshot (used when resetting to a blank workbook). */
export function deleteSnapshot(): Promise<void> {
    return runTransaction('readwrite', (store) =>
        store.delete(CONFIG.IDB_WORKBOOK_KEY),
    ).then(() => undefined);
}
