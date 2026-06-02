// Global test setup, loaded by vitest before every test file (see vitest.config.ts).
// Registers jest-dom matchers (`toBeInTheDocument`, etc.) and tears down the
// React Testing Library DOM after each test so renders don't leak between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
