// `re.Match` and the expansion of replacement templates, which `Match.expand` and `Pattern.sub` share.
import { bytesLikeData, latin1Bytes, latin1Text, newBytes } from '../../bytesValues';
import { pyRepr } from '../../conversions';
import { pyHash } from '../../hashing';
import { checkArgs } from '../../nativeArgs';
import { toIndex } from '../../numbers';
import { lookupSpecial } from '../../objects';
import { builtinClass, defineMethod, newDict, newTuple, None, pyError, typeError, typeName, unbox } from '../../types';
import { type Kwargs, PyObject, type PyValue } from '../../values';
import { clinicArgs } from './arguments';
import { readOnlyAttribute } from './attributes';
import type { MatchState } from './matcher';
import { type PatternObject, syntaxError } from './pattern';
import { joinPieces, sliceOf, type Subject } from './subject';
import { parseTemplate } from './template';
import { PatternSyntaxError } from './tokenizer';

export const matchClass = builtinClass('Match');
matchClass.typeName = 're.Match';
matchClass.module = 're';
matchClass.construct = () => {
  throw typeError("cannot create 're.Match' instances");
};

export class MatchObject extends PyObject {
  constructor(
    readonly pattern: PatternObject,
    readonly subject: Subject,
    readonly pos: number,
    readonly endpos: number,
    /** The start and end of each group, group 0 first, with -1 for a group that did not participate. */
    readonly spans: number[],
    readonly lastindex: number
  ) {
    super(matchClass);
  }

  group(index: number): PyValue {
    const [start, end] = [this.spans[index * 2], this.spans[index * 2 + 1]];
    return start < 0 ? None : sliceOf(this.subject, start, end);
  }
}

/** A Match for what `state` matched, as `pattern_new_match` creates it. */
export function newMatch(pattern: PatternObject, subject: Subject, state: MatchState): MatchObject {
  const spans = [state.start, state.ptr];
  for (let group = 1; group <= pattern.groups; group++) spans.push(...state.groupSpan(group));
  return new MatchObject(pattern, subject, state.pos, state.endpos, spans, state.lastindex);
}

function asMatch(value: PyValue): MatchObject {
  return value as MatchObject;
}

/** The number of a group given by number or name, as `match_getindex` reads it. */
function groupIndex(match: MatchObject, index: PyValue): number {
  let found = -1;
  if (typeof index === 'bigint' || typeof index === 'boolean' || hasIndex(index)) {
    const value = toIndex(index);
    if (value >= 0n && value <= BigInt(match.pattern.groups)) found = Number(value);
  } else {
    hashKey(index);
    if (typeof index === 'string') found = match.pattern.groupindex.get(index) ?? -1;
  }
  if (found < 0) throw pyError('IndexError', 'no such group');
  return found;
}

function hasIndex(value: PyValue): boolean {
  return value instanceof PyObject && lookupSpecial(value, '__index__') !== undefined;
}

function hashKey(key: PyValue): void {
  try {
    pyHash(key);
  } catch (error) {
    const message = (error as { exception?: { exception?: { args: { items: readonly PyValue[] } } } }).exception
      ?.exception?.args.items[0];
    if (typeof message === 'string' && message.startsWith('unhashable type'))
      throw typeError(`cannot use '${typeName(key)}' as a dict key (${message})`);
    throw error;
  }
}

function positionalOnly(name: string, max: number, run: (match: MatchObject, args: PyValue[]) => PyValue): void {
  defineMethod(matchClass, name, (self, args, kwargs) => {
    checkArgs({ qualified: `Match.${name}`, short: name, min: 0, max, style: 'expected' }, args, kwargs);
    return run(asMatch(self), args);
  });
}

function keywordMethod(
  name: string,
  params: readonly string[],
  required: number,
  run: (match: MatchObject, args: (PyValue | undefined)[]) => PyValue
): void {
  defineMethod(matchClass, name, (self, args, kwargs: Kwargs) =>
    run(asMatch(self), clinicArgs(name, params, required, args, kwargs))
  );
}

const MATCH_MEMBERS = new Set(['string', 're', 'pos', 'endpos']);

function property(name: string, get: (match: MatchObject) => PyValue): void {
  readOnlyAttribute(matchClass, name, MATCH_MEMBERS.has(name) ? 'member' : 'getset', (self) => get(asMatch(self)));
}

