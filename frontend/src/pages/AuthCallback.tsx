import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorState, Spinner } from '@/components/ui';
import { queryClient } from '@/lib/queryClient';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePageTitle } from '@/hooks/usePageTitle';

function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  // Reject protocol-relative (`//evil.com`) and backslash-smuggled redirects.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/dashboard';
  }
  if (/\s/.test(raw)) return '/dashboard';
  return raw;
}

function describeOAuthError(code: string): string {
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

export default function AuthCallback() {
  usePageTitle('Signing in — ProdStack');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  }, []);

  const oauthError = searchParams.get('error');
  const { data: user, isLoading, isError } = useCurrentUser();

  useEffect(() => {
    if (user && !oauthError) {
      const target = safeNext(searchParams.get('next'));
      navigate(target, { replace: true });
    }
  }, [user, oauthError, navigate, searchParams]);

  if (oauthError || isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
        <ErrorState
          title="Sign-in failed"
          description={describeOAuthError(oauthError ?? '')}
          onRetry={() => window.location.assign('/api/auth/github/begin')}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-200">
      <Spinner size="lg" />
      <p className="text-sm text-slate-400">
        {isLoading ? 'Finishing sign-in…' : 'Redirecting…'}
      </p>
    </div>
  );
}
