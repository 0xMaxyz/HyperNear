/**
 * [Epic 0.1.4] Harness shape for ongoing CI use.
 *
 * Covers the two things 0.1.4 decided:
 *   1. The fixture-format loader (../fixtures/golden/loader.ts) is generic
 *      over action type — adding a new endpoint's fixture + index.json entry
 *      is enough for Phase 1's Epics 1.2/1.3 to extend coverage, with no
 *      changes to the loader itself.
 *   2. CI actually wires the harness in: a dedicated job exists in
 *      .github/workflows/ci.yml that runs the phase-0 signing suite, and the
 *      workflow's triggers aren't path-filtered in a way that would let a
 *      dependency-only bump (a pnpm-lock.yaml change) skip it.
 *
 * See docs/roadmap/spikes/0.1.4-harness-shape-adr.md for the full decision
 * and the extension pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadFixtureIndex,
  loadGoldenFixture,
  assertFixtureSchema,
  listFixtureActionTypes,
} from '../fixtures/golden/loader';

describe('[Phase 0.1.4] fixture-format loader', () => {
  it('lists every action type declared in index.json', () => {
    const index = loadFixtureIndex();
    expect(listFixtureActionTypes().sort()).toEqual(Object.keys(index).sort());
  });

  it('loads and schema-validates every indexed fixture generically (extension pattern)', () => {
    // Doesn't hardcode 'order'/'usdSend' — this is the loader proving it
    // generalizes to whatever fixtures a future endpoint adds to index.json.
    const actionTypes = listFixtureActionTypes();
    expect(actionTypes.length).toBeGreaterThan(0);

    for (const actionType of actionTypes) {
      const fixture = loadGoldenFixture(actionType);
      expect(fixture.actionType).toBe(actionType);
      expect(() => assertFixtureSchema(fixture)).not.toThrow();
    }
  });

  it('every index entry points at a fixture file that actually exists', () => {
    const goldenDir = path.join(__dirname, '../fixtures/golden');
    const index = loadFixtureIndex();

    for (const [actionType, entry] of Object.entries(index)) {
      expect(fs.existsSync(path.join(goldenDir, entry.file)), `${actionType} -> ${entry.file}`).toBe(true);
    }
  });

  it('throws a clear, actionable error for an unindexed action type', () => {
    expect(() => loadGoldenFixture('nonexistentAction')).toThrow(/No golden fixture indexed/);
  });

  it('assertFixtureSchema rejects a fixture with a malformed field, pinpointing which one', () => {
    const fixture = loadGoldenFixture('order');

    expect(() => assertFixtureSchema({ ...fixture, signingScheme: 'not_a_real_scheme' as never })).toThrow(
      /unknown signingScheme/,
    );
    expect(() =>
      assertFixtureSchema({ ...fixture, output: { ...fixture.output, signature: { ...fixture.output.signature, v: 1 } } }),
    ).toThrow(/invalid signature\.v/);
    expect(() =>
      assertFixtureSchema({ ...fixture, wallet: { ...fixture.wallet, address: '0xnothex' } }),
    ).toThrow(/malformed wallet\.address/);
  });

  it('the loader module imports no network-capable client', () => {
    // Static guard, not just a runtime one: the harness's "no live network"
    // guarantee should hold even if a future edit adds a call site, not just
    // when the current tests happen not to exercise one.
    const source = fs.readFileSync(path.join(__dirname, '../fixtures/golden/loader.ts'), 'utf-8');
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|node:https?|['"]https?:/i);
  });
});

describe('[Phase 0.1.4] CI wiring', () => {
  const workflowPath = path.join(__dirname, '../../../../.github/workflows/ci.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf-8');

  it('has a dedicated job that runs the phase-0 signing-verification harness', () => {
    expect(workflow).toMatch(/signing-verification-harness:/);
    expect(workflow).toMatch(/signing-verification\.phase-0/);
  });

  it('triggers on push and pull_request with no path filter that would exclude a lockfile-only bump', () => {
    const onSection = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\njobs:'));

    expect(onSection).toMatch(/\bpush:/);
    expect(onSection).toMatch(/\bpull_request:/);
    // A `paths:`/`paths-ignore:` filter under either trigger could exclude a
    // pnpm-lock.yaml-only commit from running this job — the harness must
    // stay in the unfiltered path so every dependency bump reruns it.
    expect(onSection).not.toMatch(/paths(-ignore)?:/);
  });

  it('does not gate the harness job behind pnpm build (it only needs external deps installed)', () => {
    const jobStart = workflow.indexOf('signing-verification-harness:');
    const jobSection = workflow.slice(jobStart, jobStart + 800);
    expect(jobSection).not.toMatch(/pnpm build/);
    expect(jobSection).toMatch(/pnpm install/);
  });
});
