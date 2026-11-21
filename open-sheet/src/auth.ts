/**
 * Optional Google sign-in, via Google Identity Services (GIS).
 *
 * Sign-in is optional by design: the sheet works fully without it, and the
 * button never blocks the workbook. Signing in only identifies the user
 * (name, email, avatar from the Google ID token) — it does not gate the
 * sheet and does not separate workbooks per user. The identity lives in
 * sessionStorage, so closing the tab signs the user out.
 *
 * The GIS script is loaded from accounts.google.com in index.html. Everything
 * here tolerates it being absent (offline, blocked, or not configured yet)
 * and reports that through a boolean instead of throwing.
 */
import { CONFIG } from './config';

/** The signed-in user, as read from the Google ID token. */
export type SignedInUser = {
    name: string;
    email: string;
    picture: string;
};

/** Minimal structural type for the part of GIS we use. */
type GoogleAccountsId = {
    initialize: (config: {
        client_id: string;
        callback: (response: { credential: string }) => void;
        auto_select: boolean;
    }) => void;
    renderButton: (parent: HTMLElement, options: Record<string, string>) => void;
    prompt: () => void;
    disableAutoSelect: () => void;
};

declare global {
    interface Window {
        google?: { accounts: { id: GoogleAccountsId } };
    }
}

/** True once a Google OAuth client ID has been pasted into config.ts. */
export function isSignInConfigured(): boolean {
    return CONFIG.GOOGLE_CLIENT_ID !== '';
}

function decodeBase64Url(value: string): string | null {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (padded.length % 4)) % 4);
    try {
        return atob(padded + padding);
    } catch {
        return null;
    }
}

/**
 * Read the signed-in user out of a Google ID token (JWT). Returns null when
 * the token is malformed, from another issuer, or expired — never throws.
 */
export function decodeCredential(credential: string): SignedInUser | null {
    const parts = credential.split('.');
    if (parts.length !== 3) {
        return null;
    }
    const payloadText = decodeBase64Url(parts[1]);
    if (payloadText === null) {
        return null;
    }
    let payload: unknown;
    try {
        payload = JSON.parse(payloadText) as unknown;
    } catch {
        return null;
    }
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const claims = payload as Record<string, unknown>;
    const issuer = claims['iss'];
    if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
        return null;
    }
    const expiry = claims['exp'];
    if (typeof expiry !== 'number' || expiry * 1000 <= Date.now()) {
        return null;
    }
    const name = claims['name'];
    const email = claims['email'];
    const picture = claims['picture'];
    if (typeof name !== 'string' || typeof email !== 'string') {
        return null;
    }
    return { name, email, picture: typeof picture === 'string' ? picture : '' };
}

/** Restore the signed-in user from this tab's session, if it is still valid. */
export function loadStoredUser(): SignedInUser | null {
    let stored: string | null = null;
    try {
        stored = sessionStorage.getItem(CONFIG.AUTH_STORAGE_KEY);
    } catch {
        return null;
    }
    if (stored === null) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(stored) as unknown;
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const credential = (parsed as Record<string, unknown>)['credential'];
    if (typeof credential !== 'string') {
        return null;
    }
    return decodeCredential(credential);
}

/** Keep the signed-in identity for this tab only. */
export function storeCredential(credential: string): void {
    try {
        sessionStorage.setItem(CONFIG.AUTH_STORAGE_KEY, JSON.stringify({ credential }));
    } catch {
        // Private mode or full storage: the user stays signed in for this
        // page load only, which is still fine.
    }
}

/** Forget the signed-in identity. */
export function clearStoredCredential(): void {
    try {
        sessionStorage.removeItem(CONFIG.AUTH_STORAGE_KEY);
    } catch {
        // Nothing to forget.
    }
}

/** Wait for the GIS script to load (polls; true when it is ready). */
export function waitForGoogleSignIn(): Promise<boolean> {
    const started = Date.now();
    return new Promise((resolve) => {
        const check = (): void => {
            if (window.google?.accounts?.id !== undefined) {
                resolve(true);
                return;
            }
            if (Date.now() - started >= CONFIG.GIS_WAIT_TIMEOUT_MS) {
                resolve(false);
                return;
            }
            window.setTimeout(check, CONFIG.GIS_POLL_INTERVAL_MS);
        };
        check();
    });
}

/**
 * Render Google's own "Sign in with Google" button into the slot.
 * Returns true when the button rendered.
 */
export function renderGoogleButton(
    slot: HTMLElement,
    onCredential: (credential: string) => void,
): boolean {
    const googleId = window.google?.accounts?.id;
    if (!isSignInConfigured() || googleId === undefined) {
        return false;
    }
    try {
        googleId.initialize({
            client_id: CONFIG.GOOGLE_CLIENT_ID,
            callback: (response) => {
                onCredential(response.credential);
            },
            auto_select: false,
        });
        googleId.renderButton(slot, {
            theme: 'outline',
            size: 'medium',
            text: 'signin_with',
            shape: 'rectangular',
        });
        return true;
    } catch (error) {
        console.error('Failed to render the Google sign-in button.', error);
        return false;
    }
}

/** Show Google's One Tap prompt (fallback when no button rendered). */
export function promptGoogleSignIn(): boolean {
    const googleId = window.google?.accounts?.id;
    if (!isSignInConfigured() || googleId === undefined) {
        return false;
    }
    try {
        googleId.prompt();
        return true;
    } catch (error) {
        console.error('Failed to show the Google sign-in prompt.', error);
        return false;
    }
}

/** Stop GIS from silently signing the user back in after a sign-out. */
export function disableGoogleAutoSelect(): void {
    try {
        window.google?.accounts?.id.disableAutoSelect();
    } catch {
        // GIS is not loaded; nothing to disable.
    }
}
