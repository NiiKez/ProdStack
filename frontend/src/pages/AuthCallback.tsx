import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Hexagon } from 'lucide-react';
import { ErrorState, Spinner } from '@/components/ui';
import { queryClient } from '@/lib/queryClient';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePageTitle } from '@/hooks/usePageTitle';
import { safeNext, describeOAuthError } from '@/lib/authRedirect';

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-400 text-accent-ink shadow-sm">
        <Hexagon size={18} strokeWidth={2.5} className="fill-accent-ink/10" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-slate-100">ProdStack</span>
    </div>
  );
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
      <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-slate-950 px-6 text-slate-100">
        <BrandMark />
        <ErrorState
          className="w-full max-w-md"
          title="Sign-in failed"
          description={describeOAuthError(oauthError ?? '')}
          onRetry={() => window.location.assign('/api/auth/github/begin')}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-slate-950 px-6 text-slate-200">
      <BrandMark />
      <div className="flex flex-col items-center gap-4">
        <Spinner size="lg" className="text-accent-400" />
        <p className="text-sm text-slate-400">
          {isLoading ? 'Finishing sign-in…' : 'Redirecting…'}
        </p>
      </div>
    </div>
  );
}
