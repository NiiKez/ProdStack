import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Rocket, ScrollText, Undo2, Github } from 'lucide-react';
import { Button, useToast } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';

interface Feature {
  icon: typeof Rocket;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: Rocket,
    title: 'Auto deploys on every push',
    description: 'Connect a repo and ProdStack rebuilds and ships on each commit to your branch.',
  },
  {
    icon: ScrollText,
    title: 'Live build logs',
    description: 'Watch builds stream into your dashboard. Errors are highlighted in place.',
  },
  {
    icon: Undo2,
    title: 'One-click rollback',
    description: 'Roll back to any previous successful deployment in a single click.',
  },
];

export default function Landing() {
  usePageTitle('ProdStack — Push to deploy');
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const next = searchParams.get('next');
  const sessionState = searchParams.get('session');
  const denied = searchParams.get('denied');

  useEffect(() => {
    if (sessionState === 'expired') {
      toast.toast({
        variant: 'info',
        title: 'Session expired',
        description: 'Your session expired — sign in again.',
      });
    }
    if (denied === 'not_owner') {
      toast.toast({
        variant: 'info',
        title: 'This is a single-user demo',
        description:
          'Sign-in is limited to the owner to keep hosting costs in check. Fork the repo to self-host your own instance.',
      });
    }
    // We intentionally only react to the search param changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionState, denied]);

  const handleSignIn = () => {
    const url =
      '/api/auth/github/begin' + (next ? '?next=' + encodeURIComponent(next) : '');
    window.location.assign(url);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pt-28 pb-20 text-center">
        <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">Push to deploy.</h1>
        <p className="mt-5 max-w-xl text-base text-slate-300 sm:text-lg">
          ProdStack connects a GitHub repo to Azure Container Apps. Push a commit, get a live URL.
        </p>
        <div className="mt-8">
          <Button
            size="lg"
            onClick={handleSignIn}
            leadingIcon={<Github className="h-4 w-4" aria-hidden />}
          >
            Sign in with GitHub
          </Button>
          <p className="mt-3 text-xs text-slate-400">
            Tokens never reach your browser — encrypted server-side.
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <ul className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <li
              key={title}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-sm"
            >
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-300">
                <Icon className="h-5 w-5" aria-hidden />
              </div>
              <h2 className="mt-4 text-sm font-semibold text-slate-100">{title}</h2>
              <p className="mt-1 text-sm text-slate-400">{description}</p>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-slate-900">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-2 px-6 py-6 text-xs text-slate-500">
          <a
            href="https://github.com/"
            className="inline-flex items-center gap-1.5 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 rounded"
            target="_blank"
            rel="noreferrer"
          >
            <Github className="h-3.5 w-3.5" aria-hidden />
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
