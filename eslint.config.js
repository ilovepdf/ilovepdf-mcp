import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

// Flat config. The `no-console` rule is load-bearing: on the stdio transport,
// stdout is reserved exclusively for MCP protocol frames, so only `error`/`warn`
// (which write to stderr) are allowed. All other logging must go through the
// audit-logger stderr facade (LOG-3).
export default [
  {
    ignores: ['dist', 'node_modules', 'coverage', '.claude'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // Allow intentionally-unused identifiers when prefixed with `_`
      // (e.g. signature-parity params like the fetch mock's `_init`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
