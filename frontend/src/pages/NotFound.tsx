import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function NotFound() {
  usePageTitle('Not found — ProdStack');

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <EmptyState
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
