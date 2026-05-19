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
