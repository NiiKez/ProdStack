import { cn } from '@/lib/cn';

export interface SkeletonProps {
  className?: string;
  lines?: number;
}

const BASE = 'rounded-md bg-slate-800/70 animate-pulse motion-reduce:animate-none';

export function Skeleton({ className, lines }: SkeletonProps) {
  if (typeof lines === 'number' && lines > 0) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={cn(
              BASE,
              'h-3',
              i === lines - 1 ? 'w-2/3' : 'w-full',
              className
            )}
          />
        ))}
      </div>
    );
  }
  return <div className={cn(BASE, 'h-4 w-full', className)} />;
}
