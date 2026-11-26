import { rejectUnsupportedFeature, rejectUnsupportedSetArgs } from './capabilities';
import {
  isImplementedOption,
  isSetOptionName,
  isShoptName,
  SET_FLAG_NAMES,
  SET_OPTION_NAMES,
  type SetOptionName,
  SHOPT_NAMES,
  type ShoptName,
} from './options';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

const SET_USAGE = 'set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]';
const SHOPT_USAGE = 'shopt [-pqsu] [-o] [optname ...]';

/** Turns an option on or off, rejecting a change this environment does not implement. */
function changeOption(shell: Shell, name: SetOptionName | ShoptName, value: boolean, written: string): void {
  if (shell.options[name] === value) return;
  if (!isImplementedOption(name)) rejectUnsupportedFeature(`シェルのオプション（${written}）`);
  shell.options[name] = value;
}

/**
 * `set`, which changes options by flag (`-e`, `+u`) or name (`-o pipefail`), lists them with `-o` or `+o` alone, and
 * replaces the positional parameters with the words after its options.
 */
// code-gauge-allow functionCognitiveComplexity -- Scans flags, `-o` names, and the `--` and `-` markers in one pass as Bash's `set` does.
export const setBuiltin: Builtin = (shell, args) => {
  if (args.length === 0) rejectUnsupportedSetArgs();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      shell.store.setPositionalArgs(args.slice(index + 1));
      return 0;
    }
    if (arg === '-') {
      if (index + 1 < args.length) shell.store.setPositionalArgs(args.slice(index + 1));
      return 0;
    }
    if (!/^[-+]./.test(arg)) {
      shell.store.setPositionalArgs(args.slice(index));
      return 0;
    }
    const value = arg[0] === '-';
    for (const flag of arg.slice(1)) {
      if (flag === 'o') {
        const name = args[index + 1];
        if (name === undefined) {
          listSetOptions(shell, value);
          continue;
        }
        index++;
        if (!isSetOptionName(name)) {
          shell.reportError(`set: ${name}: invalid option name`);
          return 2;
        }
        changeOption(shell, name, value, `set ${arg[0]}o ${name}`);
        continue;
      }
      const name = SET_FLAG_NAMES.get(flag);
      if (name === undefined) {
        shell.reportError(`set: ${arg[0]}${flag}: invalid option`);
        shell.fd2.write(`set: usage: ${SET_USAGE}\n`);
        return 2;
      }
      changeOption(shell, name, value, `set ${arg[0]}${flag}`);
    }
  }
  return 0;
};

function listSetOptions(shell: Shell, asTable: boolean): void {
  for (const name of SET_OPTION_NAMES) {
    const on = shell.options[name];
    shell.fd1.write(asTable ? `${name.padEnd(15)}\t${on ? 'on' : 'off'}\n` : `set ${on ? '-' : '+'}o ${name}\n`);
  }
}

/** `shopt`, which sets (`-s`), unsets (`-u`), tests (`-q`), or prints options, of `shopt` or with `-o` of `set -o`. */
// code-gauge-allow functionCognitiveComplexity -- Combines Bash's `shopt` modes: set, unset, quiet test, and the two print formats.
export const shoptBuiltin: Builtin = (shell, args) => {
  const flags = new Set<string>();
  let index = 0;
  for (; index < args.length && /^-[pqsuo]+$/.test(args[index]); index++) {
    for (const flag of args[index].slice(1)) flags.add(flag);
  }
  if (args[index] === '--') index++;
  else if (args[index]?.startsWith('-') && args[index] !== '-') {
    const invalid = /[^pqsuo]/.exec(args[index].slice(1))?.[0] ?? args[index][1];
    shell.reportError(`shopt: -${invalid}: invalid option`);
    shell.fd2.write(`shopt: usage: ${SHOPT_USAGE}\n`);
    return 2;
  }
  if (flags.has('s') && flags.has('u')) {
    shell.reportError('shopt: cannot set and unset shell options simultaneously');
    return 1;
  }
  const usesSet = flags.has('o');
  const allNames: readonly (SetOptionName | ShoptName)[] = usesSet ? SET_OPTION_NAMES : SHOPT_NAMES;
  const requested = args.slice(index);
  const setting = flags.has('s') ? true : flags.has('u') ? false : undefined;
  let status = 0;
  const names: (SetOptionName | ShoptName)[] = [];
  for (const name of requested) {
    if (usesSet ? isSetOptionName(name) : isShoptName(name)) names.push(name as SetOptionName | ShoptName);
    else {
      shell.reportError(`shopt: ${name}: invalid ${usesSet ? 'option name' : 'shell option name'}`);
      status = 1;
    }
  }
  if (setting !== undefined && requested.length > 0) {
    for (const name of names) changeOption(shell, name, setting, `shopt ${flags.has('s') ? '-s' : '-u'} ${name}`);
    return status;
  }
  const shown =
    requested.length > 0 ? names : allNames.filter((name) => setting === undefined || shell.options[name] === setting);
  for (const name of shown) {
    const on = shell.options[name];
    if (!on && requested.length > 0) status = 1;
    if (flags.has('q')) continue;
    if (flags.has('p')) {
      shell.fd1.write(usesSet ? `set ${on ? '-' : '+'}o ${name}\n` : `shopt ${on ? '-s' : '-u'} ${name}\n`);
    } else shell.fd1.write(`${name.padEnd(20)}\t${on ? 'on' : 'off'}\n`);
  }
  return status;
};
