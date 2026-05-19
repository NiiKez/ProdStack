import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export interface ErrorStateProps {
  icon?: ReactNode;
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  icon,
  title = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Retry',
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'rounded-2xl border border-rose-500/30 bg-rose-500/5',
        'px-6 py-12 gap-3',
        className
      )}
    >
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-300 [&_svg]:h-6 [&_svg]:w-6"
      >
        {icon ?? <AlertTriangle />}
      </div>
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description && (
          <p className="text-sm text-slate-400 max-w-md mx-auto">{description}</p>
        )}
      </div>
      {onRetry && (
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
