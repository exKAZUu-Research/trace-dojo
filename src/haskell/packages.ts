/** The versions GHC 9.14.1 comes with of the packages whose modules this environment has. */
export const PACKAGE_VERSIONS: Record<string, string> = {
  array: '0.5.8.0',
  base: '4.22.0.0',
  bytestring: '0.12.2.0',
  containers: '0.8',
  mtl: '2.3.1',
  stm: '2.5.3.1',
  'template-haskell': '2.24.0.0',
  text: '2.1.3',
  transformers: '0.6.1.2',
};

/** The packages of the modules GHC defines library names in, by the module's prefix. */
const MODULE_PACKAGES: [string, string][] = [
  ['GHC.', 'ghc-internal'],
  ['Data.Map', 'containers'],
  ['Data.Set', 'containers'],
  ['Data.IntMap', 'containers'],
  ['Data.IntSet', 'containers'],
  ['Data.Sequence', 'containers'],
  ['Data.Tree', 'containers'],
  ['Data.Graph', 'containers'],
  ['Data.Containers', 'containers'],
  ['Language.Haskell.TH', 'template-haskell'],
  ['Control.Monad.Trans', 'transformers'],
  ['Control.Monad.STM', 'stm'],
  ['Control.Concurrent.STM', 'stm'],
  ['Data.Text', 'text'],
  ['Data.ByteString', 'bytestring'],
  ['Data.Array', 'array'],
];

/**
 * The package Template Haskell names a library module's package by: GHC's unit id, the package's name and version for
 * one GHC does not wire in, and `base` for the rest of the library.
 */
export function libraryPackage(module: string): string {
  const prefix = MODULE_PACKAGES.find(([candidate]) => module === candidate || module.startsWith(candidate));
  const name = prefix?.[1] ?? 'base';
  if (name === 'ghc-internal' || name === 'base') return name;
  return `${name}-${PACKAGE_VERSIONS[name]}`;
}
