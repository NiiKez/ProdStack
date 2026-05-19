import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  helper?: string;
  error?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    helper,
    error,
    leadingIcon,
    trailingIcon,
    id,
    className,
    disabled,
    'aria-describedby': ariaDescribedByProp,
    ...rest
  },
  ref
) {
  const autoId = useId();
  const inputId = id ?? `input-${autoId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  const describedBy =
    [ariaDescribedByProp, errorId, helperId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-slate-200">
          {label}
        </label>
      )}
      <div className="relative">
        {leadingIcon && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400 [&_svg]:h-4 [&_svg]:w-4"
          >
            {leadingIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'block w-full rounded-lg border bg-slate-900 text-slate-100 placeholder:text-slate-500',
            'border-slate-700',
            'h-9 px-3 text-sm',
            'transition-colors',
            'focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            leadingIcon && 'pl-9',
            trailingIcon && 'pr-9',
            error && 'border-rose-500/70 focus:border-rose-500 focus:ring-rose-500/40'
          )}
          {...rest}
        />
        {trailingIcon && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 [&_svg]:h-4 [&_svg]:w-4"
          >
            {trailingIcon}
          </span>
        )}
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-rose-400">
          {error}
        </p>
      ) : helper ? (
        <p id={helperId} className="text-xs text-slate-400">
          {helper}
        </p>
      ) : null}
    </div>
  );
});
