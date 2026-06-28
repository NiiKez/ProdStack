import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

// CORE demo-mode invariant (CLAUDE.md / docs/DEMO_MODE.md §4): the demo
// orchestrator and its build driver import NO Azure / GitHub / Kaniko code, so a
// demo session is *structurally* unable to reach a real build operation — not
// merely flag-gated. Today this is enforced only by a source-comment claim; this
// test pins it so a regression (someone wires `containerApps`/`runBuild`/octokit
// into the demo path) fails `npm test` instead of silently breaching the
// fail-closed boundary at runtime.
//
// Strategy: parse each demo module with the TypeScript compiler API and extract
// EVERY module specifier — static `import`/`export … from`, side-effect imports,
// dynamic `import(...)`, and `require(...)`. Using the real parser (vs a
// line-regex) closes three holes a prior version had: multi-line named imports
// (`import {\n  x,\n} from '…'`), dynamic `await import('…')`, and comment
// false-positives. Coverage is the WHOLE demo directory (recursively, minus
// tests), so a new `services/demo/*` helper — the transitive-import hole — is
// caught automatically rather than needing to be added to a hand-kept list.

// Modules whose mere import would breach the "demo never touches external
// systems" invariant. Kept broad on purpose (substring/word match, case-insensitive).
const FORBIDDEN = /azure|github|kaniko|octokit|containerApps|runBuild|builds\/queue/i;

type ImportRef = { file: string; line: number; specifier: string };

/** Recursively list every non-test `.ts` file under the demo directory. */
function demoSourceFiles(): string[] {
  const root = __dirname;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Extract every module specifier referenced by a demo module via the TS AST:
 * static `import … from '…'`, re-export `export … from '…'`, side-effect
 * `import '…'`, dynamic `import('…')`, and `require('…')`. Keeps the file +
 * 1-based line for an actionable failure message.
 */
function collectImports(file: string): ImportRef[] {
  const abs = path.join(__dirname, file);
  const text = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const refs: ImportRef[] = [];
  const add = (specifier: string, pos: number): void => {
    refs.push({ file, line: sf.getLineAndCharacterOfPosition(pos).line + 1, specifier });
  };

  const visit = (node: ts.Node): void => {
    // Static import / re-export with a string module specifier.
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node.moduleSpecifier.getStart(sf));
    }
    // Dynamic `import('…')` or `require('…')`.
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isDynamicImport || isRequire) && arg !== undefined && ts.isStringLiteral(arg)) {
        add(arg.text, arg.getStart(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

describe('demo isolation — structural import boundary (DEMO_MODE.md §4)', () => {
  const files = demoSourceFiles();

  it('discovers the demo source files (incl. the fixture) — guards against a vacuous scan', () => {
    // A path slip that found zero files must NOT let the forbidden check pass
    // vacuously; also pins that the two entry points + the fixture are covered.
    expect(files).toEqual(
      expect.arrayContaining([
        'demoOrchestrator.ts',
        'demoBuildDriver.ts',
        path.join('fixtures', 'seed-workspace.ts'),
      ]),
    );
  });

  const allImports = files.flatMap(collectImports);

  it('parses a non-trivial set of import specifiers (guards against a parser slip)', () => {
    expect(allImports.length).toBeGreaterThanOrEqual(5);
  });

  it('no demo module imports Azure / GitHub / Kaniko / containerApps / runBuild / queue', () => {
    for (const { file, line, specifier } of allImports) {
      expect(
        FORBIDDEN.test(specifier),
        `${file}:${line} — demo module references a forbidden specifier "${specifier}" ` +
          `(breaches the demo "no external systems" invariant; DEMO_MODE.md §4)`,
      ).toBe(false);
    }
  });
});
