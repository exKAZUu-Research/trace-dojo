// wbfy:start oxlint-base
import type { OxlintConfig } from 'oxlint';

// oxlint-disable unicorn/prefer-module -- Oxlint only auto-discovers .ts config files, and CommonJS avoids ESM package loading issues.
const oxlintBaseConfig = require('@willbooster/oxlint-config');

const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig.default ?? oxlintBaseConfig);
oxlintResolvedConfig.options = { ...oxlintResolvedConfig.options, typeAware: true, typeCheck: true };
// wbfy:end oxlint-base

const { browserReadyInterpreters } = require('./src/interpreter/browserReadyInterpreters.ts');
const NODE_ONLY_API_MESSAGE =
  'Interpreters run in browsers: use only APIs common to browsers and Node.js (see "Interpreters" in AGENTS.md).';
oxlintResolvedConfig.overrides = [
  ...(oxlintResolvedConfig.overrides ?? []),
  {
    files: ['src/interpreter/**', ...Object.keys(browserReadyInterpreters).map((language) => `src/${language}/**`)],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': ['error', { paths: [{ name: 'koffi', message: NODE_ONLY_API_MESSAGE }] }],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', 'require', 'module', '__dirname', '__filename', 'global', 'setImmediate'].map(
          (name) => ({ name, message: NODE_ONLY_API_MESSAGE })
        ),
      ],
    },
  },
];

// wbfy:start oxlint-export
module.exports = oxlintResolvedConfig;
// wbfy:end oxlint-export
