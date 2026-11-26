import { SCRIPT_NAME } from './runtime';
import type { Shell } from './shell';
import type { Builtin } from './turtle';
import { isIdentifier } from './variables';

/** Where `getopts` is in its arguments: at `OPTIND`, and inside a word of grouped options such as `-abc`. */
export interface GetoptsState {
  optind: number;
  /** The index in the current word of the next option letter, or 0 at the start of a word. */
  charIndex: number;
}

/**
 * `getopts`, which reads the next option from the positional parameters or the words after its name, as Bash's
 * `sh_getopt` does: it keeps its place in a word of grouped options between calls, starting again when the program
 * changes `OPTIND`, and reports a bad option itself unless the option string starts with `:` or `OPTERR` is 0.
 */
export const getoptsBuiltin: Builtin = (shell, args) => {
  const [optstring, name, ...given] = args;
  if (name === undefined) {
    shell.reportError('getopts: usage: getopts optstring name [arg ...]');
    shell.fd2.write('getopts: usage: getopts optstring name [arg ...]\n');
    return 2;
  }
  if (!isIdentifier(name)) {
    shell.reportError(`getopts: \`${name}': not a valid identifier`);
    return 1;
  }
  const argv = given.length > 0 ? given : [...shell.store.positionalArgs()];
  const state = currentState(shell);
  const silent = optstring.startsWith(':');
  const reports = !silent && shell.store.readScalar('OPTERR') !== '0';
  const finish = (letter: string, optarg: string | undefined, status = 0): number => {
    shell.assignVariable('OPTIND', String(state.optind));
    if (optarg === undefined) shell.unsetVariable('OPTARG');
    else shell.assignVariable('OPTARG', optarg);
    shell.assignVariable(name, letter);
    return status;
  };
  if (state.charIndex === 0) {
    const word = argv[state.optind - 1];
    if (word === undefined || !word.startsWith('-') || word === '-') return finish('?', undefined, 1);
    if (word === '--') {
      state.optind++;
      return finish('?', undefined, 1);
    }
    state.charIndex = 1;
  }
  const word = argv[state.optind - 1] as string;
  const letter = word[state.charIndex++];
  const rest = word.slice(state.charIndex);
  if (state.charIndex >= word.length) advanceWord(state);
  const index = optstring.indexOf(letter, silent ? 1 : 0);
  if (letter === ':' || index === -1) {
    if (reports) shell.fd2.write(`${SCRIPT_NAME}: illegal option -- ${letter}\n`);
    return finish('?', silent ? letter : undefined);
  }
  if (optstring[index + 1] !== ':') return finish(letter, undefined);
  if (rest !== '') {
    advanceWord(state);
    return finish(letter, rest);
  }
  const argument = argv[state.optind - 1];
  if (argument === undefined) {
    if (reports) shell.fd2.write(`${SCRIPT_NAME}: option requires an argument -- ${letter}\n`);
    return silent ? finish(':', letter) : finish('?', undefined);
  }
  state.optind++;
  return finish(letter, argument);
};

function advanceWord(state: GetoptsState): void {
  state.optind++;
  state.charIndex = 0;
}

/** The state of `getopts`, started again when `OPTIND` no longer holds the index it left there. */
function currentState(shell: Shell): GetoptsState {
  const state = shell.store.getopts;
  const text = shell.store.readScalar('OPTIND');
  const optind = text !== undefined && /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : 1;
  if (optind !== state.optind) {
    state.optind = optind;
    state.charIndex = 0;
  }
  return state;
}
