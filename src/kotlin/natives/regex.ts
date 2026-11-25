import { patternSyntaxMessage } from '../../java/builtinText';
import { translateJavaRegex, UnsupportedRegexError } from '../../java/javaRegex';
import { javaReplacer, ReplacementError } from '../../java/javaReplacement';
import type { Frame } from '../runtime';
import { indexedItems, KObject, NULL, type Value } from '../values';
import { defineNative, defineNativeProperty, newItems, throwError } from './registry';

interface CompiledRegex {
  pattern: string;
  options: Value;
  /** Finds matches from any index, with the boundaries of the groups. */
  search: RegExp;
  /** Matches the whole input only, as `matchEntire` does. */
  whole: RegExp;
}

/** The embedded flags of `java.util.regex.Pattern` that each `RegexOption` sets. */
const OPTION_FLAGS: Record<string, string> = {
  // Kotlin/JVM's Regex adds UNICODE_CASE to IGNORE_CASE, so that case folds beyond ASCII.
  IGNORE_CASE: 'iu',
  MULTILINE: 'm',
  UNIX_LINES: 'd',
  COMMENTS: 'x',
  DOT_MATCHES_ALL: 's',
};

/** The options a Regex was given: none, one, or the array its constructor makes of a set of them. */
function optionValues(options: Value): Value[] {
  if (options === NULL) return [];
  if (options instanceof KObject && options.native?.name !== undefined) return [options];
  const items = indexedItems(options as KObject);
  if (!items) throw new Error('Regex options that are not an array of options');
  return items;
}

function optionNames(options: Value): string[] {
  return optionValues(options).map((option) => ((option as KObject).native?.name as string) ?? '');
}

function compile(frame: Frame, pattern: string, options: Value): CompiledRegex {
  const names = optionNames(options);
  const flags = names.map((name) => OPTION_FLAGS[name] ?? '').join('');
  const literal = names.includes('LITERAL')
    ? `\\Q${pattern.replaceAll(String.raw`\E`, String.raw`\E\\E\Q`)}\\E`
    : pattern;
  const source = flags ? `(?${flags})${literal}` : literal;
  try {
    const search = translateJavaRegex(source, false);
    const whole = translateJavaRegex(source, true);
    const searchRegExp = new RegExp(search.source, `${search.flags}gd`);
    return {
      pattern,
      options,
      search: searchRegExp,
      whole: new RegExp(whole.source, `${whole.flags}gd`),
    };
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof UnsupportedRegexError)) throw error;
    const { description, index } =
      error instanceof UnsupportedRegexError ? error : { description: 'Invalid regular expression', index: -1 };
    return throwError(
      frame,
      'java.util.regex.PatternSyntaxException',
      patternSyntaxMessage(description, index, pattern)
    );
  }
}

function regexOf(value: Value): CompiledRegex {
  return (value as KObject).native?.regex as CompiledRegex;
}

function initialize(frame: Frame, receiver: Value, pattern: Value, options: Value): void {
  (receiver as KObject).native = { regex: compile(frame, pattern as string, options) };
}

defineNative('kotlin.text.Regex.<init>(String)', (frame, receiver, [pattern]) => {
  initialize(frame, receiver, pattern, NULL);
});
defineNative('kotlin.text.Regex.<init>(String, RegexOption)', (frame, receiver, [pattern, option]) => {
  initialize(frame, receiver, pattern, option);
});
defineNative('kotlin.text.Regex.<init>(String, Array<RegexOption>)', (frame, receiver, [pattern, options]) => {
  initialize(frame, receiver, pattern, options);
});
defineNativeProperty('kotlin.text.Regex.pattern', (_frame, receiver) => regexOf(receiver).pattern);
defineNative('kotlin.text.Regex.optionList()', (frame, receiver) =>
  newItems(frame, 'kotlin.collections.ArrayList', optionValues(regexOf(receiver).options))
);

defineNative('kotlin.text.Regex.matchData(String, Int, Boolean)', (frame, receiver, [input, startIndex, isWhole]) => {
  const regex = regexOf(receiver);
  const text = input as string;
  frame.runtime.spend(1 + Math.floor(text.length / 64));
  const regExp = isWhole ? regex.whole : regex.search;
  regExp.lastIndex = isWhole ? 0 : (startIndex as number);
  const match = regExp.exec(text);
  if (!match?.indices) return NULL;
  const data = match.indices.flatMap((range) => (range ? [range[0], range[1]] : [-1, -1]));
  return newItems(frame, 'kotlin.IntArray', data);
});

defineNative('kotlin.text.Regex.groupNameArray()', (frame, receiver) =>
  newItems(frame, 'kotlin.Array', groupNamesByIndex(regexOf(receiver).search.source))
);

/** The name of each group of a translated expression by its index, the whole match's first, with "" for no name. */
function groupNamesByIndex(source: string): string[] {
  const names = [''];
  let classDepth = 0;
  for (let position = 0; position < source.length; position++) {
    const char = source[position];
    if (char === '\\') {
      position++;
    } else if (char === '[') {
      classDepth++;
    } else if (char === ']' && classDepth > 0) {
      classDepth--;
    } else if (char === '(' && classDepth === 0) {
      const named = /^\(\?<([A-Za-z][A-Za-z0-9]*)>/.exec(source.slice(position));
      if (named) names.push(named[1]);
      else if (source[position + 1] !== '?') names.push('');
    }
  }
  return names;
}

defineNative(
  'kotlin.text.Regex.replaceText(String, String, Boolean)',
  (frame, receiver, [input, replacement, isGlobal]) => {
    const regex = regexOf(receiver);
    const text = input as string;
    frame.runtime.spend(1 + Math.floor(text.length / 64));
    const regExp = isGlobal ? regex.search : new RegExp(regex.search.source, regex.search.flags.replace('g', ''));
    regExp.lastIndex = 0;
    try {
      return text.replace(regExp, javaReplacer(replacement as string));
    } catch (error) {
      if (!(error instanceof ReplacementError)) throw error;
      return throwError(frame, `java.lang.${error.exception}`, error.message);
    }
  }
);
defineNative('kotlin.text.Regex.Companion.escapeReplacement(String)', (_frame, _receiver, [literal]) =>
  (literal as string).replaceAll(/[\\$]/g, (char) => `\\${char}`)
);
