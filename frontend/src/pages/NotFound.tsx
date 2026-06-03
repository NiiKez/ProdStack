import { Link } from 'react-router-dom';
import { Compass, Hexagon } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function NotFound() {
  usePageTitle('Not found — ProdStack');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-slate-950 px-6 text-slate-100">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-400 text-accent-ink shadow-sm">
          <Hexagon size={18} strokeWidth={2.5} className="fill-accent-ink/10" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-slate-100">ProdStack</span>
      </div>
      <EmptyState
        className="w-full max-w-md"
        icon={<Compass className="h-8 w-8" aria-hidden />}
        title="Not found"
        description="That page doesn't exist."
        cta={
          <Link to="/dashboard">
            <Button variant="secondary">Back to projects</Button>
          </Link>
        }
      />
    </div>
  );
}
