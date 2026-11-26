import type { Statement } from './ast';
import { rejectControlVariable, rejectUnsupportedFeature } from './capabilities';
import { ansicQuote, ansicShouldQuote, singleQuote } from './quoting';
import type { Shell } from './shell';

/** What `set -x` prints before a command when `PS4` is unset. */
const DEFAULT_PS4 = '+ ';

/**
 * Prints a line of the execution trace that `set -x` turns on, after `PS4`, whose first character repeats once for
 * each level of command substitution, as Bash prints it.
 */
export function traceLine(shell: Shell, text: string): void {
  rejectControlVariable(shell.store.readScalar('BASH_XTRACEFD'), 'BASH_XTRACEFD', 'set -x の出力先');
  const ps4 = shell.store.readScalar('PS4') ?? DEFAULT_PS4;
  // Bash expands `PS4` like a prompt, whose escapes and expansions this environment does not provide.
  if (/[\\$`]/.test(ps4)) rejectUnsupportedFeature('PS4 の展開');
  const prefix = ps4 === '' ? '' : `${ps4[0].repeat(shell.traceLevel)}${ps4.slice(1)}`;
  shell.fd2.write(`${prefix}${text}\n`);
}

/** Prints the words of a command, each quoted as Bash's trace quotes it. */
export function traceWords(shell: Shell, words: readonly string[]): void {
  traceLine(shell, words.map(quoteTraceWord).join(' '));
}

/** Prints an assignment as `name=value`, with the value quoted as a word is. */
export function traceAssignment(shell: Shell, target: string, operator: string, value: string): void {
  traceLine(shell, `${target}${operator}${value === '' ? '' : quoteTraceWord(value)}`);
}

/**
 * A word as the trace shows it: `$'...'` for one with characters that do not print, single quotes for one with
 * characters the shell treats specially, and as it is otherwise.
 */
function quoteTraceWord(word: string): string {
  if (word === '') return "''";
  if (ansicShouldQuote(word)) return ansicQuote(word);
  return containsShellMetas(word) ? singleQuote(word) : word;
}

/** Whether a word holds a character Bash's `sh_contains_shell_metas` lists, which the trace quotes. */
function containsShellMetas(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (' \t\n\'"\\|&;()<>!{}*[?]^$`'.includes(c)) return true;
    if (c === '~' && (i === 0 || word[i - 1] === '=' || word[i - 1] === ':')) return true;
    if (c === '#' && i === 0) return true;
  }
  return false;
}

/**
 * What `set -x` shows of a `for` or `select` header after its keyword: the words as written, as Bash prints the
 * command, with `"$@"` for a header without `in`, which stands for it.
 */
export function loopHeaderText(statement: Extract<Statement, { kind: 'for' }>): string {
  const words = statement.values ? statement.values.map((word) => word.text) : ['"$@"'];
  return `${statement.variable} in ${words.join(' ')}`;
}
