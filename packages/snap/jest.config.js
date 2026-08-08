module.exports = {
  preset: '@metamask/snaps-jest',
  transform: {
    // Jest runs on CommonJS; the project tsconfig targets the webpack bundle
    // (module: esnext, moduleResolution: bundler), so override for tests.
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
        },
      },
    ],
  },
};
