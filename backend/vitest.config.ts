import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    passWithNoTests: false,
    coverage: {
      // Only computed on `npm run test:coverage` (the `--coverage` flag); the
      // plain `test` run the CI PR gate uses is unaffected. v8 provider matches
      // the frontend config.
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      // Cover app source, not test scaffolding, generated Prisma types, or the
      // process entrypoints (index.ts/worker.ts wire things together and only
      // run under a live runtime).
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/index.ts',
        'src/worker.ts',
        'src/**/*.d.ts',
      ],
      // Thresholds are deliberately set BELOW the current measured coverage so
      // they act as a regression ratchet (a PR that deletes a security branch's
      // only test trips them) WITHOUT being a flaky gate. They apply only to
      // `test:coverage`, never the plain `test` PR gate — see docs/TESTING.md
      // ("Coverage") for raising them / wiring into CI.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
