// oxlint-disable unicorn/prefer-code-point -- PHP pattern strings contain bytes; UTF-8 validation reads each byte separately.
import { utf8Length } from './bytes';
import { rt } from './runtime';

export class PatternError extends Error {}

export type PatternOption =
  | 'caseless'
  | 'caselessRestricted'
  | 'multiline'
  | 'dotAll'
  | 'extended'
  | 'extendedClass'
  | 'ungreedy'
  | 'dollarEndOnly'
  | 'anchored'
  | 'utf8'
  | 'noAutoCapture'
  | 'duplicateNames';

/** The pattern's modifiers; `utf8` (`u`) also turns on PCRE's UCP, so `\w`, `\d`, `\s`, `\b`, and POSIX classes match by Unicode properties. */
export type PatternOptions = Record<PatternOption, boolean>;

const MODIFIERS = new Map<string, PatternOption | undefined>([
  ['i', 'caseless'],
  ['r', 'caselessRestricted'],
  ['m', 'multiline'],
  ['s', 'dotAll'],
  ['x', 'extended'],
  ['U', 'ungreedy'],
  ['D', 'dollarEndOnly'],
  ['A', 'anchored'],
  ['u', 'utf8'],
  ['n', 'noAutoCapture'],
  ['J', 'duplicateNames'],
  ['S', undefined],
  ['X', undefined],
  ['\n', undefined],
  ['\r', undefined],
  [' ', undefined],
]);

const BRACKETS: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };

export function splitDelimiters(pattern: string): { body: string; modifiers: string } {
  const trimmed = pattern.replace(/^[ \t\n\r\v\f]+/, '');
  if (trimmed === '') throw new PatternError('Empty regular expression');
  const delimiter = trimmed[0];
  if (/[\dA-Za-z\\\0]/.test(delimiter)) {
    throw new PatternError('Delimiter must not be alphanumeric, backslash, or NUL byte');
  }
  const closing = BRACKETS[delimiter] ?? delimiter;
  let depth = 0;
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === '\\') index++;
    else if (closing !== delimiter && char === delimiter) depth++;
    else if (char === closing && depth-- === 0)
      return { body: trimmed.slice(1, index), modifiers: trimmed.slice(index + 1) };
  }
  throw new PatternError(
    closing === delimiter
      ? `No ending delimiter '${delimiter}' found`
      : `No ending matching delimiter '${closing}' found`
  );
}

export function applyModifier(options: PatternOptions, modifier: string): void {
  if (modifier === '\0') throw new PatternError('NUL byte is not a valid modifier');
  if (!MODIFIERS.has(modifier)) throw new PatternError(`Unknown modifier '${modifier}'`);
  const option = MODIFIERS.get(modifier);
  if (option) options[option] = true;
}

export function validatePatternUtf8(body: string): void {
  for (let index = 0; index < body.length;) {
    rt().spend();
    const length = utf8Length(body, index);
    if (body.charCodeAt(index) >= 128 && length === 1)
      throw new PatternError(`Compilation failed: UTF-8 error: ${patternUtf8Error(body, index)} at offset ${index}`);
    index += length;
  }
}

// code-gauge-allow functionCognitiveComplexity -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
function patternUtf8Error(body: string, index: number): string {
  const byte = body.charCodeAt(index);
  if (byte >= 0xfe) return 'illegal byte (0xfe or 0xff)';
  if (byte < 0xc0) return 'isolated byte with 0x80 bit set';
  let wanted = 2;
  if (byte >= 0xe0) wanted++;
  if (byte >= 0xf0) wanted++;
  if (byte >= 0xf8) wanted++;
  if (byte >= 0xfc) wanted++;
  const missing = index + wanted - body.length;
  if (missing > 0) return `${missing} byte${missing === 1 ? '' : 's'} missing at end`;
  let invalid = 1;
  while (invalid < wanted && (body.charCodeAt(index + invalid) & 0xc0) === 0x80) invalid++;
  if (invalid < wanted) return `byte ${invalid + 1} top bits not 0x80`;
  if (wanted > 4) return `${wanted}-byte character is not allowed (RFC 3629)`;
  if (byte >= 0xf5 || (byte === 0xf4 && body.charCodeAt(index + 1) >= 0x90))
    return 'code points greater than 0x10ffff are not defined';
  if (byte === 0xed && body.charCodeAt(index + 1) >= 0xa0) return 'code points 0xd800-0xdfff are not defined';
  return `overlong ${wanted}-byte sequence`;
}
