// The codecs CPython writes in Python, utf_7's module and punycode, idna, undefined, and uu_codec, with stringprep,
// which idna uses.
import { registerSourceModule } from '../sourceModules';
import { addEncodingsModule } from './codecsNative';
import { IDNA, PUNYCODE, STRINGPREP, UNDEFINED, UTF_7, UU_CODEC } from './pythonCodecSources';

for (const [module, source] of [
  ['utf_7', UTF_7],
  ['punycode', PUNYCODE],
  ['idna', IDNA],
  ['undefined', UNDEFINED],
  ['uu_codec', UU_CODEC],
] as const) {
  addEncodingsModule(module);
  registerSourceModule(`encodings.${module}`, source);
}
registerSourceModule('stringprep', STRINGPREP);
