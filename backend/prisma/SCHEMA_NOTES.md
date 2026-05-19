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
