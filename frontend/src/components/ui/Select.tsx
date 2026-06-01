import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  options: SelectOption[];
  /** Optional leading static text shown inside the control (e.g. "Sort:"). */
  leadingLabel?: ReactNode;
}

/**
 * Styled native `<select>`. Native rather than a Radix Select because the
 * filter/sort controls don't need rich content and the platform widget is the
 * most accessible + keyboard-friendly option with zero extra deps.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, leadingLabel, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? `select-${autoId}`;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={selectId} className="text-xs font-medium text-slate-400">
          {label}
        </label>
      )}
      <div className="relative inline-flex items-center">
        {leadingLabel && (
          <span className="pointer-events-none absolute left-3 text-xs text-slate-500">
            {leadingLabel}
          </span>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'h-9 w-full appearance-none rounded-lg border border-slate-700 bg-slate-900 text-sm text-slate-100',
            'pr-9 transition-colors',
            'focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/40',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            leadingLabel ? 'pl-12' : 'pl-3',
          )}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 h-4 w-4 text-slate-400"
        />
      </div>
    </div>
  );
});
