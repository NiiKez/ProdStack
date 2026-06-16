import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Hexagon, Rocket, ScrollText, Undo2, Github, Play } from 'lucide-react';
import { Button, useToast } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';

/**
 * Build the full-page navigation URL for the public sandbox demo. The backend
 * mounts `GET /api/auth/demo-login` (GET so it's exempt from the `/api/auth`
 * CSRF gate); it mints a sandbox session cookie and redirects to `/dashboard`.
 * `next` is threaded through so a deep link survives the round-trip.
 */
export function demoLoginUrl(next?: string | null): string {
  return '/api/auth/demo-login' + (next ? '?next=' + encodeURIComponent(next) : '');
}

/** Build the GitHub OAuth begin URL, threading an optional post-login `next`. */
export function githubBeginUrl(next?: string | null): string {
  return '/api/auth/github/begin' + (next ? '?next=' + encodeURIComponent(next) : '');
}

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
    window.location.assign(githubBeginUrl(next));
  };

  const handleLaunchDemo = () => {
    window.location.assign(demoLoginUrl(next));
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      {/* Soft accent glow behind the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-0 flex justify-center"
      >
        <div className="h-[480px] w-[820px] max-w-full -translate-y-1/3 rounded-full bg-accent-400/10 blur-[120px]" />
      </div>

      <div className="relative z-10">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-400 text-accent-ink shadow-sm">
              <Hexagon size={18} strokeWidth={2.5} className="fill-accent-ink/10" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-slate-100">
              ProdStack
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={handleSignIn}
            leadingIcon={<Github className="h-4 w-4" aria-hidden />}
          >
            Sign in
          </Button>
        </header>

        <section className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 pt-20 pb-24 text-center sm:pt-28">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3.5 py-1.5 text-xs font-medium text-slate-300 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-400" aria-hidden />
            GitHub to Azure Container Apps, automatically
          </span>
          <h1 className="mt-6 text-5xl font-semibold tracking-tight text-slate-50 sm:text-6xl">
            Push to deploy.
          </h1>
          <p className="mt-5 max-w-xl text-base text-slate-300 sm:text-lg">
            ProdStack connects a GitHub repo to Azure Container Apps. Push a commit, get a live URL.
          </p>
          <div className="mt-9">
            <div className="flex flex-col items-center justify-center gap-6 sm:flex-row sm:items-start">
              <div className="flex flex-col items-center gap-3">
                <Button
                  size="lg"
                  onClick={handleLaunchDemo}
                  leadingIcon={<Play className="h-4 w-4" aria-hidden />}
                >
                  Launch demo
                </Button>
                <p className="max-w-[15rem] text-xs text-slate-500">
                  No GitHub account needed — explore a sandboxed deploy.
                </p>
              </div>
              <div className="flex flex-col items-center gap-3">
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={handleSignIn}
                  leadingIcon={<Github className="h-4 w-4" aria-hidden />}
                >
                  Sign in with GitHub
                </Button>
                <p className="max-w-[15rem] text-xs text-slate-500">
                  Owner-only — public visitors use the demo.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-6 pb-28">
          <ul className="grid gap-5 sm:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, description }) => (
              <li
                key={title}
                className="group rounded-2xl border border-slate-800 bg-slate-900/60 p-6 transition-colors hover:border-slate-700"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-accent-400/10 text-accent-400 ring-1 ring-inset ring-accent-400/20 transition-colors group-hover:bg-accent-400/15">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <h2 className="mt-5 text-base font-semibold text-slate-100">{title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{description}</p>
              </li>
            ))}
          </ul>
        </section>

        <footer className="border-t border-slate-800/70">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-xs text-slate-500 sm:flex-row">
            <div className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded bg-accent-400 text-accent-ink">
                <Hexagon size={12} strokeWidth={2.5} className="fill-accent-ink/10" />
              </span>
              <span className="font-medium text-slate-400">ProdStack</span>
            </div>
            <a
              href="https://github.com/"
              className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              target="_blank"
              rel="noreferrer"
            >
              <Github className="h-3.5 w-3.5" aria-hidden />
              GitHub
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
