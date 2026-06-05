-- Make project-slug uniqueness soft-delete-aware.
--
-- Before: `Project_userId_slug_key` was a plain UNIQUE(userId, slug) that also
-- counted soft-deleted rows. Slug dedup on create only considers *live*
-- projects (deletedAt IS NULL), so recreating a project with the same name
-- after a soft-delete reused the slug and collided with the leftover tombstone
-- row -> P2002 -> 500, and the single retry re-picked the same colliding slug.
-- Replace the plain unique with a partial unique index that enforces
-- uniqueness only among live projects, exactly matching what the dedup assumes.
-- Mirrors the hand-maintained `one_active_per_project` partial index (migration
-- 20260516210200).
DROP INDEX "Project_userId_slug_key";

CREATE UNIQUE INDEX "project_user_slug_live"
  ON "Project" ("userId", "slug")
  WHERE "deletedAt" IS NULL;
