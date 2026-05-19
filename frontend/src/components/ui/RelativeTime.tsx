import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export interface RelativeTimeProps {
  value: string | Date;
  className?: string;
}

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

type Unit = Intl.RelativeTimeFormatUnit;

const DIVISIONS: ReadonlyArray<{ amount: number; unit: Unit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

function formatRelative(date: Date): string {
  let duration = (date.getTime() - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RTF.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return RTF.format(Math.round(duration), 'year');
}

// Shared 30s tick — module-level subscribers + lazy interval
const subscribers = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (intervalId == null && typeof window !== 'undefined') {
    intervalId = setInterval(() => {
      for (const sub of subscribers) sub();
    }, 30_000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

export function RelativeTime({ value, className }: RelativeTimeProps) {
  const date = value instanceof Date ? value : new Date(value);
  const [, force] = useState(0);

  useEffect(() => {
    return subscribe(() => force((n) => n + 1));
  }, []);

  const valid = !Number.isNaN(date.getTime());
  const iso = valid ? date.toISOString() : '';
  const text = valid ? formatRelative(date) : '';

  return (
    <time
      dateTime={iso}
      title={valid ? date.toLocaleString() : undefined}
      className={cn('text-slate-400', className)}
    >
      {text}
    </time>
  );
}
