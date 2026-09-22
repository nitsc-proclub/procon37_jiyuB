import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-ssr/**',
      '**/.wrangler/**',
      '**/.local-resources/**',
      '**/.exhibition-build/**',
      '**/demo-records/**',
      '**/worker-configuration.d.ts',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      ...js.configs.recommended.rules,
      // Introduce correctness checks without changing unrelated legacy code.
      // Unused declarations are tracked as a separate follow-up (docs/code-quality.md).
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    rules: {
      // TypeScript checks names with the actual browser/Worker/Node type context.
      'no-undef': 'off',
    },
  },
  {
    files: ['services/debugBundleService.ts', 'vite.config.ts'],
    rules: {
      // These filename sanitizers intentionally match forbidden control characters.
      'no-control-regex': 'off',
    },
  },
];
