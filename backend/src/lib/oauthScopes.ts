/**
 * Single source of truth for the GitHub OAuth scopes ProdStack requests.
 *
 * `repo` grants read/write to the user's repositories (needed to clone private
 * repos + push build context); `admin:repo_hook` lets us register the
 * auto-deploy webhook. Two consumers need these in different shapes:
 *   - `routes/auth.ts` builds the authorize-URL `scope` param (space-joined).
 *   - `routes/me.ts` surfaces them to the Settings page as an array.
 * They used to be hand-synced copies; deriving both from one list here means a
 * scope change can't silently leave the Settings page advertising stale access.
 */
export const OAUTH_SCOPE_LIST = ['repo', 'admin:repo_hook'] as const;

/** Space-joined form for the GitHub authorize-URL `scope` query param. */
export const OAUTH_SCOPES = OAUTH_SCOPE_LIST.join(' ');
