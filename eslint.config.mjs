import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import jsdocPlugin from 'eslint-plugin-jsdoc';
import prettierPlugin from 'eslint-plugin-prettier';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactRefreshPlugin from 'eslint-plugin-react-refresh';

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/.native/**',
            '**/dist/**',
            '**/build/**',
            '**/out/**',
            '**/coverage/**',
            '.idea/**',
            '.pnpm-store/**',
            '.husky/_/**',
        ],
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 2022,
            globals: { module: 'readonly', require: 'readonly' },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': 'error',
        },
    },
    {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
            prettier: prettierPlugin,
            import: importPlugin,
            jsdoc: jsdocPlugin,
            'react-hooks': reactHooksPlugin,
        },
        rules: {
            ...tseslint.configs.recommended.rules,
            ...prettierConfig.rules,
            ...reactHooksPlugin.configs.recommended.rules,
            'prettier/prettier': 'error',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            'import/order': [
                'error',
                {
                    groups: [
                        'builtin',
                        'external',
                        'internal',
                        'parent',
                        'sibling',
                        'index',
                        'type',
                    ],
                    'newlines-between': 'always',
                    alphabetize: { order: 'asc', caseInsensitive: true },
                },
            ],
            'jsdoc/require-jsdoc': [
                'error',
                {
                    require: {
                        FunctionDeclaration: true,
                        MethodDefinition: true,
                        ClassDeclaration: true,
                        ArrowFunctionExpression: false,
                        FunctionExpression: false,
                    },
                },
            ],
            'jsdoc/require-description': 'warn',
            'jsdoc/require-param': 'warn',
            'jsdoc/require-returns': 'warn',
        },
    },
    {
        files: ['**/*.tsx'],
        plugins: { react: reactPlugin },
        settings: { react: { version: 'detect' } },
        rules: {
            ...reactPlugin.configs.flat.recommended.rules,
            ...reactPlugin.configs.flat['jsx-runtime'].rules,
            'react/prop-types': 'off',
        },
    },
    {
        files: ['apps/**/*.tsx'],
        plugins: { 'react-refresh': reactRefreshPlugin },
        rules: {
            'react-refresh/only-export-components': 'error',
        },
    },
    {
        files: ['**/components/ui/**/*.{ts,tsx}'],
        rules: {
            'jsdoc/require-description': 'off',
            'jsdoc/require-returns': 'off',
        },
    },
];
