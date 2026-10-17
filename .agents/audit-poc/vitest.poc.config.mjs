import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['./.agents/audit-poc/*.test.js'],
    environment: 'node',
  },
});
