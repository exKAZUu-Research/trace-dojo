/**
 * The interpreters that run with a browser alone. Listing a language here makes `oxlint.config.ts` forbid Node-only
 * APIs in `src/<language>/`, lets the worker load it, and adds it to `test/unit/browserInterpreters.test.ts`.
 *
 * This module must stay free of imports, because `oxlint.config.ts` loads it.
 */
export const browserReadyInterpreters = {
  c: () => import('./languages/c'),
  cpp: () => import('./languages/cpp'),
  go: () => import('./languages/go'),
  java: () => import('./languages/java'),
  python: () => import('./languages/python'),
  rust: () => import('./languages/rust'),
};

export type BrowserReadyLanguage = keyof typeof browserReadyInterpreters;
