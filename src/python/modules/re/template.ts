// The replacement templates of `re.sub` and `Match.expand`, as CPython's `re._parser.parse_template` parses them.
import { strRepr } from '../../strings';
import { MAXGROUPS } from './constants';
import {
  ASCII_LETTER,
  codePointLength,
  DIGITS,
  ESCAPES,
  isEscape,
  OCTDIGITS,
  PatternSyntaxError,
  Tokenizer,
} from './tokenizer';

/** A parsed replacement template: literal text and group numbers, in order. */
export type Template = (string | number)[];

/** Parses a replacement template, as `re._parser.parse_template` does. */
// code-gauge-allow functionNcss 34 -- Transcribes re._parser.parse_template.
export function parseTemplate(
  template: string,
  groups: number,
  groupindex: Map<string, number>,
  isText = true
): Template {
  const source = new Tokenizer(template, isText);
  const result: Template = [];
  let literalText = '';
  const addGroup = (index: number, offset: number): void => {
    if (index > groups) throw source.error(`invalid group reference ${index}`, offset);
    result.push(literalText, index);
    literalText = '';
  };
  for (let current = source.get(); current !== undefined; current = source.get()) {
    if (!isEscape(current)) {
      literalText += current;
      continue;
    }
    const char = current.slice(1);
    if (char === 'g') templateNamedGroup(source, groupindex, addGroup);
    else if (char === '0') literalText += String.fromCodePoint(templateOctal(source, current) & 0xff);
    else if (DIGITS.has(char)) {
      const octal = templateNumber(source, current, addGroup);
      if (octal !== undefined) literalText += octal;
    } else if (ESCAPES[current] !== undefined) literalText += String.fromCodePoint(ESCAPES[current]);
    else if (ASCII_LETTER.test(char)) throw source.error(`bad escape ${current}`, codePointLength(current));
    else literalText += current;
  }
  result.push(literalText);
  return result;
}

function templateNamedGroup(
  source: Tokenizer,
  groupindex: Map<string, number>,
  addGroup: (index: number, offset: number) => void
): void {
  if (!source.match('<')) throw source.error('missing <');
  const name = source.getuntil('>', 'group name');
  const nameLength = codePointLength(name);
  if (/^[0-9]+$/.test(name)) {
    const index = BigInt(name);
    if (index >= BigInt(MAXGROUPS)) throw source.error(`invalid group reference ${index}`, nameLength + 1);
    addGroup(Number(index), nameLength + 1);
    return;
  }
  source.checkgroupname(name, 1);
  const index = groupindex.get(name);
  if (index === undefined) throw new PatternSyntaxError('index', `unknown group name ${strRepr(name)}`);
  addGroup(index, nameLength + 1);
}

function templateOctal(source: Tokenizer, current: string): number {
  let text = current;
  if (source.next !== undefined && OCTDIGITS.has(source.next)) {
    text += source.get();
    if (source.next !== undefined && OCTDIGITS.has(source.next)) text += source.get();
  }
  return Number.parseInt(text.slice(1), 8);
}

/** Handles `\1` to `\99` and three-digit octal escapes, returning the character of an octal escape. */
function templateNumber(
  source: Tokenizer,
  current: string,
  addGroup: (index: number, offset: number) => void
): string | undefined {
  let text = current;
  if (source.next !== undefined && DIGITS.has(source.next)) {
    text += source.get();
    if (OCTDIGITS.has(text[1]) && OCTDIGITS.has(text[2]) && source.next !== undefined && OCTDIGITS.has(source.next)) {
      text += source.get();
      const code = Number.parseInt(text.slice(1), 8);
      if (code > 0o377) throw source.error(`octal escape value ${text} outside of range 0-0o377`, text.length);
      return String.fromCodePoint(code);
    }
  }
  addGroup(Number.parseInt(text.slice(1), 10), text.length - 1);
  return undefined;
}
