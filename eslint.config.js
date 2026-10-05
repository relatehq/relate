import stylistic from '@stylistic/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const declarations = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'export',
];
const controlFlow = ['if', 'for', 'while', 'do', 'switch', 'try'];
const variables = ['const', 'let', 'var'];

export default [
  {
    // Generated output is outside the source-formatting boundary.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-internal/**',
      '**/.source/**',
      '**/.source-internal/**',
      '**/next-env.d.ts',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: 'directive', next: '*' },
        { blankLine: 'any', prev: 'directive', next: 'directive' },
        { blankLine: 'always', prev: variables, next: '*' },
        { blankLine: 'any', prev: variables, next: variables },
        { blankLine: 'always', prev: '*', next: declarations },
        { blankLine: 'always', prev: declarations, next: '*' },
        // Keep consecutive one-line re-exports and declarations together.
        {
          blankLine: 'any',
          prev: 'singleline-export',
          next: 'singleline-export',
        },
        { blankLine: 'always', prev: '*', next: controlFlow },
        { blankLine: 'always', prev: controlFlow, next: '*' },
        { blankLine: 'always', prev: '*', next: 'return' },
        // TypeScript overload signatures must stay next to their implementation.
        { blankLine: 'any', prev: 'function-overload', next: '*' },
      ],
    },
  },
];
