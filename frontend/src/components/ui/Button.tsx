import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const BASE =
  'inline-flex items-center justify-center gap-2 font-medium rounded-lg ' +
  'transition-colors transition-shadow select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ' +
  'disabled:opacity-50 disabled:pointer-events-none';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-700 ' +
    'focus-visible:ring-indigo-400 shadow-sm',
  secondary:
    'bg-slate-900 text-slate-100 border border-slate-800 hover:bg-slate-800 hover:border-slate-700 ' +
    'focus-visible:ring-slate-500',
  ghost:
    'bg-transparent text-slate-200 hover:bg-slate-800/60 ' +
    'focus-visible:ring-slate-500',
  danger:
    'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 ' +
    'focus-visible:ring-rose-400 shadow-sm',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} />
      ) : leadingIcon ? (
        <span className="inline-flex shrink-0" aria-hidden>
          {leadingIcon}
        </span>
      ) : null}
      {children != null && <span className="inline-flex items-center">{children}</span>}
      {!loading && trailingIcon ? (
        <span className="inline-flex shrink-0" aria-hidden>
          {trailingIcon}
        </span>
      ) : null}
    </button>
  );
});
