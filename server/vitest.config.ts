import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './reports/junit.xml',
    },
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'cobertura', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