positionalOnly('group', Number.POSITIVE_INFINITY, (match, args) => {
  if (args.length === 0) return match.group(0);
  if (args.length === 1) return match.group(groupIndex(match, args[0]));
  return newTuple(args.map((arg) => match.group(groupIndex(match, arg))));
});
defineMethod(matchClass, '__getitem__', (self, [index]) => asMatch(self).group(groupIndex(asMatch(self), index)));
positionalOnly('start', 1, (match, [group = 0n]) => BigInt(match.spans[groupIndex(match, group) * 2]));
positionalOnly('end', 1, (match, [group = 0n]) => BigInt(match.spans[groupIndex(match, group) * 2 + 1]));
positionalOnly('span', 1, (match, [group = 0n]) => {
  const index = groupIndex(match, group);
  return newTuple([BigInt(match.spans[index * 2]), BigInt(match.spans[index * 2 + 1])]);
});
keywordMethod('groups', ['default'], 0, (match, [fallback = None]) => {
  const groups: PyValue[] = [];
  for (let index = 1; index <= match.pattern.groups; index++) {
    const value = match.group(index);
    groups.push(value === None ? fallback : value);
  }
  return newTuple(groups);
});
keywordMethod('groupdict', ['default'], 0, (match, [fallback = None]) => {
  const entries: [PyValue, PyValue][] = [];
  for (const [name, index] of match.pattern.groupindex) {
    const value = match.group(index);
    entries.push([name, value === None ? fallback : value]);
  }
  return newDict(entries);
});
keywordMethod('expand', ['template'], 1, (match, [template]) =>
  expandTemplate(compileTemplate(match.pattern, template as PyValue), match)
);
defineMethod(matchClass, '__repr__', (self) => {
  const match = asMatch(self);
  return `<re.Match object; span=(${match.spans[0]}, ${match.spans[1]}), match=${truncate(pyRepr(match.group(0)), 50)}>`;
});
defineMethod(matchClass, '__copy__', (self) => self);
defineMethod(matchClass, '__deepcopy__', (self) => self);

property('string', (match) => match.subject.original);
property('re', (match) => match.pattern);
property('pos', (match) => BigInt(match.pos));
property('endpos', (match) => BigInt(match.endpos));
property('lastindex', (match) => (match.lastindex < 0 ? None : BigInt(match.lastindex)));
property('lastgroup', (match) => match.pattern.indexgroup[match.lastindex] ?? None);
property('regs', (match) => {
  const regs: PyValue[] = [];
  for (let index = 0; index < match.spans.length; index += 2)
    regs.push(newTuple([BigInt(match.spans[index]), BigInt(match.spans[index + 1])]));
  return newTuple(regs);
});

/** Shortens a repr to `length` code points, as `%.<length>R` does in CPython's format strings. */
export function truncate(text: string, length: number): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- The precision counts code points.
  const chars = [...text];
  return chars.length > length ? chars.slice(0, length).join('') : text;
}

/**
 * Parses a replacement template, as `re._compile_template` does: a str, or a bytes-like object whose literal parts
 * stay bytes. A template without backslashes stays the object it is, as CPython's `pattern_subx` keeps it.
 */
export function compileTemplate(pattern: PatternObject, template: PyValue): CompiledTemplate {
  const text = unbox(template);
  const data = typeof text === 'string' ? undefined : bytesLikeData(template);
  if (typeof text !== 'string' && data === undefined) {
    throw typeError(`decoding to str: need a bytes-like object, ${typeName(template)} found`);
  }
  const source = data === undefined ? (text as string) : latin1Text(data);
  const isBytes = data !== undefined;
  const toValue = (part: string | number): PyValue | number =>
    typeof part === 'number' || !isBytes ? part : newBytes(latin1Bytes(part));
  if (!source.includes('\\')) return { parts: [toValue(source)], literal: true, isBytes, original: template };
  try {
    const parts = parseTemplate(source, pattern.groups, pattern.groupindex, !isBytes);
    return { parts: parts.map(toValue), literal: false, isBytes, original: template };
  } catch (error) {
    if (error instanceof PatternSyntaxError) throw syntaxError(error, template);
    throw error;
  }
}

/** A replacement template's literal pieces, of the template's own type, and group numbers. */
export interface CompiledTemplate {
  parts: (PyValue | number)[];
  /** Whether the template had no escapes and so is its one piece. */
  literal: boolean;
  isBytes: boolean;
  original: PyValue;
}

/**
 * Expands a template for a match, joined as the template's type is. `re.sub` puts a template without escapes in as
 * the object it is, while `Match.expand` gives its str or bytes.
 */
export function expandTemplate(template: CompiledTemplate, match: MatchObject, forSub = false): PyValue {
  if (template.literal) return forSub ? template.original : (template.parts[0] as PyValue);
  const pieces: PyValue[] = [];
  for (const part of template.parts) {
    if (typeof part !== 'number') pieces.push(part);
    else {
      const value = match.group(part);
      if (value !== None) pieces.push(value);
    }
  }
  return joinPieces(template.isBytes, pieces);
}
