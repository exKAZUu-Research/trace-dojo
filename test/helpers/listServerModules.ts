import { readFileSync } from 'node:fs';
import path from 'node:path';

// Prints, as a JSON array, the files under `src/` that the server evaluates: what the entry files of the app router
// import, stopping at client components, since the server only refers to those.

const entryPattern =
  'src/app/**/{page,layout,route,error,global-error,not-found,loading,template,default}.{ts,tsx}';
const entrypoints = [...new Bun.Glob(entryPattern).scanSync('.'), 'src/actions.ts'];
const loaded = new Set<string>();

const result = await Bun.build({
  entrypoints,
  target: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'record-server-modules',
      setup(build) {
        build.onResolve({ filter: /^[.@#]/ }, ({ path: specifier, importer }) => {
          let resolved: string;
          try {
            resolved = Bun.resolveSync(specifier, path.dirname(importer));
          } catch {
            return;
          }
          if (!/\.[cm]?tsx?$/.test(resolved) || resolved.includes('/node_modules/')) return;
          return isClientModule(resolved) ? { path: resolved, external: true } : undefined;
        });
        build.onLoad({ filter: /\.[cm]?tsx?$/ }, ({ path: file }) => {
          loaded.add(path.relative('.', file));
          return;
        });
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(JSON.stringify([...loaded].toSorted()));

function isClientModule(file: string): boolean {
  return /^\s*(['"])use client\1/.test(readFileSync(file, 'utf8'));
}
