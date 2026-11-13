import { builtin } from '../define';
import { runLibrarySource } from '../librarySource';
import { registerModule } from '../modules';
import { UnsupportedFeatureError } from '../unsupported';
import type { PyValue } from '../values';
import { formatterFieldNameSplit, formatterParser, templateScan } from './stringScanners';
import { STRING_SOURCE } from './stringSource';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const PUNCTUATION = String.raw`!"#$%&'()*+,-./:;<=>?@[\]^_` + '`{|}~';
const WHITESPACE = ' \t\n\r\v\f';

registerModule('string', () =>
  runLibrarySource(
    'string',
    STRING_SOURCE,
    new Map<string, PyValue>([
      ['_template_scan', builtin('_template_scan', 'expected', 2, 2, templateScan)],
      ['_formatter_parser', builtin('formatter_parser', 'one', 1, 1, formatterParser)],
      ['_formatter_field_name_split', builtin('formatter_field_name_split', 'one', 1, 1, formatterFieldNameSplit)],
      [
        '_unsupported',
        builtin('_unsupported', 'one', 1, 1, ([feature]) => {
          throw new UnsupportedFeatureError(feature as string);
        }),
      ],
      ['ascii_letters', LOWER + UPPER],
      ['ascii_lowercase', LOWER],
      ['ascii_uppercase', UPPER],
      ['digits', DIGITS],
      ['hexdigits', `${DIGITS}abcdefABCDEF`],
      ['octdigits', '01234567'],
      ['punctuation', PUNCTUATION],
      ['whitespace', WHITESPACE],
      ['printable', DIGITS + LOWER + UPPER + PUNCTUATION + WHITESPACE],
    ])
  )
);
