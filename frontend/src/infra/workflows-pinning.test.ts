import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Security review findings M4 + M5 (security-hardening-round2), pinned so a
// regression is caught by `npm test` instead of at deploy time.
//
//   M4 — every third-party `uses:` action MUST be pinned to a full 40-char commit
//        SHA, never a mutable tag (`@v4`, `@main`, ...). The deploy workflows run
//        with ACR_USERNAME / ACR_PASSWORD / DEPLOY_TOKEN in scope; a hijacked or
//        repointed action tag would execute attacker code with those secrets.
//
//   M5 — no workflow may build/push a mutable `:latest` image tag. The deploy
//        pins the immutable `:<git-sha>`; a floating `:latest` is dead weight and
//        an attack surface (a careless pull / repoint could ship unintended code).
//
// frontend/ is the vitest rootDir; the workflows sit at the monorepo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => ({
    name: f,
    text: readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'),
  }));

// Collect every `uses:` reference across all workflows, keeping its file + line
// for actionable failure messages.
type UsesRef = { file: string; line: number; ref: string };
const usesRefs: UsesRef[] = workflowFiles.flatMap(({ name, text }) =>
  text
    .split('\n')
    .map((raw, i) => ({ raw, lineNo: i + 1 }))
    .filter(({ raw }) => /^\s*-?\s*uses:\s*\S/.test(raw))
    .map(({ raw, lineNo }) => {
      // Strip the leading `uses:` and any trailing `# vX.Y.Z` comment.
      const after = raw.replace(/^\s*-?\s*uses:\s*/, '').trim();
      const ref = after.split('#')[0]!.trim();
      return { file: name, line: lineNo, ref };
    })
);

// A `uses:` that the M4 guard must check is an EXTERNAL action / reusable-workflow
// reference — always `owner/repo[/path]@<gitref>`, so it contains an `owner/repo`
// slash. Two kinds of `uses:` are deliberately NOT such references and are exempt:
//   - local actions (`./path`) — in-repo, no tag to hijack;
//   - a CodeQL inline `config:`'s `queries: - uses: security-extended` — a query
//     SUITE name (data fed to the analyzer), not an executable action, so it has
//     no git ref to pin and no `owner/repo` slash.
// Every executable third-party action has the slash, so scoping to it keeps the
// guard's guarantee intact (no real action can slip through unpinned) while not
// misfiring on the bare suite name.
const isExternalActionRef = (ref: string): boolean =>
  !ref.startsWith('./') && !ref.startsWith('.\\') && ref.includes('/');

describe('GitHub Actions workflow pinning (M4)', () => {
  it('has at least one workflow with a `uses:` reference (sanity)', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(usesRefs.length).toBeGreaterThan(0);
  });

  it('pins EVERY `uses:` action to a full 40-char commit SHA', () => {
    for (const { file, line, ref } of usesRefs) {
      // Only external `owner/repo@<ref>` actions are an M4 concern; local actions
      // and CodeQL config query-suite `uses:` are exempt (see isExternalActionRef).
      if (!isExternalActionRef(ref)) continue;
      expect(
        /@[0-9a-f]{40}$/.test(ref),
        `${file}:${line} — action is not pinned to a 40-char commit SHA: "${ref}"`
      ).toBe(true);
    }
  });

  it('uses NO mutable action ref (`@v\\d`, `@main`, `@master`)', () => {
    for (const { file, line, ref } of usesRefs) {
      if (!isExternalActionRef(ref)) continue;
      const tag = ref.split('@')[1] ?? '';
      expect(
        /^v\d/.test(tag) || tag === 'main' || tag === 'master',
        `${file}:${line} — action uses a mutable ref "${ref}" (pin to a commit SHA)`
      ).toBe(false);
    }
  });
});

describe('No mutable :latest image tag (M5)', () => {
  it('never builds or pushes a `:latest` image tag', () => {
    // Match a docker build/push tag of the form `<registry>/<repo>:latest`.
    // (Comments mentioning `:latest` in prose are fine — only tag refs on a
    // registry path are flagged.)
    const latestTagRe = /[\w.-]+\/[\w.-]+:latest\b/;
    for (const { name, text } of workflowFiles) {
      text.split('\n').forEach((raw, i) => {
        const code = raw.split('#')[0]!; // ignore trailing comments
        if (latestTagRe.test(code)) {
          expect.fail(
            `${name}:${i + 1} — builds/pushes a mutable :latest tag: "${raw.trim()}"`
          );
        }
      });
    }
  });
});
