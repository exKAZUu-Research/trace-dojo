import { def, sdef } from './define';
import type { NativeFn } from './objects';
import { coreMethodAliases, corePrivateMethods, RUBY_CORE_METHODS } from './rubyCoreMethods';
import { UnsupportedFeatureError } from './runtime';

for (const [owner, methods] of Object.entries({
  String: [
    'append_as_bytes',
    'byteindex',
    'byterindex',
    'bytesplice',
    'dedup',
    'encode!',
    'scrub!',
    'setbyte',
    'undump',
    'unicode_normalize!',
    'unicode_normalized?',
  ],
  Integer: ['singleton_method_added'],
  Float: ['singleton_method_added'],
  Set: ['compare_by_identity', 'compare_by_identity?', 'divide'],
  NilClass: ['rationalize', 'to_c'],
  Proc: ['binding', 'ruby2_keywords', 'source_location', '>>', '<<'],
  Hash: ['<', '<=', '>', '>='],
  Module: [
    'autoload',
    'autoload?',
    'const_missing',
    'const_source_location',
    'deprecate_constant',
    'protected_instance_methods',
    'public_constant',
    'refinements',
    'remove_class_variable',
    'set_temporary_name',
    'singleton_class?',
    'undefined_instance_methods',
  ],
  Class: ['attached_object', 'subclasses'],
}))
  for (const name of methods)
    def(owner, name, [0, -1], () => {
      throw new UnsupportedFeatureError(`${owner}#${name}`);
    });

const unavailableIdentities = new Map<string, object>();
const aliasNames = new Map<string, string>(
  coreMethodAliases.flatMap(([owner, names]) =>
    names.map((name) => [`${owner}#${name}`, `${owner}#${names[0]}`] as const)
  )
);

for (const [owner, methods] of Object.entries(RUBY_CORE_METHODS)) {
  for (const name of methods.instance)
    def(owner, name, [0, -1], unavailableMethod(`${owner}#${name}`), {
      ifMissing: true,
      visibility: corePrivateMethods[owner]?.includes(name) ? 'private' : 'public',
    });
  for (const name of methods.singleton)
    sdef(owner, name, [0, -1], unavailableMethod(`${owner}.${name}`), { ifMissing: true });
}

function unavailableMethod(feature: string): NativeFn {
  const key = aliasNames.get(feature) ?? feature;
  let nativeIdentity = unavailableIdentities.get(key);
  if (!nativeIdentity) {
    nativeIdentity = {};
    unavailableIdentities.set(key, nativeIdentity);
  }
  return Object.assign(
    (): never => {
      throw new UnsupportedFeatureError(feature);
    },
    { unavailable: true, nativeIdentity }
  );
}
