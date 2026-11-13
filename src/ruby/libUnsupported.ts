import { def } from './define';
import { UnsupportedFeatureError } from './runtime';

for (const [owner, methods] of Object.entries({
  Hash: ['compare_by_identity?', 'deconstruct_keys'],
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
}))
  for (const name of methods)
    def(owner, name, [0, -1], () => {
      throw new UnsupportedFeatureError(`${owner}#${name}`);
    });
