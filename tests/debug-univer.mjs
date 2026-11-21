import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: '/home/hatch/workspace/ai-office', stdio: 'ignore' });
try {
    for (let i = 0; i < 30; i++) {
        try { const r = await fetch('http://localhost:4173/'); if (r.ok) break; } catch {}
        await delay(500);
    }
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERROR', m.text().slice(0, 200)); });
    page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
    await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__aiOffice !== undefined, null, { timeout: 30000 });
    await delay(5000);
    const info = await page.evaluate(() => {
        const h = window.__aiOffice;
        return {
            sheets: h.listSheets(),
            b2: h.inspectCell('B2'),
            b15: h.inspectCell('B15'),
            b16: h.inspectCell('B16'),
            b17: h.inspectCell('B17'),
            b18: h.inspectCell('B18'),
        };
    });
    console.log(JSON.stringify(info, null, 1));
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
