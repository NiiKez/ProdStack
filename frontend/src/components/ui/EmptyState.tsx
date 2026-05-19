import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  cta?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, cta, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'rounded-2xl border border-dashed border-slate-800 bg-slate-900/40',
        'px-6 py-12 gap-3',
        className
      )}
    >
      {icon && (
        <div
          aria-hidden
          className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800/80 text-slate-300 [&_svg]:h-6 [&_svg]:w-6"
        >
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description && (
          <p className="text-sm text-slate-400 max-w-md mx-auto">{description}</p>
        )}
      </div>
      {cta && <div className="mt-2">{cta}</div>}
    </div>
  );
}
