import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dedicated test config — intentionally does NOT pull in the Tailwind Vite
// plugin (tests don't render real CSS, and running it on every file is slow).
// Mirrors the `@` alias from vite.config.ts so imports resolve identically.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Unit/component tests live next to source under src/. Playwright E2E specs
    // live in e2e/ and are run by `playwright test`, not vitest — keep them out.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      // Report coverage for app source, not test scaffolding or generated types.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/types/**',
        'src/main.tsx',
        'src/**/*.d.ts',
      ],
      // No thresholds yet — the suite is new. Add a gate once coverage of the
      // logic modules (lib/, hooks/) is meaningful.
    },
  },
});
