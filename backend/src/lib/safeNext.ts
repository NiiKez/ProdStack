/**
 * Open-redirect guard for post-auth `?next=` redirect paths, shared by the
 * OAuth callback (`routes/auth.ts`) and demo-login (`routes/demoAuth.ts`).
 *
 * Both routers redirect the browser to a caller-supplied path after a successful
 * login. The value is always concatenated onto `env.WEB_ORIGIN` (auth) or used
 * as a same-origin path (demo), so the ONLY thing standing between a benign
 * `/dashboard` and an `https://evil.com` hijack is this validator. Keeping it in
 * one place stops the two copies from drifting — a one-sided hardening of a
 * duplicated guard is exactly how an open-redirect bypass sneaks back in.
 *
 * Allow only paths that look like `/safe/path?query#hash`. Rejects:
 *   - protocol-relative `//evil.com/...`
 *   - backslash-as-separator (`/\evil.com`) — browsers normalize to `//`
 *   - whitespace (which some browsers strip before URL parsing, and which would
 *     otherwise allow CR/LF response-splitting)
 *   - anything outside a conservative ASCII path/query/fragment alphabet
 *   - empty, non-`/`-leading, or absurdly long (>512) values
 */
const SAFE_NEXT_RE = /^\/[A-Za-z0-9_\-./~%?&=#:]*$/;

export function isSafeNextPath(raw: string): boolean {
  if (raw.length === 0 || raw.length > 512) return false;
  if (!raw.startsWith('/')) return false;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return false;
  if (/\s/.test(raw)) return false;
  return SAFE_NEXT_RE.test(raw);
}
