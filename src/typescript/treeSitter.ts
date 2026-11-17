import { Language, Parser } from '@willbooster/web-tree-sitter-for-typescript';

import { readWasm } from '../interpreter/treeSitter';

// The TypeScript grammar this interpreter is pinned to, `@willbooster/tree-sitter-typescript@26.0.1`, was built for an
// older language ABI than the web-tree-sitter the other grammars use loads, so it runs on its own web-tree-sitter 20.
await Parser.init({
  wasmBinary: readWasm('@willbooster/web-tree-sitter-for-typescript/web-tree-sitter.wasm').buffer as ArrayBuffer,
});

/** A parser of TypeScript, the language without JSX. */
export async function loadTypeScriptParser(): Promise<Parser> {
  const parser = new Parser();
  parser.setLanguage(await Language.load(readWasm('@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm')));
  return parser;
}
