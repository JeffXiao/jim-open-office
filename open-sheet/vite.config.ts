import { defineConfig } from 'vite';

/**
 * assetsInlineLimit: 0 — every imported asset is emitted as its own file.
 * The toolbar icons are an SVG sprite referenced from <use href="…#id">;
 * an inlined data: URL cannot be referenced that way (the browser blocks it
 * as an unsafe load), so the sprite must be a real file.
 */
export default defineConfig({
    // Served from GitHub Pages at https://jeffxiao.github.io/jim-open-office/open-sheet/,
    // so all asset URLs must be relative to that subpath.
    base: '/jim-open-office/open-sheet/',
    build: {
        assetsInlineLimit: 0,
    },
});
