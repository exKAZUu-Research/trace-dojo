import { def, sdef } from './define';
import { RUBY_CORE_METHODS } from './rubyCoreMethods';
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
  Symbol: ['encoding', 'match', 'match?'],
  NilClass: ['rationalize', 'to_c', 'to_r'],
  Proc: ['binding', 'ruby2_keywords', 'source_location'],
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

for (const [owner, methods] of Object.entries(RUBY_CORE_METHODS)) {
  for (const name of methods.instance)
    def(
      owner,
      name,
      [0, -1],
      () => {
        throw new UnsupportedFeatureError(`${owner}#${name}`);
      },
      { ifMissing: true }
    );
  for (const name of methods.singleton)
    sdef(
      owner,
      name,
      [0, -1],
      () => {
        throw new UnsupportedFeatureError(`${owner}.${name}`);
      },
      { ifMissing: true }
    );
}
