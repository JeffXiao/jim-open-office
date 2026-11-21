import './style.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import { App } from './app';
import spriteUrl from './assets/icons/sprite.svg?url';

const app = new App();
app.start(spriteUrl).catch((error: unknown) => {
    console.error('Failed to start the AI Office app.', error);
    const status = document.querySelector('#status');
    if (status !== null) {
        status.textContent = 'Failed to load — see the browser console.';
    }
});
