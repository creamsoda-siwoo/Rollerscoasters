import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 상대 경로로 빌드해서 어떤 하위 경로에 올려도 동작하게 한다.
  base: './',
  server: { host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
