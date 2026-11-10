import { registerModule } from '../modules';
import type { PyValue } from '../values';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const PUNCTUATION = String.raw`!"#$%&'()*+,-./:;<=>?@[\]^_` + '`{|}~';
const WHITESPACE = ' \t\n\r\v\f';

registerModule(
  'string',
  () =>
    new Map<string, PyValue>([
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
);
