import type { BackquoteSyntaxError } from './ast';
import { checkBashSyntax } from './syntaxCheck';

/**
 * Hides the bodies of the backquoted command substitutions that Bash cannot parse, which it reports only when it
 * runs them, so that the grammar reads the rest of the program; each error is kept by the index of its `` ` ``.
 */
export function hideInvalidBackquotes(
  source: string,
  backquotes: readonly { start: number; end: number }[]
): { source: string; errors: Map<number, BackquoteSyntaxError> } {
  const errors = new Map<number, BackquoteSyntaxError>();
  let hidden = source;
  for (const { start, end } of backquotes) {
    const error = backquoteSyntaxError(source, start, end);
    if (!error) continue;
    errors.set(start, error);
    const body = source.slice(start + 1, end - 1).replaceAll(/[^\n]/g, ' ');
    hidden = `${hidden.slice(0, start + 1)}${body}${hidden.slice(end - 1)}`;
  }
  return { source: hidden, errors };
}

function backquoteSyntaxError(source: string, start: number, end: number): BackquoteSyntaxError | undefined {
  // Bash removes the backslashes before `$`, `` ` ``, and `\` and reads the body as lines that start at its own.
  const body = source.slice(start + 1, end - 1).replaceAll(/\\([$`\\])/g, '$1');
  const row = source.slice(0, start).split('\n').length - 1;
  const text = `${'\n'.repeat(row)}${body}\n`;
  const { error } = checkBashSyntax(text);
  if (!error || error === 'unknown') return undefined;
  const messages = error.near === undefined ? [error.text] : [error.text, `syntax error near \`${error.near}'`];
  const shows = (messages.at(-1) as string).startsWith('syntax error near');
  return { row: error.row, messages, ...(shows ? { line: text.split('\n')[error.row] } : {}) };
}
