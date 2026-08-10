import base, { createConfig } from '@metamask/eslint-config';
import browser from '@metamask/eslint-config-browser';
import jest from '@metamask/eslint-config-jest';
import nodejs from '@metamask/eslint-config-nodejs';
import typescript from '@metamask/eslint-config-typescript';

const config = createConfig([
  {
    ignores: [
      '**/build/',
      '**/.cache/',
      '**/dist/',
      '**/docs/',
      '**/public/',
      '.yarn/',
    ],
  },

  {
    extends: base,

    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: ['./tsconfig.json'],
      },
    },

    settings: {
      'import-x/extensions': ['.js', '.mjs'],
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: typescript,

    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-shadow': ['error', { allow: ['Text'] }],
    },
  },

  {
    files: ['**/*.js', '**/*.cjs', 'packages/snap/snap.config.ts'],
    extends: nodejs,

    languageOptions: {
      sourceType: 'script',
    },
  },

  {
    // Snap source runs in the SES sandbox where the `buffer` npm polyfill is
    // provided by the snaps-cli webpack config; importing it explicitly is
    // the sanctioned alternative to the (restricted) Buffer global.
    files: ['packages/snap/src/**'],
    rules: {
      'import-x/no-nodejs-modules': ['error', { allow: ['buffer'] }],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.js'],
    extends: [jest, nodejs],

    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  {
    files: ['packages/site/src/**'],
    extends: [browser],
  },

  {
    // The connector is a browser-targeted dapp library (EIP-6963 discovery
    // needs `window`).
    files: ['packages/connector/src/**'],
    extends: [browser],
  },
]);

export default config;
