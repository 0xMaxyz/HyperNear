/**
 * Epic 1.5.4 gate — "Remove @rabby-wallet/hyperliquid-sdk" (docs/roadmap/
 * 01-hyperliquid-sdk.md, Epic 1.5; docs/tasks/phase-1.yml 1.5.4).
 *
 * Acceptance criterion: "Dependency absent from package.json and the
 * lockfile; no imports remain anywhere." Static repo-wide scans below cover
 * both halves; `pnpm install` (lockfile regeneration) and a full `pnpm build`
 * are the remaining, non-unit-testable half of the task's testing plan.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.turbo',
  '.git',
]);

const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]@rabby-wallet\/hyperliquid-sdk(?:\/[^'"]*)?['"]/;
const DEPENDENCY_KEY_RE = /"@rabby-wallet\/hyperliquid-sdk"\s*:/;

function collectFiles(dir: string, matcher: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      collectFiles(path.join(dir, entry.name), matcher, out);
    } else if (matcher.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('[Epic 1.5.4] @rabby-wallet/hyperliquid-sdk removal', () => {
  it('no source file imports @rabby-wallet/hyperliquid-sdk', () => {
    const files = collectFiles(REPO_ROOT, SOURCE_FILE_RE);
    const offenders = files
      .filter((file) => IMPORT_RE.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('no package.json declares @rabby-wallet/hyperliquid-sdk as a dependency', () => {
    const files = collectFiles(REPO_ROOT, /^package\.json$/);
    const offenders = files
      .filter((file) => DEPENDENCY_KEY_RE.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('the lockfile carries no @rabby-wallet/hyperliquid-sdk entry', () => {
    const lockfile = readFileSync(path.join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(lockfile).not.toMatch(/@rabby-wallet\/hyperliquid-sdk/);
  });
});
