import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The Worker relies on standard Web APIs (Request/Response/Headers/crypto.subtle), all of which
    // exist in Node 20+. Running against Node instead of workerd keeps the suite dependency-light
    // while still exercising the real handler surface.
    globals: false,
  },
});
