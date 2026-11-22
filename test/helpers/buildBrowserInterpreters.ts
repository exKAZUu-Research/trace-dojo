import { builtinModules } from 'node:module';

// Bundles the interpreter worker and the pages that drive it for a browser, into the directory given as the argument.

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const result = await Bun.build({
  entrypoints: [
    'test/helpers/browserInterpreterPage.ts',
    'test/helpers/browserProblemPage.ts',
    'src/interpreter/worker/interpreterWorker.ts',
  ],
  outdir: process.argv[2],
  target: 'browser',
  splitting: true,
  plugins: [
    {
      // Bun replaces Node.js builtins with polyfills or empty modules for browsers, which would hide a dependency on
      // Node.js until the missing function is called.
      name: 'reject-node-builtins',
      setup(build) {
        build.onResolve({ filter: /^[\w:/]+$/ }, ({ path, importer }) => {
          // A dependency may name a builtin that its `browser` field replaces, as seedrandom does with `crypto`.
          if (builtins.has(path) && !importer.includes('/node_modules/'))
            throw new Error(`${importer} imports the Node.js builtin "${path}"`);
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
