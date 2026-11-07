// No-key check of the judge path: open the page, click "Explore recorded data", expect the recorded hedged legs.
// Needs the dry-run agent on :8787 and vite on :5173 (see README). Run from web/: node e2e/explore-check.mjs
import { chromium } from '@playwright/test';

const PAGE = process.env.PAGE_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.goto(PAGE);
await page.waitForTimeout(5000); // first load: Vite optimises dependencies and reloads once
await page.reload();
await page.getByRole('button', { name: 'Explore recorded data' }).click();

let ok = true;
for (const text of ['Legs', 'BTC long', 'BTC short', 'Break-even', 'dry-run data']) {
  const seen = await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  console.log(`${seen ? 'PASS' : 'FAIL'} page shows "${text}"`);
  ok &&= seen;
}
await browser.close();
process.exit(ok ? 0 : 1);
