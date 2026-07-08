import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      complexity: ['error', 20],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'max-lines': [
        'error',
        { max: 800, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 120, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      'max-lines-per-function': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // Legacy page baselines. Keep these narrow so new files and extracted
    // components stay under the strict global TSX limits above.
    files: [
      'src/pages/LoginPage.tsx',
      'src/pages/score/AllScoresTab.tsx',
      'src/pages/SyncPage.tsx',
    ],
    rules: {
      complexity: ['error', 95],
      'max-lines': [
        'error',
        { max: 1300, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 1100, skipBlankLines: true, skipComments: true },
      ],
    },
  },
])
