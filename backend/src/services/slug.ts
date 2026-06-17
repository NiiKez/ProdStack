import { createHash } from 'node:crypto';

const MAX_SLUG_LEN = 50;
const MAX_CONTAINER_APP_LEN = 32;
const HASH_SUFFIX_LEN = 6;

export function slugify(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, '');

  if (normalized.length === 0) {
    return 'project';
  }
  return normalized;
}

export function dedupedSlug(base: string, taken: ReadonlyArray<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) {
    return base;
  }
  let n = 2;
  while (set.has(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

function sanitizeContainerAppChar(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function trimEdges(s: string): string {
  let out = s.replace(/^[^a-z0-9]+/, '');
  out = out.replace(/[^a-z0-9]+$/, '');
  return out;
}

export function containerAppName(login: string, slug: string): string {
  const raw = `${login}-${slug}`.toLowerCase();
  let name = sanitizeContainerAppChar(raw);

  if (name.length > MAX_CONTAINER_APP_LEN) {
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, HASH_SUFFIX_LEN);
    const baseLen = MAX_CONTAINER_APP_LEN - HASH_SUFFIX_LEN - 1;
    const truncated = name.slice(0, baseLen).replace(/-+$/, '');
    name = `${truncated}-${hash}`;
  }

  name = trimEdges(name);

  if (name.length === 0) {
    name = `a${createHash('sha256').update(raw).digest('hex').slice(0, HASH_SUFFIX_LEN)}`;
  }

  if (!/^[a-z0-9]/.test(name)) {
    name = `a${name}`.slice(0, MAX_CONTAINER_APP_LEN);
    name = name.replace(/[^a-z0-9]+$/, '');
  }

  if (!/[a-z0-9]$/.test(name)) {
    name = name.replace(/[^a-z0-9]+$/, '');
    if (name.length === 0) {
      name = `a${createHash('sha256').update(raw).digest('hex').slice(0, HASH_SUFFIX_LEN)}`;
    }
  }

  return name;
}

/**
 * Azure Container App name for a preview (per-PR) environment.
 *
 * Distinct from the project's main `containerAppName` and always well within
 * ACA's 2–32 char, lowercase-alphanumeric-plus-hyphen, must-start-and-end-with-
 * alphanumeric rule: `pr<prNumber>-<8 hex of sha256(projectId)>`. Salting the
 * hash with the (globally unique) projectId — not the app name — guarantees two
 * different projects' PR #5 previews never collide, and the short, fixed shape
 * (`pr99999-xxxxxxxx` = 16 chars worst case) can never overflow 32. Deterministic
 * so re-deploying the same PR always targets the same app.
 */
export function previewContainerAppName(projectId: string, prNumber: number): string {
  // Re-assert at the sink (defense-in-depth, mirroring assertValidCommitSha in
  // runBuild): the webhook validates prNumber, but this name-builder is a naming
  // boundary and must not trust callers — a 0/negative/non-integer would produce
  // a semantically-wrong app name (`pr0-…`, `pr-5-…`).
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`refusing to build preview app name: invalid PR number ${prNumber}`);
  }
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
  return `pr${prNumber}-${hash}`;
}
