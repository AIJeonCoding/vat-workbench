import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS DI와 MikroORM 데코레이터는 decorator metadata가 필요해 SWC로 변환한다.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
