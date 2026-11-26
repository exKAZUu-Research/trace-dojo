import type { ReadWasm } from '../interpreter/wasm';

// Bundlers emit a file referenced by `new URL(<literal>, import.meta.url)` as a static asset, so each reference must
// be spelled out; a thunk keeps unused ones from being resolved.
const wasmUrls: Record<string, () => URL> = {
  '@willbooster/web-tree-sitter/web-tree-sitter.wasm': () =>
    new URL('../../node_modules/@willbooster/web-tree-sitter/web-tree-sitter.wasm', import.meta.url),
  '@willbooster/tree-sitter-bash/tree-sitter-bash.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-bash/tree-sitter-bash.wasm', import.meta.url),
  '@willbooster/tree-sitter-c/tree-sitter-c.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-c/tree-sitter-c.wasm', import.meta.url),
  '@willbooster/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-c-sharp/tree-sitter-c_sharp.wasm', import.meta.url),
  '@willbooster/tree-sitter-cpp/tree-sitter-cpp.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-cpp/tree-sitter-cpp.wasm', import.meta.url),
  '@willbooster/tree-sitter-dart/tree-sitter-dart.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-dart/tree-sitter-dart.wasm', import.meta.url),
  '@willbooster/tree-sitter-go/tree-sitter-go.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-go/tree-sitter-go.wasm', import.meta.url),
  '@willbooster/tree-sitter-haskell/tree-sitter-haskell.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-haskell/tree-sitter-haskell.wasm', import.meta.url),
  '@willbooster/tree-sitter-haskell/tree-sitter-haskell_ghc2021.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-haskell/tree-sitter-haskell_ghc2021.wasm', import.meta.url),
  '@willbooster/tree-sitter-java/tree-sitter-java.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-java/tree-sitter-java.wasm', import.meta.url),
  '@willbooster/tree-sitter-javascript/tree-sitter-javascript_script.wasm': () =>
    new URL(
      '../../node_modules/@willbooster/tree-sitter-javascript/tree-sitter-javascript_script.wasm',
      import.meta.url
    ),
  '@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-kotlin/tree-sitter-kotlin.wasm', import.meta.url),
  '@willbooster/tree-sitter-php/tree-sitter-php.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-php/tree-sitter-php.wasm', import.meta.url),
  '@willbooster/tree-sitter-python/tree-sitter-python.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-python/tree-sitter-python.wasm', import.meta.url),
  '@willbooster/tree-sitter-ruby/tree-sitter-ruby.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-ruby/tree-sitter-ruby.wasm', import.meta.url),
  '@willbooster/tree-sitter-rust/tree-sitter-rust.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-rust/tree-sitter-rust.wasm', import.meta.url),
  '@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm', import.meta.url),
  '@willbooster/tree-sitter-zig/tree-sitter-zig.wasm': () =>
    new URL('../../node_modules/@willbooster/tree-sitter-zig/tree-sitter-zig.wasm', import.meta.url),
};

export const readWasm: ReadWasm = async (specifier) => {
  const response = await fetch(wasmUrls[specifier]());
  if (!response.ok) throw new Error(`Failed to fetch ${specifier}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
