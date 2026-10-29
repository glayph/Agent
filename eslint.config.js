import js from '@eslint/js';
import globals from 'globals';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'packages/*/dist/**', 'packages/*/node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
      prettier,
    },
    rules: {
      ...prettierConfig.rules,
      // The code base is hand-formatted (compact lines, mixed semicolon use); no single Prettier
      // configuration matches it, so formatting is not enforced here. Rules that only conflict
      // with Prettier stay disabled through eslint-config-prettier above.
      'prettier/prettier': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        // A leading underscore marks a deliberately unused name (e.g. omitting a key via rest destructuring).
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Tests build partial fakes and reach into private members; typing each one adds noise, not safety.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
