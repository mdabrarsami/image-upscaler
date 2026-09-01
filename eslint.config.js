import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'benchmarks/results/**',
      'examples/react/dist/**',
      // tsc once emitted alongside the sources here; keep stray artefacts out.
      'examples/react/src/**/*.js',
      'examples/react/**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // The image code is full of deliberate bit and index arithmetic; the
      // default naming rules fight it more than they help.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Test and tooling code may log and may reach for `any` when poking at
    // internals; holding it to library standards buys nothing.
    files: [
      'tests/**/*.ts',
      'benchmarks/**/*.{js,mjs,ts}',
      '**/scripts/**/*.mjs',
      '**/*.config.{ts,js,mjs}',
      'examples/**/*.{ts,tsx,js}',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    // Build scripts and configs are Node programs, not browser modules.
    files: ['**/*.mjs', '**/scripts/**/*.js', '*.config.js', 'benchmarks/**/*.mjs'],
    languageOptions: {
      // The benchmark driver is Node, but the bodies it passes to
      // `page.evaluate` are compiled and run in the browser, so it legitimately
      // references both sets of globals in one file.
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Demo pages and browser-side test harnesses.
    files: [
      'examples/vanilla/**/*.js',
      'examples/react/src/**/*.tsx',
      'tests/e2e/pages/**/*.js',
    ],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['tests/e2e/pages/worker-driver.js'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },
  {
    // Electron's main process is CommonJS running under Node.
    files: ['examples/electron/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
