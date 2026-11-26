/**
 * The options of `set -o`, as Bash 5.3 lists them, with their single-letter flags, their values in a script, and
 * whether this environment implements changing them.
 */
const SET_OPTION_TABLE = [
  ['allexport', 'a', false, false],
  ['braceexpand', 'B', true, true],
  ['emacs', undefined, false, false],
  ['errexit', 'e', false, true],
  ['errtrace', 'E', false, true],
  ['functrace', 'T', false, false],
  ['hashall', 'h', true, true],
  ['histexpand', 'H', false, false],
  ['history', undefined, false, false],
  ['ignoreeof', undefined, false, false],
  ['interactive-comments', undefined, true, false],
  ['keyword', 'k', false, false],
  ['monitor', 'm', false, false],
  ['noclobber', 'C', false, true],
  ['noexec', 'n', false, false],
  ['noglob', 'f', false, true],
  ['nolog', undefined, false, false],
  ['notify', 'b', false, false],
  ['nounset', 'u', false, true],
  ['onecmd', 't', false, false],
  ['physical', 'P', false, false],
  ['pipefail', undefined, false, true],
  ['posix', undefined, false, false],
  ['privileged', 'p', false, false],
  ['verbose', 'v', false, false],
  ['vi', undefined, false, false],
  ['xtrace', 'x', false, false],
] as const;

/** The options of `shopt`, as Bash 5.3 lists them, with their values in a script and whether changing them works. */
const SHOPT_TABLE = [
  ['array_expand_once', false, false],
  ['assoc_expand_once', false, false],
  ['autocd', false, false],
  ['bash_source_fullpath', false, false],
  ['cdable_vars', false, false],
  ['cdspell', false, false],
  ['checkhash', false, false],
  ['checkjobs', false, false],
  ['checkwinsize', true, false],
  ['cmdhist', true, false],
  ['compat31', false, false],
  ['compat32', false, false],
  ['compat40', false, false],
  ['compat41', false, false],
  ['compat42', false, false],
  ['compat43', false, false],
  ['compat44', false, false],
  ['complete_fullquote', true, false],
  ['direxpand', false, false],
  ['dirspell', false, false],
  ['dotglob', false, true],
  ['execfail', false, false],
  ['expand_aliases', false, false],
  ['extdebug', false, false],
  ['extglob', false, true],
  ['extquote', true, false],
  ['failglob', false, true],
  ['force_fignore', true, false],
  ['globasciiranges', true, false],
  ['globskipdots', true, false],
  ['globstar', false, true],
  ['gnu_errfmt', false, false],
  ['histappend', false, false],
  ['histreedit', false, false],
  ['histverify', false, false],
  ['hostcomplete', true, false],
  ['huponexit', false, false],
  ['inherit_errexit', false, true],
  ['interactive_comments', true, false],
  ['lastpipe', false, true],
  ['lithist', false, false],
  ['localvar_inherit', false, false],
  ['localvar_unset', false, false],
  ['login_shell', false, false],
  ['mailwarn', false, false],
  ['no_empty_cmd_completion', false, false],
  ['nocaseglob', false, true],
  ['nocasematch', false, true],
  ['noexpand_translation', false, false],
  ['nullglob', false, true],
  ['patsub_replacement', true, false],
  ['progcomp', true, false],
  ['progcomp_alias', false, false],
  ['promptvars', true, false],
  ['restricted_shell', false, false],
  ['shift_verbose', false, false],
  ['sourcepath', true, false],
  ['varredir_close', false, false],
  ['xpg_echo', false, false],
] as const;

export type SetOptionName = (typeof SET_OPTION_TABLE)[number][0];
export type ShoptName = (typeof SHOPT_TABLE)[number][0];

/** The values of the shell's options, by name, which a subshell copies. */
export type ShellOptionValues = Record<SetOptionName | ShoptName, boolean>;

export const SET_OPTION_NAMES: readonly SetOptionName[] = SET_OPTION_TABLE.map(([name]) => name);
export const SHOPT_NAMES: readonly ShoptName[] = SHOPT_TABLE.map(([name]) => name);

const IMPLEMENTED = new Set<string>([
  ...SET_OPTION_TABLE.filter((entry) => entry[3]).map(([name]) => name),
  ...SHOPT_TABLE.filter((entry) => entry[2]).map(([name]) => name),
]);

/** The `set -o` name of each single-letter flag. */
export const SET_FLAG_NAMES: ReadonlyMap<string, SetOptionName> = new Map(
  SET_OPTION_TABLE.flatMap(([name, flag]) => (flag ? [[flag, name] as const] : []))
);

/** The flags in the order Bash lists them in `$-`. */
const DOLLAR_DASH_ORDER = 'abefhkmnptuvxBCEHPT';

export function isSetOptionName(name: string): name is SetOptionName {
  return (SET_OPTION_NAMES as readonly string[]).includes(name);
}

export function isShoptName(name: string): name is ShoptName {
  return (SHOPT_NAMES as readonly string[]).includes(name);
}

/** Whether this environment implements turning an option on or off. */
export function isImplementedOption(name: SetOptionName | ShoptName): boolean {
  return IMPLEMENTED.has(name);
}

export function defaultOptions(): ShellOptionValues {
  return Object.fromEntries([
    ...SET_OPTION_TABLE.map(([name, , value]) => [name, value]),
    ...SHOPT_TABLE.map(([name, value]) => [name, value]),
  ]) as ShellOptionValues;
}

/** The value of `$-`: the set flags in Bash's order. */
export function flagsOf(options: ShellOptionValues): string {
  return [...DOLLAR_DASH_ORDER]
    .filter((flag) => {
      const name = SET_FLAG_NAMES.get(flag);
      return name !== undefined && options[name];
    })
    .join('');
}
