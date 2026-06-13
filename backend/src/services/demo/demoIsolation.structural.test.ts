import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// CORE demo-mode invariant (CLAUDE.md / docs/DEMO_MODE.md §4): the demo
// orchestrator and its build driver import NO Azure / GitHub / Kaniko code, so a
// demo session is *structurally* unable to reach a real build operation — not
// merely flag-gated. Today this is enforced only by a source-comment claim; this
// test pins it so a regression (someone wires `containerApps`/`runBuild`/octokit
// into the demo path) fails `npm test` instead of silently breaching the
// fail-closed boundary at runtime.
//
// Strategy: read each module's source text, extract every static-import
// specifier, and assert none reference a forbidden module. Mirrors the
// fs-reading + per-finding-failure-message style of
// frontend/src/infra/workflows-pinning.test.ts.

// Modules whose mere import would breach the "demo never touches external
// systems" invariant. Kept broad on purpose (substring/word match, case-insensitive).
const FORBIDDEN = /azure|github|kaniko|octokit|containerApps|runBuild|builds\/queue/i;

const DEMO_FILES = ['demoOrchestrator.ts', 'demoBuildDriver.ts'];

type ImportRef = { file: string; line: number; specifier: string };

/**
 * Extract every `import ... from '<specifier>'` specifier from a module's source,
 * keeping its file + 1-based line for an actionable failure message. Covers the
 * `import x from 'y'`, `import { a } from 'y'`, and side-effect `import 'y'`
 * forms (single or double quoted).
 */
function collectImports(file: string): ImportRef[] {
  const abs = path.join(__dirname, file);
  const text = readFileSync(abs, 'utf8');
  const refs: ImportRef[] = [];
  text.split('\n').forEach((raw, i) => {
    // Match the trailing `from '...'` of an import line, or a bare
    // side-effect `import '...'`. Only static imports begin a line with `import`.
    const m =
      /^\s*import\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/.exec(raw) ??
      /^\s*import\s*['"]([^'"]+)['"]/.exec(raw);
    if (m) {
      refs.push({ file, line: i + 1, specifier: m[1]! });
    }
  });
  return refs;
}

describe('demo isolation — structural import boundary (DEMO_MODE.md §4)', () => {
  for (const file of DEMO_FILES) {
    describe(file, () => {
      const imports = collectImports(file);

      it('parses a non-trivial set of import lines (guards against a vacuous pass)', () => {
        // A path typo or regex slip that found zero imports must NOT let the
        // forbidden-specifier check pass vacuously.
        expect(imports.length).toBeGreaterThanOrEqual(3);
      });

      it('imports NO Azure / GitHub / Kaniko / containerApps / runBuild / queue module', () => {
        for (const { line, specifier } of imports) {
          expect(
            FORBIDDEN.test(specifier),
            `${file}:${line} — demo module imports a forbidden specifier "${specifier}" ` +
              `(breaches the demo "no external systems" invariant; DEMO_MODE.md §4)`,
          ).toBe(false);
        }
      });
    });
  }
});
