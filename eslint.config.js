import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import autoImports from './.wxt/eslint-auto-imports.mjs';

// ESLint flat config (ESLint 9+). Import WXT's auto-imports so it doesn't report "no-undef"
// for globals like `browser`, `defineBackground`, `defineContentScript`, `storage`, ...
export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'stats.html',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  autoImports,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Project owner allows `any` when required (with a comment) -> warn only, don't block the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
  prettier,
);
