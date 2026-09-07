import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Node test harnesses intentionally provide a CommonJS module object to
  // compiled fixtures; this Next application restriction does not apply there.
  {files:['tests/**/*.mjs'],rules:{'@next/next/no-assign-module-variable':'off'}},
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'dist/**',
    'test-results/**',
    'playwright-report/**',
    'next-env.d.ts',
    '**/.test-tmp/**',
  ]),
]);

export default eslintConfig;
