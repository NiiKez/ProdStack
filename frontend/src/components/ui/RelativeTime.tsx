import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/relativeTime';

export interface RelativeTimeProps {
  value: string | Date;
  className?: string;
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
