/**
 * ACR image garbage collection (M6 §2.14).
 *
 * The `prodstack` registry is Basic SKU, which has **no retention-policy
 * support** (retention requires Premium). So we do
 * the GC ourselves on a daily node-cron schedule: walk every repository, build
 * a conservative KEEP set, and delete the manifests of everything else.
 *
 * Safety is the whole point — a wrong delete makes a deployed app un-pullable on
 * its next replica restart. The keep-set is deliberately belt-and-suspenders:
 *   - moving tags (`latest`, `latest-success`) — never deleted
 *   - any tag newer than RETENTION_DAYS_IMAGES
 *   - the image tag of every project's currently-active Deployment (DB)
 *   - the LIVE image of each platform Container App (Azure, authoritative)
 *   - the newest 5 tags per repo regardless of age
 * Deleting a manifest removes all tags pointing at it (intended).
 *
 * Best-effort: a single delete failure is logged and skipped, never thrown.
 * In stub mode or without ACR creds it's a no-op returning zeros, so local dev
 * and tests never reach for a real registry.
 */
import { PreviewStatus } from '@prisma/client';

import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { getContainerAppImage, isStub } from '../azure/containerApps.js';
import {
  deleteManifestByTag,
  hasAcrCredentials,
  listRepositories,
  listTags,
  type AcrTag,
} from './acrRegistry.js';

const log = logger.child({ component: 'cleanup-images' });

/** Tags that are moving pointers — deleting them would break the "latest" alias. */
const MOVING_TAGS = new Set(['latest', 'latest-success']);

/** Always keep the newest N tags per repo, even if older than the window. */
const KEEP_NEWEST_PER_REPO = 5;

/** Platform Container Apps whose live image must never be GC'd. */
const PLATFORM_APP_NAMES = ['prodstack-api', 'prodstack-web', 'prodstack-builder'];

export interface CleanupImagesResult {
  scanned: number;
  deleted: number;
  kept: number;
  perRepo: Array<{ repo: string; deleted: number; kept: number }>;
}

/**
 * Parse a full image ref (`<host>/<repo>:<tag>`, optionally with extra path
 * segments in the repo) into `{ repo, tag }`. The repo is the path AFTER the
 * registry host and BEFORE the tag. Returns null if there's no tag or it's a
 * digest ref. The host is stripped (first path segment containing a `.` or `:`).
 */
export function parseImageRef(ref: string): { repo: string; tag: string } | null {
  if (!ref || ref.includes('@')) return null; // digest refs have no tag we track
  const lastColon = ref.lastIndexOf(':');
  const lastSlash = ref.lastIndexOf('/');
  if (lastColon === -1 || lastColon < lastSlash) return null; // no tag
  const tag = ref.slice(lastColon + 1);
  const pathWithHost = ref.slice(0, lastColon);
  // Strip the registry host: the first segment if it looks like a host
  // (`foo.azurecr.io` or `host:port`). If the first segment has no dot/colon
  // it's already a bare repo (e.g. a local image), so keep it whole.
  const firstSlash = pathWithHost.indexOf('/');
  if (firstSlash === -1) return { repo: pathWithHost, tag };
  const firstSegment = pathWithHost.slice(0, firstSlash);
  const isHost = firstSegment.includes('.') || firstSegment.includes(':');
  const repo = isHost ? pathWithHost.slice(firstSlash + 1) : pathWithHost;
  if (!repo || !tag) return null;
  return { repo, tag };
}

/**
 * Extract the manifest digest from a digest-pinned ref (`<repo>@sha256:<hex>` or
 * `<repo>:<tag>@sha256:<hex>`). Returns null for a tag-only ref. ACA can echo a
 * platform/deployment image back as a digest pin, which `parseImageRef` returns
 * null for (it bails on `@`) — so we protect those by digest instead (see
 * `collectProtectedTags`), or the strongest protection source silently vanishes.
 */
export function parseImageDigest(ref: string): string | null {
  if (!ref) return null;
  const at = ref.indexOf('@');
  if (at === -1) return null;
  const digest = ref.slice(at + 1).trim();
  return digest.startsWith('sha256:') && digest.length > 'sha256:'.length ? digest : null;
}

/**
 * Collect the images that must be kept, from Prisma (active deployments) and
 * Azure (live platform images). Returns BOTH:
 *   - `tags`: protected tag names keyed by repo (the original tag-based pin).
 *   - `digests`: protected manifest digests, registry-wide. Seeds the keep set
 *     so a digest-pinned live ref (`@sha256:`) — which has no tag to protect —
 *     is still shielded, and a manifest a live ref points at can't be deleted
 *     via a sibling tag in another repo.
 * A live/active ref that parses to NEITHER a tag nor a digest is logged at warn
 * (the protection silently going missing is exactly the dangerous case).
 */
