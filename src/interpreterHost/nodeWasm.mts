import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { ReadWasm } from '../interpreter/wasm';

// This file is `.mts` because Node.js loads it as it is when a bundle leaves `#interpreterWasm` external, and would
// have to guess the module format of a `.ts` file.

// Resolving from the working directory keeps the lookup independent of how Next.js bundles this module.
const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));

// Copying into this realm's Uint8Array passes the runtime's `instanceof` check, which a Buffer from another realm
// (as under jsdom) fails.
export const readWasm: ReadWasm = (specifier) =>
  Promise.resolve(new Uint8Array(readFileSync(requireFromRoot.resolve(specifier))));
