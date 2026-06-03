import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeVariant = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  mono?: boolean;
  children?: ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-800/80 text-slate-300 border border-slate-700',
  accent: 'bg-accent-400/10 text-accent-300 border border-accent-400/30',
  success: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-300 border border-amber-500/30',
  danger: 'bg-rose-500/10 text-rose-300 border border-rose-500/30',
};

export function Badge({
  variant = 'neutral',
  mono = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
        mono && 'font-mono tracking-tight',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
