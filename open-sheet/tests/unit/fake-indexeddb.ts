/**
 * Minimal in-memory IndexedDB stand-in, implementing only the surface
 * storage.ts uses: open() with onupgradeneeded/onsuccess, createObjectStore,
 * transaction().objectStore(), and put/get/delete requests.
 *
 * Each database lives in a process-wide map keyed by name, so a save in one
 * openDatabase() call is visible to a later load — exactly like the real
 * thing. Call resetFakeIndexedDB() between tests to start from empty.
 */
import { beforeEach } from 'vitest';

type RequestHandler = (event: { target: FakeIDBRequest }) => void;

export class FakeIDBRequest {
    result: unknown = undefined;
    error: unknown = null;
    onsuccess: RequestHandler | null = null;
    onerror: RequestHandler | null = null;

    /** Deliver a success result on the next microtask, like the real API. */
    succeed(result: unknown): void {
        this.result = result;
        queueMicrotask(() => {
            this.onsuccess?.({ target: this });
        });
    }

    /** Deliver an error on the next microtask, like the real API. */
    fail(error: unknown): void {
        this.error = error;
        queueMicrotask(() => {
            this.onerror?.({ target: this });
        });
    }
}

class FakeIDBObjectStore {
    readonly #data = new Map<unknown, unknown>();

    put(value: unknown, key: unknown): FakeIDBRequest {
        const request = new FakeIDBRequest();
        this.#data.set(key, value);
        request.succeed(key);
        return request;
    }

    get(key: unknown): FakeIDBRequest {
        const request = new FakeIDBRequest();
        request.succeed(this.#data.get(key));
        return request;
    }

    delete(key: unknown): FakeIDBRequest {
        const request = new FakeIDBRequest();
        this.#data.delete(key);
        request.succeed(undefined);
        return request;
    }
}

class FakeIDBTransaction {
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly #store: FakeIDBObjectStore;

    constructor(store: FakeIDBObjectStore) {
        this.#store = store;
        // Fire after the current synchronous work, so storage.ts has set
        // oncomplete by the time it runs — mirroring the real ordering.
        queueMicrotask(() => {
            this.oncomplete?.();
        });
    }

    objectStore(_name: string): FakeIDBObjectStore {
        return this.#store;
    }
}

class FakeIDBDatabase {
    readonly #stores = new Map<string, FakeIDBObjectStore>();
    readonly objectStoreNames = {
        contains: (name: string): boolean => this.#stores.has(name),
    };

    createObjectStore(name: string): FakeIDBObjectStore {
        const store = new FakeIDBObjectStore();
        this.#stores.set(name, store);
        return store;
    }

    transaction(storeName: string, _mode: IDBTransactionMode): FakeIDBTransaction {
        const store = this.#stores.get(storeName);
        if (store === undefined) {
            throw new Error(`No such object store: ${storeName}`);
        }
        return new FakeIDBTransaction(store);
    }

    close(): void {
        // In-memory: nothing to close.
    }
}

class FakeIDBOpenRequest extends FakeIDBRequest {
    onupgradeneeded: RequestHandler | null = null;

    constructor(database: FakeIDBDatabase, isNew: boolean) {
        super();
        this.result = database;
        queueMicrotask(() => {
            if (isNew) {
                this.onupgradeneeded?.({ target: this });
            }
            this.onsuccess?.({ target: this });
        });
    }
}

class FakeIDBFactory {
    readonly #databases = new Map<string, FakeIDBDatabase>();

    open(name: string, _version?: number): FakeIDBOpenRequest {
        const existing = this.#databases.get(name);
        if (existing !== undefined) {
            return new FakeIDBOpenRequest(existing, false);
        }
        const database = new FakeIDBDatabase();
        this.#databases.set(name, database);
        return new FakeIDBOpenRequest(database, true);
    }

    reset(): void {
        this.#databases.clear();
    }
}

export const fakeIndexedDB = new FakeIDBFactory();

/** Point the global indexedDB at the in-memory stand-in. */
export function installFakeIndexedDB(): void {
    (globalThis as unknown as { indexedDB: FakeIDBFactory }).indexedDB = fakeIndexedDB;
}

/** Drop every fake database, so each test starts from empty storage. */
export function resetFakeIndexedDB(): void {
    fakeIndexedDB.reset();
}

/** Install the stand-in and clear it before every test in the file. */
export function useFakeIndexedDB(): void {
    beforeEach(() => {
        installFakeIndexedDB();
        resetFakeIndexedDB();
    });
}
