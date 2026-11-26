import { parseBuiltinOptions } from './builtinOptions';
import { classifyCommandName, rejectUnsupportedFeature } from './capabilities';
import { singleQuote } from './quoting';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

/** The words Bash's parser reserves, which `type` and `command -v` report as keywords. */
const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  'time',
  '{',
  '}',
  '!',
  '[[',
  ']]',
  'coproc',
]);

type CommandKind = 'alias' | 'keyword' | 'function' | 'builtin';

/**
 * What a name runs as, in Bash's order of lookup, or `undefined` when nothing has the name. A name that Bash would
 * find as a program on `PATH` stops the program, since this environment has no programs.
 */
function kindOf(shell: Shell, name: string): CommandKind | undefined {
  if (shell.store.aliases.has(name)) return 'alias';
  if (KEYWORDS.has(name)) return 'keyword';
  const classified = classifyCommandName(name, shell.store.hasFunction(name), shell.isRegularBuiltin(name));
  switch (classified.kind) {
    case 'function': {
      return 'function';
    }
    case 'notFound': {
      return undefined;
    }
    case 'external': {
      return rejectUnsupportedFeature(classified.feature);
    }
    default: {
      return 'builtin';
    }
  }
}

/**
 * `command`, which runs a builtin even when a function has its name, or with `-v` or `-V` tells what names run as.
 * A function's body, which `-V` shows, and `-p`, which searches the default `PATH`, are not provided.
 */
export const commandBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'command', args, 'pvV', 'command [-pVv] command [arg ...]');
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  if (options.has('p')) rejectUnsupportedFeature('command -p（既定の PATH での検索）');
  if (options.has('v') || options.has('V')) {
    let status = 0;
    for (const name of operands) {
      const kind = kindOf(shell, name);
      if (kind === undefined) {
        if (options.has('V')) shell.reportError(`command: ${name}: not found`);
        status = 1;
      } else if (options.has('V')) describe(shell, name, kind);
      else shell.fd1.write(kind === 'alias' ? `${aliasLine(shell, name)}\n` : `${name}\n`);
    }
    return status;
  }
  const [name, ...rest] = operands;
  if (name === undefined) return 0;
  return shell.invokeCommand(name, rest, { skipFunctions: true });
};

/** `builtin`, which runs a builtin even when a function has its name. */
export const builtinBuiltin: Builtin = (shell, args) => {
  const operands = args[0] === '--' ? args.slice(1) : args;
  const [name, ...rest] = operands;
  if (name === undefined) return 0;
  if (kindOf(shell, name) === 'builtin' || shell.isRegularBuiltin(name)) {
    return shell.invokeCommand(name, rest, { skipFunctions: true });
  }
  shell.reportError(`builtin: ${name}: not a shell builtin`);
  return 1;
};

/** `type`, which tells what names run as; `-t` prints one word for each. */
export const typeBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'type', args, 'afptP', 'type [-afptP] name [name ...]');
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  if (options.has('a') || options.has('P'))
    rejectUnsupportedFeature(`type -${options.has('a') ? 'a' : 'P'}（PATH の検索）`);
  let status = 0;
  for (const name of operands) {
    const kind = kindOf(shell, name);
    if (kind === undefined) {
      if (!options.has('t') && !options.has('p')) shell.reportError(`type: ${name}: not found`);
      status = 1;
    } else if (options.has('t')) shell.fd1.write(`${kind === 'builtin' ? 'builtin' : kind}\n`);
    else if (!options.has('p')) describe(shell, name, kind);
  }
  return status;
};

function describe(shell: Shell, name: string, kind: CommandKind): void {
  switch (kind) {
    case 'alias': {
      shell.fd1.write(`${name} is aliased to \`${shell.store.aliases.get(name)}'\n`);
      return;
    }
    case 'keyword': {
      shell.fd1.write(`${name} is a shell keyword\n`);
      return;
    }
    case 'builtin': {
      shell.fd1.write(`${name} is a shell builtin\n`);
      return;
    }
    case 'function': {
      rejectUnsupportedFeature(`関数の本文の表示（${name}）`);
    }
  }
}

/**
 * `caller`, which prints where the running function was called: with no operand the line and file, and with `n`
 * the line, function, and file `n` calls up.
 */
export const callerBuiltin: Builtin = (shell, args) => {
  const [operand] = args[0] === '--' ? args.slice(1) : args;
  const lines = shell.store.readArrayValues('BASH_LINENO');
  const names = shell.store.readArrayValues('FUNCNAME');
  const files = shell.store.readArrayValues('BASH_SOURCE');
  if (operand === undefined) {
    shell.fd1.write(`${lines[0] ?? 0} ${files[1] ?? 'NULL'}\n`);
    return 0;
  }
  if (!/^\d+$/.test(operand)) {
    shell.reportError(`caller: ${operand}: invalid number`);
    shell.fd2.write('caller: usage: caller [expr]\n');
    return 2;
  }
  const level = Number(operand);
  if (level + 1 >= names.length) return 1;
  shell.fd1.write(`${lines[level]} ${names[level + 1]} ${files[level + 1]}\n`);
  return 0;
};

function aliasLine(shell: Shell, name: string): string {
  return `alias ${name}=${singleQuote(shell.store.aliases.get(name) as string)}`;
}

/**
 * `alias`, which defines and prints aliases. A script does not expand them unless `expand_aliases` is on, which this
 * environment does not provide, so they only print.
 */
export const aliasBuiltin: Builtin = (shell, args) => {
  const operands = args[0] === '-p' ? args.slice(1) : args;
  const { aliases } = shell.store;
  if (operands.length === 0) {
    for (const name of [...aliases.keys()].toSorted()) shell.fd1.write(`${aliasLine(shell, name)}\n`);
    return 0;
  }
  let status = 0;
  for (const operand of operands) {
    const equals = operand.indexOf('=');
    if (equals > 0) aliases.set(operand.slice(0, equals), operand.slice(equals + 1));
    else if (aliases.has(operand)) shell.fd1.write(`${aliasLine(shell, operand)}\n`);
    else {
      shell.reportError(`alias: ${operand}: not found`);
      status = 1;
    }
  }
  return status;
};

export const unaliasBuiltin: Builtin = (shell, args) => {
  const { aliases } = shell.store;
  if (args[0] === '-a') {
    aliases.clear();
    return 0;
  }
  if (args.length === 0) {
    shell.fd2.write('unalias: usage: unalias [-a] name [name ...]\n');
    return 2;
  }
  let status = 0;
  for (const name of args[0] === '--' ? args.slice(1) : args) {
    if (!aliases.delete(name)) {
      shell.reportError(`unalias: ${name}: not found`);
      status = 1;
    }
  }
  return status;
};

/** `logout`, which only a login shell runs, so a script's fails. */
export const logoutBuiltin: Builtin = (shell) => {
  shell.reportError("logout: not login shell: use `exit'");
  return 1;
};
