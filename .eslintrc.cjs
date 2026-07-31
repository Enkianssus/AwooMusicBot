module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // The renderer and Electron bridge consume several dynamic JSON protocols.
    // Keep their existing boundary types while the schemas are migrated.
    '@typescript-eslint/no-explicit-any': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
}
