import { Check, Copy } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface CommitRefProps {
  sha: string;
  className?: string;
}

export function CommitRef({ sha, className }: CommitRefProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const short = sha.slice(0, 7);

  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  }, [sha]);

  return (
    <button
      type="button"
      onClick={onClick}
      title={sha}
      aria-label={copied ? 'Copied' : `Copy commit ${sha}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs',
        'text-slate-300 hover:bg-slate-800/80 hover:text-slate-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950',
        'transition-colors',
        className
      )}
    >
      <span>{short}</span>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-3 w-3 text-slate-500" aria-hidden />
      )}
    </button>
  );
}
