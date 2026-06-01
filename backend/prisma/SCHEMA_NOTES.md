# Schema Notes

## Encrypted-field convention

Sensitive values (GitHub OAuth tokens, per-project webhook secrets, env-var values) are encrypted **in the application** before they hit Postgres. Postgres TDE only protects the disk; row-level secrecy is our job.

Algorithm: **AES-256-GCM** with a **12-byte IV** and a 32-byte key. Each encrypted field is stored as four columns:

| Column suffix | Type   | Purpose                                                                 |
|---------------|--------|-------------------------------------------------------------------------|
| `Ciphertext`  | Bytes  | AES-GCM ciphertext                                                      |
| `Iv`          | Bytes  | Random 12-byte nonce, generated per encryption                          |
| `AuthTag`     | Bytes  | 16-byte GCM authentication tag — verified on decrypt (throws on fail)   |
| `KeyVersion`  | Int    | Which `DATA_ENC_KEY` was used; lets us rotate keys without re-migrating |

Naming pattern: for a logical field `foo`, the columns are `fooCiphertext`, `fooIv`, `fooAuthTag`, `fooKeyVersion`.

### Current encrypted fields

| Model     | Logical field    | Notes                                                 |
|-----------|------------------|-------------------------------------------------------|
| `User`    | `githubToken`    | OAuth access token from GitHub                        |
| `Project` | `webhookSecret`  | Per-project HMAC secret used to verify GitHub hooks   |
| `EnvVar`  | `value`          | User-supplied env-var value (key stays plaintext)     |

### Key management

- v1: `DATA_ENC_KEY` is a base64-encoded 32-byte value loaded from the environment.
- M2: the same key moves to Azure Key Vault; the app reads it via managed identity at startup.
- Rotation: bump `DATA_ENC_KEY` to the next version, write the new bytes under that version in Key Vault, then run a background re-encrypt job that reads rows where `keyVersion < current`, decrypts with the old key, and rewrites with the new one. Decrypt always picks the key matching the stored `keyVersion`.

### Decrypt safety

`crypto.decrypt` MUST throw if the GCM auth tag does not verify. Callers should treat a decrypt failure as a hard error — never fall back to plaintext, never log the ciphertext.

## One-active-deployment invariant

A partial unique index (`one_active_per_project` on `Deployment(projectId) WHERE active = true`) guarantees that at most one deployment per project can be flagged active. Flipping the active deployment must happen inside a single transaction: clear the previous one, then insert/update the new one.

## Cascade deletes

- `User → Project → Build → LogLine`
- `Project → Deployment`
- `Project → EnvVar`
- `Project → WebhookEvent`
- `Build → Deployment` (deployments reference the build that produced them)

Deleting a `User` cleans up everything they own. `Project.deletedAt` is the soft-delete marker used by application code; cascade deletes only fire on a real row delete (e.g. account deletion).

## Build queue claim columns (M3)

Migration `20260521091425_build_queue_claim` adds three columns to `Build` plus a composite index. They turn the existing `Build` table into a lease queue without introducing a separate jobs table:

| Column      | Type        | Purpose                                                                                    |
|-------------|-------------|--------------------------------------------------------------------------------------------|
| `claimedAt` | `DateTime?` | When a worker took the lease. `NULL` means available; non-null means leased.               |
| `claimedBy` | `String?`   | Worker ID that holds the lease (default `worker-<pid>`; set explicitly via `WORKER_ID`).   |
| `attempts`  | `Int`       | Incremented on every claim; lets us detect poison-pill builds that keep crashing a worker. |

The new index `(status, claimedAt, createdAt)` is the index the claim query walks: `WHERE status = 'QUEUED' AND claimedAt IS NULL ORDER BY createdAt ASC`.

Claim happens atomically via the standard Postgres pattern:

```sql
UPDATE "Build"
SET "claimedAt" = NOW(), "claimedBy" = $1, "attempts" = "attempts" + 1
WHERE id = (
  SELECT id FROM "Build"
  WHERE status = 'QUEUED' AND "claimedAt" IS NULL
  ORDER BY "createdAt" ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, attempts
```

`FOR UPDATE SKIP LOCKED` is what makes this safe for N concurrent workers: the inner select holds a row lock that the outer update consumes, so the row is invisible to other workers from the moment we pick it. We currently run one worker replica per the operational policy, but the queue pattern is correct without changes if we ever scale out.

Stale claims (worker crashed mid-build, ACA replaced a replica, etc.) are recovered on each worker's boot via `recoverOwnClaims()` in `backend/src/services/builds/queue.ts`: any row leased longer ago than `BUILD_TIMEOUT_MS * 2` has its claim cleared, and any row past `QUEUED` (i.e. `CLONING|BUILDING|PUSHING|DEPLOYING`) is transitioned to `FAILED` with `errorMessage='worker restarted mid-build'` so the UI never shows a ghost build stuck in BUILDING forever.
