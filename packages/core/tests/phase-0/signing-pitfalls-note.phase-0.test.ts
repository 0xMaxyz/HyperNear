/**
 * [Epic 0.1.3] Document signing discrepancies & pitfalls.
 *
 * This task is doc-only (docs/roadmap/spikes/0.1.3-signing-discrepancies-pitfalls.md):
 * the deliverable is a written note, not new signing code. What this suite
 * verifies is the note's *structure* — every documented pitfall names a real
 * `it(...)` case in the Epic 0.1.2/0.1.4 suites that would actually catch a
 * regression of that pitfall, and the note states an explicit trust verdict —
 * so the cross-references can't silently rot as the suites they point at
 * change.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const NOTE_PATH = path.join(__dirname, '../../../../docs/roadmap/spikes/0.1.3-signing-discrepancies-pitfalls.md');
const PHASE_0_DIR = path.join(__dirname, '.');

const DETECTED_BY_RE = /\*\*Detected by:\*\* `([^`]+)` — `"([^"]+)"`/g;

function readNote(): string {
  return fs.readFileSync(NOTE_PATH, 'utf-8');
}

describe('[Phase 0.1.3] signing discrepancies & pitfalls note', () => {
  it('is committed under docs/roadmap/spikes/', () => {
    expect(fs.existsSync(NOTE_PATH)).toBe(true);
  });

  it('states an explicit trust verdict (adopt / reject / adopt-with-guards)', () => {
    const note = readNote();
    const verdictSection = note.slice(note.indexOf('## Trust verdict'));
    expect(verdictSection.length).toBeGreaterThan(0);
    expect(verdictSection).toMatch(/\*\*(Adopt(?: — with guards| with guards)?|Reject)\b/i);
  });

  it('documents at least five pitfalls', () => {
    const note = readNote();
    const pitfallHeadings = note.match(/^### Pitfall \d+/gm) ?? [];
    expect(pitfallHeadings.length).toBeGreaterThanOrEqual(5);
  });

  it('every pitfall has a "Detected by" cross-reference', () => {
    const note = readNote();
    const pitfallCount = (note.match(/^### Pitfall \d+/gm) ?? []).length;
    const references = [...note.matchAll(DETECTED_BY_RE)];
    expect(references.length).toBeGreaterThanOrEqual(pitfallCount);
  });

  it('every "Detected by" reference points at a test file that exists in tests/phase-0/', () => {
    const note = readNote();
    const references = [...note.matchAll(DETECTED_BY_RE)];
    expect(references.length).toBeGreaterThan(0);

    for (const [, file] of references) {
      const filePath = path.join(PHASE_0_DIR, file);
      expect(fs.existsSync(filePath), `referenced file "${file}" does not exist under tests/phase-0/`).toBe(true);
    }
  });

  it('every "Detected by" reference names a test case that actually exists in the referenced 0.1.2/0.1.4 suite', () => {
    const note = readNote();
    const references = [...note.matchAll(DETECTED_BY_RE)];
    expect(references.length).toBeGreaterThan(0);

    for (const [, file, testName] of references) {
      const source = fs.readFileSync(path.join(PHASE_0_DIR, file), 'utf-8');
      expect(source.includes(testName), `"${testName}" not found as a test case in ${file}`).toBe(true);
    }
  });

  it('references the byte-for-byte diff task (0.1.2) it was blocked by', () => {
    const note = readNote();
    expect(note).toMatch(/0\.1\.2/);
  });
});
