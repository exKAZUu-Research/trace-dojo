/**
 * Reads a WebAssembly file of a dependency by its module specifier. Each platform implements this under
 * `src/interpreterHost/`, and the `#interpreterWasm` entry of `imports` in `package.json` selects the implementation.
 */
export type ReadWasm = (specifier: string) => Promise<Uint8Array<ArrayBuffer>>;
