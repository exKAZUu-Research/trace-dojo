import type { BackquoteSyntaxError } from './ast';
import { checkBashSyntax } from './syntaxCheck';

/**
 * Hides the bodies of the backquoted command substitutions that Bash cannot parse, which it reports only when it
 * runs them, so that the grammar reads the rest of the program; each error is kept by the index of its `` ` ``.
 */
export function hideInvalidBackquotes(
  source: string,
  backquotes: readonly { start: number; end: number }[]
): { source: string; errors: Map<number, BackquoteSyntaxError>; literalSingleQuotes: number[] } {
  const errors = new Map<number, BackquoteSyntaxError>();
  const literalSingleQuotes: number[] = [];
  let hidden = source;
  for (const { start, end } of backquotes) {
    const { error, quoteOffsets } = inspectBackquote(source, start, end);
    if (!error) {
      literalSingleQuotes.push(...quoteOffsets);
      continue;
    }
    errors.set(start, error);
    const body = source.slice(start + 1, end - 1).replaceAll(/[^\n]/g, ' ');
    hidden = `${hidden.slice(0, start + 1)}${body}${hidden.slice(end - 1)}`;
  }
  return { source: hidden, errors, literalSingleQuotes };
}

function inspectBackquote(
  source: string,
  start: number,
  end: number
): { error: BackquoteSyntaxError | undefined; quoteOffsets: number[] } {
  // Bash removes the backslashes before `$`, `` ` ``, and `\` and reads the body as lines that start at its own.
  let body = '';
  const bodyOffsets: number[] = [];
  for (let i = start + 1; i < end - 1; i++) {
    if (source[i] === '\\' && i + 1 < end - 1 && '$`\\'.includes(source[i + 1])) i++;
    bodyOffsets.push(i);
    body += source[i];
  }
  const row = source.slice(0, start).split('\n').length - 1;
  const pad = '\n'.repeat(row);
  const text = `${pad}${body}\n`;
  const { error, backquotes: innerBqs, literalSingleQuotes } = checkBashSyntax(text);
  if (error && error !== 'unknown') {
    const messages = error.near === undefined ? [error.text] : [error.text, `syntax error near \`${error.near}'`];
    const shows = (messages.at(-1) as string).startsWith('syntax error near');
    return {
      error: { row: error.row, messages, ...(shows ? { line: text.split('\n')[error.row] } : {}) },
      quoteOffsets: [],
    };
  }
  const nestedQuotes = hideInvalidBackquotes(text, innerBqs).literalSingleQuotes;
  const quoteOffsets = [...literalSingleQuotes, ...nestedQuotes]
    .map((idx) => idx - pad.length)
    .filter((idx) => idx >= 0 && idx < bodyOffsets.length)
    .map((idx) => bodyOffsets[idx]);
  return { error: undefined, quoteOffsets };
}