async function collectProtectedTags(): Promise<{
  tags: Map<string, Set<string>>;
  digests: Set<string>;
}> {
  const protectedByRepo = new Map<string, Set<string>>();
  const protectedDigests = new Set<string>();
  const add = (repo: string, tag: string): void => {
    const set = protectedByRepo.get(repo) ?? new Set<string>();
    set.add(tag);
    protectedByRepo.set(repo, set);
  };
  // Protect by tag AND/OR digest, whichever the ref carries; warn if neither.
  const protect = (ref: string, source: string): void => {
    const parsed = parseImageRef(ref);
    if (parsed) add(parsed.repo, parsed.tag);
    const digest = parseImageDigest(ref);
    if (digest) protectedDigests.add(digest);
    if (!parsed && !digest) {
      log.warn({ ref, source }, 'protected image ref parsed to neither tag nor digest — NOT protected');
    }
  };

  // Active project deployments → their build's image tag. Demo deployments are
  // excluded: their builds carry fake image tags that never exist in ACR, so
  // protecting them is pointless and just spams a "ref parsed to neither tag nor
  // digest" warning each run (docs/DEMO_MODE.md §6.7).
  const activeDeployments = await prisma.deployment.findMany({
    where: { active: true, build: { isDemo: false } },
    select: { build: { select: { imageTag: true } } },
  });
  for (const d of activeDeployments) {
    const imageTag = d.build?.imageTag;
    if (!imageTag) continue;
    protect(imageTag, 'active-deployment');
  }

  // Open preview environments → their latest build's image tag. A preview's TTL
  // (default 72h) is normally well under RETENTION_DAYS_IMAGES (30d) so the
  // recency rule already covers it, but protect explicitly so a long-lived
  // preview (raised TTL) can't lose its image and break on a replica restart.
  // Previews are never demo, so these are real ACR tags worth protecting.
  const openPreviews = await prisma.previewEnvironment.findMany({
    where: {
      closedAt: null,
      status: { in: [PreviewStatus.PENDING, PreviewStatus.ACTIVE] },
      lastBuildId: { not: null },
    },
    select: { lastBuildId: true },
  });
  const previewBuildIds = openPreviews
    .map((p) => p.lastBuildId)
    .filter((v): v is string => v !== null);
  if (previewBuildIds.length > 0) {
    const previewBuilds = await prisma.build.findMany({
      where: { id: { in: previewBuildIds }, isDemo: false },
      select: { imageTag: true },
    });
    for (const b of previewBuilds) {
      if (b.imageTag) protect(b.imageTag, 'preview');
    }
  }

  // Live platform Container App images (authoritative).
  for (const appName of PLATFORM_APP_NAMES) {
    try {
      const image = await getContainerAppImage(appName);
      if (!image) continue;
      protect(image, `platform:${appName}`);
    } catch (err) {
      // A missing app (e.g. not yet provisioned) must not abort the whole GC —
      // worst case we lose one protection source and the recency/newest-5 rules
      // still cover it.
      log.warn({ err, app: appName }, 'could not read live platform image — skipping');
    }
  }

  return { tags: protectedByRepo, digests: protectedDigests };
}

