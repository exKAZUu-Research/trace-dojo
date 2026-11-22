import { EmulatedRegExp, toRegExp } from 'oniguruma-to-es';

import { ExecutionLimitError } from '../interpreter/limits';
import { RegexpSourceError } from './regexpEscapes';
import { onigurumaSource } from './regexpOniguruma';
import { hasSearchStartAnchor, regexpCaptureNames, type RegexpToken, regexpTokens } from './regexpTokens';
import { UnsupportedFeatureError } from './runtime';

interface RegexpFlags {
  ignoreCase?: boolean;
  multiline?: boolean;
  extended?: boolean;
}

/** What the library reported about a Ruby source. */
interface Rejection {
  message: string;
  /** The offending source text that the message quotes at its end. */
  quoted: string;
  source: string;
  extended: boolean;
}

const MAX_SUBROUTINE_EXPANSION = 100_000;
const NUMBERED_REFERENCE_REASON = 'numbered backref/call is not allowed. (use name)';
const UNSUPPORTED_PROPERTY = '正規表現のこの Unicode プロパティ';

/**
 * Ruby's reason for each library message, by message prefix; `undefined` from a function means that Ruby accepts
 * the source. The texts are the library's, so an unlisted or reworded one becomes the unsupported-feature diagnostic.
 */
