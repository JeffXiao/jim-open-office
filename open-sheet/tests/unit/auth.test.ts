/**
 * Unit tests for optional Google sign-in (src/auth.ts).
 * The security-relevant logic is pure — reading a user out of a Google ID
 * token (JWT) — so it is tested without a browser: malformed tokens, wrong
 * issuers, and expired tokens must all come back null, never throw.
 * Session storage is a small Map-backed stub; the GIS script itself
 * (window.google) is stubbed per test where the browser-only helpers need it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '../../src/auth';
import { CONFIG } from '../../src/config';

/** Build an unsigned JWT from a payload (signature is never checked here). */
function makeToken(payload: Record<string, unknown>): string {
    const encode = (value: unknown): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        name: 'Jeff Xiao',
        email: 'jeffx30@gmail.com',
        picture: 'https://example.com/pic.jpg',
        ...overrides,
    };
}

/** Map-backed sessionStorage stub. */
function installSessionStorage(): Map<string, string> {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string): string | null => store.get(key) ?? null,
        setItem: (key: string, value: string): void => {
            store.set(key, value);
        },
        removeItem: (key: string): void => {
            store.delete(key);
        },
    });
    return store;
}

describe('decodeCredential', () => {
    it('reads name, email, and picture from a valid token', () => {
        expect(decodeCredential(makeToken(validPayload()))).toEqual({
            name: 'Jeff Xiao',
            email: 'jeffx30@gmail.com',
            picture: 'https://example.com/pic.jpg',
        });
    });

    it('accepts the bare accounts.google.com issuer too', () => {
        const token = makeToken(validPayload({ iss: 'accounts.google.com' }));
        expect(decodeCredential(token)?.email).toBe('jeffx30@gmail.com');
    });

    it('defaults a missing picture to an empty string', () => {
        const payload = validPayload();
        delete payload['picture'];
        expect(decodeCredential(makeToken(payload))).toEqual({
            name: 'Jeff Xiao',
            email: 'jeffx30@gmail.com',
            picture: '',
        });
    });

    it('rejects a token from another issuer', () => {
        expect(decodeCredential(makeToken(validPayload({ iss: 'https://evil.example' })))).toBeNull();
    });

    it('rejects an expired token', () => {
        const expired = validPayload({ exp: Math.floor(Date.now() / 1000) - 60 });
        expect(decodeCredential(makeToken(expired))).toBeNull();
    });

    it('rejects a token with no expiry, or a non-numeric expiry', () => {
        const noExpiry = validPayload();
        delete noExpiry['exp'];
        expect(decodeCredential(makeToken(noExpiry))).toBeNull();
        expect(decodeCredential(makeToken(validPayload({ exp: '9999999999' })))).toBeNull();
    });

    it('rejects a token without a name or an email', () => {
        const noName = validPayload();
        delete noName['name'];
        expect(decodeCredential(makeToken(noName))).toBeNull();
        const noEmail = validPayload();
        delete noEmail['email'];
        expect(decodeCredential(makeToken(noEmail))).toBeNull();
        expect(decodeCredential(makeToken(validPayload({ name: 42 })))).toBeNull();
    });

    it('rejects malformed tokens instead of throwing', () => {
        expect(decodeCredential('not-a-token')).toBeNull();
        expect(decodeCredential('a.b')).toBeNull();
        expect(decodeCredential('a.b.c.d')).toBeNull();
        expect(decodeCredential('!!!.@@@.###')).toBeNull();
        const notJson = `header.${Buffer.from('not json').toString('base64url')}.sig`;
        expect(decodeCredential(notJson)).toBeNull();
        const arrayPayload = `header.${Buffer.from('[1,2]').toString('base64url')}.sig`;
        expect(decodeCredential(arrayPayload)).toBeNull();
    });
});

describe('stored credential', () => {
    beforeEach(() => {
        installSessionStorage();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('stores a credential and loads the user back from it', () => {
        storeCredential(makeToken(validPayload()));
        expect(loadStoredUser()).toEqual({
            name: 'Jeff Xiao',
            email: 'jeffx30@gmail.com',
            picture: 'https://example.com/pic.jpg',
        });
    });

    it('forgets the user on sign-out', () => {
        storeCredential(makeToken(validPayload()));
        clearStoredCredential();
        expect(loadStoredUser()).toBeNull();
    });

    it('loads null when nothing is stored, or the stored JSON is garbage', () => {
        expect(loadStoredUser()).toBeNull();
        vi.stubGlobal('sessionStorage', {
            getItem: (): string => 'not json{{{',
            setItem: (): void => undefined,
            removeItem: (): void => undefined,
        });
        expect(loadStoredUser()).toBeNull();
    });

    it('loads null when the stored object has no credential string', () => {
        vi.stubGlobal('sessionStorage', {
            getItem: (): string => JSON.stringify({ nope: true }),
            setItem: (): void => undefined,
            removeItem: (): void => undefined,
        });
        expect(loadStoredUser()).toBeNull();
    });

    it('loads null when the stored credential has expired', () => {
        const expired = validPayload({ exp: Math.floor(Date.now() / 1000) - 60 });
        storeCredential(makeToken(expired));
        expect(loadStoredUser()).toBeNull();
    });

    it('storing does not throw when sessionStorage itself throws', () => {
        vi.stubGlobal('sessionStorage', {
            getItem: (): string | null => null,
            setItem: (): void => {
                throw new Error('storage full');
            },
            removeItem: (): void => {
                throw new Error('storage unavailable');
            },
        });
        expect(() => storeCredential(makeToken(validPayload()))).not.toThrow();
        expect(() => clearStoredCredential()).not.toThrow();
        expect(loadStoredUser()).toBeNull();
    });
});

describe('Google sign-in setup', () => {
    beforeEach(() => {
        vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('is not configured while the client ID is empty', () => {
        expect(CONFIG.GOOGLE_CLIENT_ID).toBe('');
        expect(isSignInConfigured()).toBe(false);
    });

    it('rendering the Google button returns false while unconfigured', () => {
        const slot = {} as unknown as HTMLElement;
        expect(renderGoogleButton(slot, () => undefined)).toBe(false);
    });

    it('the One Tap prompt returns false while unconfigured', () => {
        expect(promptGoogleSignIn()).toBe(false);
    });

    it('disabling auto-select does not throw when GIS never loaded', () => {
        expect(() => disableGoogleAutoSelect()).not.toThrow();
    });

    it('waits for GIS: true at once when the script is already loaded', async () => {
        vi.stubGlobal('window', {
            setTimeout: globalThis.setTimeout,
            google: { accounts: { id: {} } },
        });
        await expect(waitForGoogleSignIn()).resolves.toBe(true);
    });

    it('waits for GIS: false after the timeout when the script never loads', async () => {
        vi.useFakeTimers();
        const pending = waitForGoogleSignIn();
        await vi.advanceTimersByTimeAsync(CONFIG.GIS_WAIT_TIMEOUT_MS + 1000);
        await expect(pending).resolves.toBe(false);
    });
});
