import { defineConfig } from 'tsup';

// tsup's dts step injects the deprecated `baseUrl` option; silence the TS 6 deprecation error.
const dts = { compilerOptions: { ignoreDeprecations: '6.0' } } as never;

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['cjs'],
    dts,
    clean: true,
    target: 'node22',
  },
  {
    entry: { web: 'src/web.ts' },
    format: ['esm', 'cjs'],
    dts,
    target: 'es2022',
    platform: 'neutral',
  },
]);
