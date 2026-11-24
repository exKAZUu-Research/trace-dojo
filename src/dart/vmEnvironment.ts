const VM_LIBRARIES = [
  'async',
  'cli',
  'collection',
  'convert',
  'core',
  'developer',
  'ffi',
  'io',
  'isolate',
  'math',
  'mirrors',
  'nativewrappers',
  'typed_data',
];

/**
 * The declarations `dart run` gives `bool.fromEnvironment` and conditional imports: `dart.library.<name>` is `'true'`
 * for each library the VM has, and other names are undeclared.
 */
export const VM_ENVIRONMENT: ReadonlyMap<string, string> = new Map(
  VM_LIBRARIES.map((name) => [`dart.library.${name}`, 'true'])
);
