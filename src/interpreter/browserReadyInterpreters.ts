/**
 * The interpreters that run with a browser alone. Listing a language here makes `oxlint.config.ts` forbid Node-only
 * APIs in `src/<language>/`, lets the worker load it, and adds it to `test/unit/browserInterpreters.test.ts`.
 *
 * This module must stay free of imports, because `oxlint.config.ts` loads it.
 */
export const browserReadyInterpreters = {
  c: () => import('./languages/c'),
  cpp: () => import('./languages/cpp'),
  csharp: () => import('./languages/csharp'),
  dart: () => import('./languages/dart'),
  go: () => import('./languages/go'),
  haskell: () => import('./languages/haskell'),
  java: () => import('./languages/java'),
  javascript: () => import('./languages/javascript'),
  kotlin: () => import('./languages/kotlin'),
  php: () => import('./languages/php'),
  python: () => import('./languages/python'),
  ruby: () => import('./languages/ruby'),
  rust: () => import('./languages/rust'),
  typescript: () => import('./languages/typescript'),
  zig: () => import('./languages/zig'),
};

export type BrowserReadyLanguage = keyof typeof browserReadyInterpreters;