export async function cleanupImages(
  opts: { dryRun?: boolean } = {},
): Promise<CleanupImagesResult> {
  const dryRun = opts.dryRun ?? false;
  const empty: CleanupImagesResult = { scanned: 0, deleted: 0, kept: 0, perRepo: [] };

  if (isStub()) {
    log.warn('AZURE_STUB=true — skipping ACR image cleanup (no real registry)');
    return empty;
  }
  if (!hasAcrCredentials()) {
    log.warn('ACR_USERNAME/ACR_PASSWORD unset — skipping ACR image cleanup');
    return empty;
  }

  const retentionDays = env.RETENTION_DAYS_IMAGES;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const { tags: protectedByRepo, digests: protectedDigests } = await collectProtectedTags();

  let repos: string[];
  try {
    repos = await listRepositories();
  } catch (err) {
    log.error({ err }, 'failed to list repositories — aborting image cleanup');
    return empty;
  }

  const result: CleanupImagesResult = { scanned: 0, deleted: 0, kept: 0, perRepo: [] };

  // ── Phase 1: list every repo's tags + decide keep-by-tag, accumulating the
  // digest of EVERY kept tag into a registry-wide set. Deleting a manifest
  // removes all tags pointing at it, so a manifest may only be deleted if NO
  // tag we keep — in this repo OR any other — points at it. Collecting kept
  // digests globally first closes both the cross-repo shared-digest hole and
  // the latent intra-repo one (an old deletable tag sharing a manifest with a
  // kept newest-5/moving tag). Seeded with the protected-ref digests.
  const keptDigests = new Set<string>(protectedDigests);
  const perRepo: Array<{ repo: string; sorted: AcrTag[]; keepByTag: Map<string, boolean> }> = [];

  for (const repo of repos) {
    let tags: AcrTag[];
    try {
      tags = await listTags(repo);
    } catch (err) {
      log.error({ err, repo }, 'failed to list tags — skipping repo');
      continue;
    }

    // listTags returns newest-first (orderby=timedesc). Sort defensively by
    // lastUpdateTime so the newest-5 rule is robust even if ordering changes.
    // Undateable timestamps sort to the END (oldest) so they never consume a
    // newest-5 slot — they're kept anyway by the fail-safe in `keep`.
    const ts = (t: AcrTag): number => {
      const v = Date.parse(t.lastUpdateTime || '');
      return Number.isNaN(v) ? -Infinity : v;
    };
    const sorted = [...tags].sort((a, b) => ts(b) - ts(a));
    const newestN = new Set(sorted.slice(0, KEEP_NEWEST_PER_REPO).map((t) => t.name));
    const protectedTags = protectedByRepo.get(repo) ?? new Set<string>();

    const keep = (tag: AcrTag): boolean => {
      if (MOVING_TAGS.has(tag.name)) return true;
      if (protectedTags.has(tag.name)) return true;
      if (newestN.has(tag.name)) return true;
      const updated = Date.parse(tag.lastUpdateTime || '');
      // Unparseable timestamp → keep (fail safe; never delete what we can't date).
      if (Number.isNaN(updated) || updated >= cutoff) return true;
      return false;
    };

    const keepByTag = new Map<string, boolean>();
    for (const tag of sorted) {
      const k = keep(tag);
      keepByTag.set(tag.name, k);
      if (k && tag.digest) keptDigests.add(tag.digest);
    }
    perRepo.push({ repo, sorted, keepByTag });
  }

  // ── Phase 2: delete. A tag is removed only if it's not kept by its own repo's
  // rules AND no kept tag anywhere shares its manifest digest.
  for (const { repo, sorted, keepByTag } of perRepo) {
    let repoDeleted = 0;
    let repoKept = 0;
    // De-dupe: multiple tags can share a manifest; deleting it removes them all,
    // so issue at most one DELETE per digest this run.
    const deletedDigests = new Set<string>();

    for (const tag of sorted) {
      result.scanned += 1;
      if (keepByTag.get(tag.name)) {
        repoKept += 1;
        result.kept += 1;
        continue;
      }
      // Manifest shared with a tag we keep (this repo or another) → never delete.
      if (tag.digest && keptDigests.has(tag.digest)) {
        repoKept += 1;
        result.kept += 1;
        log.debug({ repo, tag: tag.name }, 'kept: manifest shared with a protected tag');
        continue;
      }
      if (dryRun) {
        repoDeleted += 1;
        result.deleted += 1;
        log.info({ repo, tag: tag.name, dryRun: true }, 'would delete image manifest');
        continue;
      }
      if (tag.digest && deletedDigests.has(tag.digest)) {
        // Manifest already deleted via a sibling tag this run.
        repoDeleted += 1;
        result.deleted += 1;
        continue;
      }
      try {
        await deleteManifestByTag(repo, tag.name, tag.digest);
        if (tag.digest) deletedDigests.add(tag.digest);
        repoDeleted += 1;
        result.deleted += 1;
        log.info({ repo, tag: tag.name }, 'deleted image manifest');
      } catch (err) {
        // Best-effort GC: log and continue, never abort the whole run on one
        // failed delete.
        log.error({ err, repo, tag: tag.name }, 'failed to delete image manifest');
      }
    }

    result.perRepo.push({ repo, deleted: repoDeleted, kept: repoKept });
    log.info({ repo, deleted: repoDeleted, kept: repoKept, dryRun }, 'repo image cleanup done');
  }

  log.info(
    { scanned: result.scanned, deleted: result.deleted, kept: result.kept, retentionDays, dryRun },
    'image cleanup complete',
  );
  return result;
}
