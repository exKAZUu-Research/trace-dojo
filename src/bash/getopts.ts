import { isVariableReference } from './arithmetic';
import { SCRIPT_NAME } from './runtime';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

/** Where `getopts` is in its arguments: at `OPTIND`, and inside a word of grouped options such as `-abc`. */
export interface GetoptsState {
  optind: number;
  /** The index in the current word of the next option letter, or 0 at the start of a word. */
  charIndex: number;
}

/** What `getopts` read: an option with its argument, a bad option, or the end of the options. */
type OptionRead =
  | { kind: 'option'; letter: string; argument?: string }
  | { kind: 'illegal' | 'missing'; letter: string }
  | { kind: 'end' };

/**
 * `getopts`, which reads the next option from the positional parameters or the words after its name, as Bash's
 * `sh_getopt` does: it keeps its place in a word of grouped options between calls, starting again when the program
 * changes `OPTIND`, and reports a bad option itself unless the option string starts with `:` or `OPTERR` is 0.
 */
export const getoptsBuiltin: Builtin = (shell, args) => {
  const [optstring, name, ...given] = args;
  if (name === undefined) {
    shell.fd2.write('getopts: usage: getopts optstring name [arg ...]\n');
    return 2;
  }
  if (!isVariableReference(name)) {
    shell.reportError(`getopts: \`${name}': not a valid identifier`);
    return 1;
  }
  const state = currentState(shell);
  const read = readOption(state, given.length > 0 ? given : [...shell.store.positionalArgs()], optstring);
  const silent = optstring.startsWith(':');
  if (!silent && read.kind !== 'option' && read.kind !== 'end' && shell.store.readScalar('OPTERR') !== '0') {
    const reason = read.kind === 'illegal' ? 'illegal option' : 'option requires an argument';
    shell.fd2.write(`${SCRIPT_NAME}: ${reason} -- ${read.letter}\n`);
  }
  shell.assignVariable('OPTIND', String(state.optind));
  const [letter, optarg] = resultOf(read, silent);
  if (optarg === undefined) shell.unsetVariable('OPTARG');
  else shell.assignVariable('OPTARG', optarg);
  shell.assignVariable(name, letter);
  return read.kind === 'end' ? 1 : 0;
};

/** The letter `getopts` stores and its `OPTARG`, where a silent option string reports a bad option in them. */
function resultOf(read: OptionRead, silent: boolean): [string, string | undefined] {
  switch (read.kind) {
    case 'option': {
      return [read.letter, read.argument];
    }
    case 'end': {
      return ['?', undefined];
    }
    case 'illegal': {
      return ['?', silent ? read.letter : undefined];
    }
    case 'missing': {
      return silent ? [':', read.letter] : ['?', undefined];
    }
  }
}

function readOption(state: GetoptsState, argv: readonly string[], optstring: string): OptionRead {
  if (state.charIndex === 0) {
    const word = argv[state.optind - 1];
    if (word === undefined || !word.startsWith('-') || word === '-') return { kind: 'end' };
    if (word === '--') {
      state.optind++;
      return { kind: 'end' };
    }
    state.charIndex = 1;
  }
  const word = argv[state.optind - 1] as string;
  const letter = word[state.charIndex++];
  const rest = word.slice(state.charIndex);
  if (state.charIndex >= word.length) advanceWord(state);
  const index = optstring.indexOf(letter, optstring.startsWith(':') ? 1 : 0);
  if (letter === ':' || index === -1) return { kind: 'illegal', letter };
  if (optstring[index + 1] !== ':') return { kind: 'option', letter };
  if (rest !== '') {
    advanceWord(state);
    return { kind: 'option', letter, argument: rest };
  }
  const argument = argv[state.optind - 1];
  if (argument === undefined) return { kind: 'missing', letter };
  state.optind++;
  return { kind: 'option', letter, argument };
}

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
