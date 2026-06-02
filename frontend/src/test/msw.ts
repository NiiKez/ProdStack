import { afterAll, afterEach, beforeAll } from 'vitest';
import { setupServer } from 'msw/node';
import type { RequestHandler } from 'msw';

/**
 * Stand up an MSW server for a test file that exercises the network layer
 * (hooks/components that call `api()`). Wires the vitest lifecycle so handlers
 * reset between tests and the server closes at the end. Call once at module
 * scope inside the test file:
 *
 *   const server = setupApiMock(http.get('/api/me', () => HttpResponse.json(user)));
 *   // ...later, override per-test: server.use(http.post(...))
 *
 * Pure-logic modules (lib/status, lib/repo, …) don't need this — test the
 * extracted functions directly. Prefer that; reach for MSW only when the
 * behavior under test genuinely spans the fetch boundary.
 */
export function setupApiMock(...handlers: RequestHandler[]) {
  const server = setupServer(...handlers);
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

export { http, HttpResponse } from 'msw';
