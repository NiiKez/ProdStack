import { Clock } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';

export interface PlaceholderProps {
  title: string;
  subtitle?: string;
}

export default function Placeholder({ title, subtitle }: PlaceholderProps) {
  usePageTitle(`${title} — ProdStack`);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        className="w-full max-w-md"
        icon={<Clock className="h-8 w-8" aria-hidden />}
        title={title}
        description={subtitle ?? 'Coming soon.'}
      />
    </div>
  );
}
