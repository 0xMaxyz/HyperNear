// Screenshot every tab of the recorded-data demo, light and dark, desktop and 390 px, plus the Account dialog.
// Run from web/ against a served build on http://localhost:5173 and the dry-run agent on :8787 (the VITE_AGENT_URL of that build).
// Output: screenshots/look-*.png; prints a PASS/FAIL line per check.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PAGE = process.env.PAGE ?? 'http://localhost:5173/';
const OUT = fileURLToPath(new URL('../screenshots/', import.meta.url));
const TABS = ['home', 'legs', 'hedge', 'strategies', 'fund', 'activity', ...(process.env.TABS ? process.env.TABS.split(',') : [])];
const browser = await chromium.launch();
let bad = 0;
const check = (name, ok, detail = '') => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

for (const [label, viewport, colorScheme] of [['wide', { width: 1280, height: 900 }, 'light'], ['wide-dark', { width: 1280, height: 900 }, 'dark'], ['phone', { width: 390, height: 800 }, 'light']]) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  const errors = [];
  // the deployed build points at the LAN address; from the box itself the same agent answers on localhost
  if (process.env.AGENT_FROM) await page.route(`**://${process.env.AGENT_FROM}/**`, (r) => r.continue({ url: r.request().url().replace(process.env.AGENT_FROM, process.env.AGENT_TO ?? 'localhost:8787') }));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/403|422|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(PAGE);
  await page.getByRole('button', { name: 'Explore recorded data' }).click();
  await page.waitForTimeout(3500);
  for (const tab of TABS) {
    await page.evaluate((t) => { location.hash = `#/${t}`; }, tab);
    await page.waitForTimeout(700);
    const selected = await page.getByRole('tab', { selected: true }).innerText().catch(() => '');
    check(`${label} ${tab}: tab selected`, selected.toLowerCase().startsWith(tab.slice(0, 4)), selected);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`${label} ${tab}: no horizontal scroll`, overflow <= 0, `${overflow}px`);
    await page.screenshot({ path: `${OUT}look-${label}-${tab}.png`, fullPage: true });
  }
  // strategies: pick a template, the agent checks it and the page shows the signed-hash flow
  await page.evaluate(() => { location.hash = '#/strategies'; });
  await page.waitForTimeout(800);
  await page.getByText('Tight grid').click();
  await page.waitForTimeout(1500);
  check(`${label}: template check shows a matching hash`, await page.getByText(/recomputed in your browser, it matches/).isVisible());
  check(`${label}: Start strategy is offered`, await page.getByRole('button', { name: 'Start strategy' }).isVisible());
  await page.screenshot({ path: `${OUT}look-${label}-strategies-template.png`, fullPage: true });
  await page.getByLabel('Highest price').fill('1');
  await page.waitForTimeout(1500);
  check(`${label}: a bad edit is refused with the reason`, await page.getByText(/params\.upper must be above params\.lower/).isVisible());
  await page.screenshot({ path: `${OUT}look-${label}-strategies-refused.png`, fullPage: true });
  // fund: token list, a price preview, simulated test funds, then the move-to-trading step appears
  await page.evaluate(() => { location.hash = '#/fund?leg=2'; });
  await page.waitForTimeout(3500);
  check(`${label}: fund lists the tokens to send`, await page.getByLabel('You send').isVisible());
  check(`${label}: fund shows a price preview`, await page.getByText('Arrives as').isVisible());
  await page.screenshot({ path: `${OUT}look-${label}-fund-preview.png`, fullPage: true });
  await page.getByRole('button', { name: 'Add simulated test funds' }).click();
  await page.waitForTimeout(2000);
  check(`${label}: funds on spot offer the move to the trading balance`, await page.getByRole('heading', { name: 'Move to the trading balance' }).isVisible());
  await page.screenshot({ path: `${OUT}look-${label}-fund-credited.png`, fullPage: true });
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.getByRole('button', { name: /^0x/ }).click();
  await page.waitForTimeout(400);
  check(`${label}: account dialog opens`, await page.getByRole('dialog').isVisible());
  await page.screenshot({ path: `${OUT}look-${label}-account.png` });
  await page.keyboard.press('Escape');
  check(`${label}: Esc closes the dialog`, !(await page.getByRole('dialog').isVisible()));
  check(`${label}: no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
