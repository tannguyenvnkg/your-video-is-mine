import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import autoImports from './.wxt/eslint-auto-imports.mjs';

// ESLint flat config (ESLint 9+). Import auto-imports của WXT để không báo "no-undef"
// cho các global như `browser`, `defineBackground`, `defineContentScript`, `storage`, ...
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
      // Chủ dự án cho phép `any` khi bắt buộc (kèm chú thích) -> để cảnh báo, không chặn build.
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