const RUBY_REASONS: readonly (readonly [string, string | ((rejection: Rejection) => string | undefined)])[] = [
  ['Unmatched ")"', 'unmatched close parenthesis'],
  ['Unclosed group', 'end pattern with unmatched parenthesis'],
  ['Unclosed character class (started with "]")', 'empty char-class'],
  ['Unclosed character class', 'premature end of char-class'],
  ['Unclosed comment group', 'end pattern in group'],
  ['Character class range out of order', 'empty range in char class'],
  ['Quantifier value unsupported in Oniguruma', 'too big number for repeat range'],
  ['Numbered backref/subroutine not allowed', NUMBERED_REFERENCE_REASON],
  ['Invalid POSIX class', 'invalid POSIX bracket type'],
  ['Invalid code point out of range', 'invalid Unicode range'],
  [
    'Quantifier requires a repeatable token',
    ({ source, extended }) =>
      quantifierLacksTarget(source, extended) ? 'target of repeat operator is not specified' : undefined,
  ],
  [
    'Invalid character class range',
    ({ source }) =>
      /(?<!\\)(?:\\\\)*-(?:\\[dDsSwWhHpP]|\[:)/.test(source)
        ? 'char-class value at end of range'
        : 'unmatched range specifier in char-class',
  ],
  ['Incomplete or invalid escape', escapeReason],
  ['Incomplete or invalid Unicode property', propertyReason],
  [
    'Unsupported control character',
    ({ source }) => (source.endsWith(String.raw`\c`) ? 'too short control escape' : undefined),
  ],
  ['Invalid or unsupported group option', groupOptionReason],
  [
    'Group name "',
    ({ message }) => {
      const name = /^Group name "(.*)" invalid in Oniguruma$/s.exec(message)?.[1];
      return name ? `invalid group name <${name}>` : 'group name is empty';
    },
  ],
  [
    'Group name not defined to the left',
    ({ source, extended }) => `undefined name <${earlyReferenceName(source, extended)}> reference`,
  ],
  [
    "Subroutine uses a group name that's not defined",
    ({ quoted }) => `undefined name <${/^\\g<(.*)>$/.exec(quoted)?.[1] ?? ''}> reference`,
  ],
  [
    'Not enough capturing groups defined to the left',
    ({ quoted, source, extended }) => {
      if (regexpCaptureNames(source, extended).length > 0) return NUMBERED_REFERENCE_REASON;
      const captures = source.replaceAll(/\\[\s\S]/g, '').match(/\((?!\?)/g)?.length ?? 0;
      return Number(quoted.slice(1)) > captures ? 'invalid backref number/name' : undefined;
    },
  ],
];

const UNSUPPORTED_NAMES: readonly (readonly [string, string])[] = [
  ['Quantifier requires a repeatable token', '正規表現のアンカーの繰り返し'],
  ['Incomplete or invalid Unicode property', UNSUPPORTED_PROPERTY],
  ['Lookbehind includes a pattern not allowed', '正規表現の後読みの中のこの構文'],
  ['Unsupported conditional', '正規表現の条件分岐（(?(...)...)）'],
  ['Invalid or unsupported group option', '正規表現の文字モード（(?a) など）'],
  ['Not enough capturing groups', '正規表現の前方への後方参照'],
];

/**
 * Compiles a Ruby expression into a global host expression that reports capture indices.
 * @throws RegexpSourceError carrying Ruby's reason when Ruby rejects the expression too.
 * @throws UnsupportedFeatureError when only this environment rejects it.
 */
export function compileRegexp(source: string, flags: RegexpFlags): RegExp {
  const extended = flags.extended ?? false;
  if (((/\\+$/.exec(source)?.[0].length ?? 0) & 1) === 1) throw new RegexpSourceError('too short escape sequence');
  // The library inlines every subroutine call, so its work grows with the calls times the source they copy.
  const calls = regexpTokens(source, extended).filter(
    (token) => token.raw.startsWith(String.raw`\g`) && !token.inClass
  );
  if (calls.length * source.length > MAX_SUBROUTINE_EXPANSION)
    throw new UnsupportedFeatureError('複雑な再帰構造の正規表現');
  const prepared = onigurumaSource(source, extended);
  let compiled: RegExp;
  try {
    compiled = toRegExp(prepared, {
      flags: `${flags.ignoreCase ? 'i' : ''}${flags.multiline ? 'm' : ''}${extended ? 'x' : ''}`,
      global: true,
      hasIndices: true,
    });
  } catch (error) {
    throw compileError(error, source, extended);
  }
  // The library makes an expression that starts with `\G` sticky, which is exact; its emulation of `\G` elsewhere
  // searches a clipped subject, which changes what other anchors and look-behind see.
  const emulated = compiled instanceof EmulatedRegExp && Boolean(compiled.rawOptions.strategy);
  if ((!compiled.sticky || emulated) && hasSearchStartAnchor(source, extended))
    throw new UnsupportedFeatureError(`正規表現の先頭以外の${String.raw`\G`}`);
  return compiled;
}

/** The same expression matching only at `lastIndex`. */
export function stickyRegexp(regexp: RegExp): RegExp {
  // The library already makes an expression that starts with `\G` sticky.
  const flags = `${regexp.flags.replaceAll(/[gy]/g, '')}y`;
  return regexp instanceof EmulatedRegExp ? new EmulatedRegExp(regexp, flags) : new RegExp(regexp.source, flags);
}

function compileError(error: unknown, source: string, extended: boolean): unknown {
  if (error instanceof RangeError) return new ExecutionLimitError('operations');
  if (!(error instanceof Error)) return error;
  // The library reports its own findings as plain errors; a SyntaxError comes from the host compiling the result.
  if (error instanceof SyntaxError)
    return new UnsupportedFeatureError(/\\[pP]\{/.test(source) ? UNSUPPORTED_PROPERTY : 'この正規表現');
  const { message } = error;
  const reason = RUBY_REASONS.find(([prefix]) => message.startsWith(prefix))?.[1];
  const rubyReason =
    typeof reason === 'function'
      ? reason({ message, quoted: /"(.*)"$/s.exec(message)?.[1] ?? '', source, extended })
      : reason;
  if (rubyReason !== undefined) return new RegexpSourceError(rubyReason);
  return new UnsupportedFeatureError(
    UNSUPPORTED_NAMES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? 'この正規表現'
  );
}

/** Whether a quantifier opens the expression, a group or an alternative; Ruby accepts one after an anchor. */
function quantifierLacksTarget(source: string, extended: boolean): boolean {
  let previous: RegexpToken | undefined;
  for (const token of regexpTokens(source, extended)) {
    if (token.kind === 'ignored') continue;
    const opensOperand =
      !previous ||
      previous.kind === 'groupOpen' ||
      previous.kind === 'directive' ||
      (!previous.inClass && previous.raw === '|');
    if (opensOperand && !token.inClass && token.kind === 'char' && /^[*+?{]$/.test(token.raw)) return true;
    previous = token;
  }
  return false;
}

/** The name of the first backreference that precedes every group of that name, as the source spells it. */
function earlyReferenceName(source: string, extended: boolean): string {
  const defined = new Set<string>();
  for (const token of regexpTokens(source, extended)) {
    if (token.name !== undefined) defined.add(token.name);
    const name = /^\\k[<'](.*)[>']$/.exec(token.raw)?.[1];
    if (name !== undefined && !defined.has(name)) return name;
  }
  return '';
}

function escapeReason({ quoted, source }: Rejection): string | undefined {
  if (quoted === String.raw`\x`) return 'invalid hex escape';
  if (quoted !== String.raw`\u`) return undefined;
  return source.endsWith(String.raw`\u`) ? 'too short escape sequence' : 'invalid Unicode escape';
}

/** Ruby rejects a malformed property; a well-formed name the library does not know may still be Ruby's. */
function propertyReason({ source }: Rejection): string | undefined {
  const [, name = '', closing] = /\\[pP]\{\^?([^}]*)(\}?)/.exec(source) ?? [];
  if (name && closing) return undefined;
  return `invalid character property name {${closing ? name : name.slice(0, -1)}}`;
}

function groupOptionReason({ quoted, source }: Rejection): string | undefined {
  // Ruby's character modes `(?a)`, `(?d)` and `(?u)` have no Oniguruma counterpart.
  if (/^\(\?[imxadu]*(?:-[imx]*)?[:)]?$/.test(quoted) && /[adu]/.test(quoted)) return undefined;
  const unclosedName = /\(\?<([^=!>][^>]*)$/.exec(source)?.[1];
  if (unclosedName) return `invalid group name <${unclosedName}>`;
  if (source.endsWith('(?<')) return 'end pattern with unmatched parenthesis';
  return /\(\?[imx-]*$/.test(source) ? 'end pattern in group' : 'undefined group option';
}
