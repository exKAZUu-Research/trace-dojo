// The codecs CPython writes in Python, utf_7's module and punycode, idna, undefined, uu_codec, and quopri_codec, with
// stringprep, which idna uses, and quopri, which quopri_codec uses.
import { registerSourceModule } from '../sourceModules';
import { addEncodingsModule } from './codecsNative';
import { IDNA, PUNYCODE, QUOPRI, QUOPRI_CODEC, STRINGPREP, UNDEFINED, UTF_7, UU_CODEC } from './pythonCodecSources';

for (const [module, source] of [
  ['utf_7', UTF_7],
  ['punycode', PUNYCODE],
  ['idna', IDNA],
  ['undefined', UNDEFINED],
  ['uu_codec', UU_CODEC],
  ['quopri_codec', QUOPRI_CODEC],
] as const) {
  addEncodingsModule(module);
  registerSourceModule(`encodings.${module}`, source);
}
registerSourceModule('stringprep', STRINGPREP);
registerSourceModule('quopri', QUOPRI);
