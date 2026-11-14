// The codecs CPython writes in Python, utf_7's module and punycode, idna, undefined, uu_codec, quopri_codec, charmap,
// unicode_escape, and raw_unicode_escape, with stringprep, which idna uses, and quopri, which quopri_codec uses.
import { registerSourceModule } from '../sourceModules';
import { addEncodingsModule } from './codecsNative';
import {
  CHARMAP,
  IDNA,
  PUNYCODE,
  QUOPRI,
  QUOPRI_CODEC,
  RAW_UNICODE_ESCAPE,
  STRINGPREP,
  UNDEFINED,
  UNICODE_ESCAPE,
  UTF_7,
  UU_CODEC,
} from './pythonCodecSources';

for (const [module, source] of [
  ['utf_7', UTF_7],
  ['punycode', PUNYCODE],
  ['idna', IDNA],
  ['undefined', UNDEFINED],
  ['uu_codec', UU_CODEC],
  ['quopri_codec', QUOPRI_CODEC],
  ['charmap', CHARMAP],
  ['unicode_escape', UNICODE_ESCAPE],
  ['raw_unicode_escape', RAW_UNICODE_ESCAPE],
] as const) {
  addEncodingsModule(module);
  registerSourceModule(`encodings.${module}`, source);
}
registerSourceModule('stringprep', STRINGPREP);
registerSourceModule('quopri', QUOPRI);
