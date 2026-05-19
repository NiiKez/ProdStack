import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  src?: string | undefined;
  alt: string;
  size?: AvatarSize | undefined;
  fallbackInitials?: string | undefined;
  className?: string | undefined;
}

const SIZES: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
};

function deriveInitials(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/).slice(0, 2);
  return parts
    .map((p) => p.charAt(0))
    .join('')
    .toUpperCase();
}

export function Avatar({ src, alt, size = 'md', fallbackInitials, className }: AvatarProps) {
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
  }, [src]);

  const initials = (fallbackInitials ?? deriveInitials(alt)).slice(0, 2);
  const showImage = !!src && !errored;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        'bg-slate-800 text-slate-300 font-medium select-none',
        SIZES[size],
        className
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt={alt}
          onError={() => setErrored(true)}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <span aria-label={alt}>{initials}</span>
      )}
    </span>
  );
}
