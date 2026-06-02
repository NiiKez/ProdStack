export function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  // Reject protocol-relative (`//evil.com`) and backslash-smuggled redirects.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/dashboard';
  }
  if (/\s/.test(raw)) return '/dashboard';
  return raw;
}

export function describeOAuthError(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'You declined the GitHub sign-in prompt. Try again to continue.';
    case 'oauth_state_mismatch':
    case 'OAUTH_STATE_MISMATCH':
      return 'Sign-in expired before you could finish. Please try again.';
    default:
      return "We couldn't finish signing you in. You can try again — if this keeps happening, check that cookies are enabled.";
  }
}
