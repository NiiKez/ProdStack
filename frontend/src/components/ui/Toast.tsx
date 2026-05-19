import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

export interface Toast extends Required<Omit<ToastInput, 'description'>> {
  id: string;
  description?: string;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (input: ToastInput) => void;
  remove: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  error: 6000,
};

const VARIANT_STYLES: Record<ToastVariant, string> = {
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100',
  info: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-100',
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-100',
};

const VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  success: <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden />,
  info: <Info className="h-5 w-5 text-indigo-400" aria-hidden />,
  error: <AlertTriangle className="h-5 w-5 text-rose-400" aria-hidden />,
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function generateId(): string {
  // crypto.randomUUID where available; fallback to time+random for older browsers
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timersRef.current.get(id);
    if (handle != null) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const variant: ToastVariant = input.variant ?? 'info';
      const duration = input.duration ?? DEFAULT_DURATION[variant];
      const id = generateId();
      const toast: Toast = {
        id,
        title: input.title,
        variant,
        duration,
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      setToasts((prev) => [...prev, toast]);
      if (duration > 0) {
        const handle = window.setTimeout(() => remove(id), duration);
        timersRef.current.set(id, handle);
      }
    },
    [remove]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) window.clearTimeout(handle);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toasts, push, remove }), [toasts, push, remove]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster />
    </ToastContext.Provider>
  );
};

export function useToast(): { toast: (input: ToastInput) => void } {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return { toast: ctx.push };
}

export function Toaster() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  const { toasts, remove } = ctx;

  const errorToasts = toasts.filter((t) => t.variant === 'error');
  const otherToasts = toasts.filter((t) => t.variant !== 'error');

  return (
    <div
      aria-hidden={toasts.length === 0 ? true : undefined}
      className="pointer-events-none fixed top-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
    >
      <div aria-live="assertive" role="alert" className="flex flex-col gap-2">
        {errorToasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {otherToasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </div>
  );
}

interface ToastCardProps {
  toast: Toast;
  onDismiss: () => void;
}

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const reduced = prefersReducedMotion();
  return (
    <div
      className={cn(
        'pointer-events-auto relative flex items-start gap-3 rounded-xl border p-3 pr-9 shadow-lg backdrop-blur',
        'bg-slate-900/95',
        VARIANT_STYLES[toast.variant],
        !reduced &&
          'animate-in slide-in-from-right-4 fade-in-0 duration-200 motion-reduce:animate-none'
      )}
    >
      <div className="mt-0.5 shrink-0">{VARIANT_ICON[toast.variant]}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-100">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-xs text-slate-300">{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className={cn(
          'absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md',
          'text-slate-400 hover:bg-slate-800/80 hover:text-slate-100',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400'
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
