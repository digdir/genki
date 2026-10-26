import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // services/*/venv: a Python service's local virtualenv (services/marker-pdf-to-markdown);
  // benchmarks/*/.data: a benchmark's git-ignored downloads, results and virtualenv
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'services/*/venv/**',
      'benchmarks/*/.data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
