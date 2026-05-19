import { env } from '@/env';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// onUnauthorized is set by main.tsx after queryClient is created so we can avoid a
// circular import between this module and `@/lib/queryClient`.
let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  const headers = new Headers(init.headers);
  if (isMutation) headers.set('X-Requested-With', 'XMLHttpRequest');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const url = (env.apiBaseUrl || '') + path;
  const res = await fetch(url, { ...init, headers, credentials: 'include' });

  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : await res.text().catch(() => '');

  if (!res.ok) {
    const b = body as { error?: string; message?: string };
    throw new ApiError(
      res.status,
      b.error ?? 'ERROR',
      b.message ?? res.statusText,
      body,
    );
  }

  return body as T;
}
