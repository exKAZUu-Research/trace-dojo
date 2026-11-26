import type { Shell } from './shell';

export interface ParsedOptions {
  /** Each option letter given, with its argument when it takes one; a repeated option keeps its last argument. */
  readonly options: Map<string, string>;
  readonly operands: string[];
}

/**
 * Parses a builtin's options as Bash's `internal_getopt` does: letters may be grouped (`-rn3`), a letter followed by
 * `:` in `spec` takes an argument from the rest of its word or the next word, and `--` or the first word that is not
 * an option ends them. Reports an invalid or incomplete option with the builtin's usage and returns status 2.
 */
export function parseBuiltinOptions(
  shell: Shell,
  builtin: string,
  args: readonly string[],
  spec: string,
  usage: string
): ParsedOptions | number {
  const options = new Map<string, string>();
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      index++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    for (let i = 1; i < arg.length; i++) {
      const letter = arg[i];
      const at = spec.indexOf(letter);
      if (at === -1 || letter === ':') {
        shell.reportError(`${builtin}: -${letter}: invalid option`);
        shell.fd2.write(`${builtin}: usage: ${usage}\n`);
        return 2;
      }
      if (spec[at + 1] !== ':') {
        options.set(letter, '');
        continue;
      }
      const value = i + 1 < arg.length ? arg.slice(i + 1) : args[++index];
      if (value === undefined) {
        shell.reportError(`${builtin}: -${letter}: option requires an argument`);
        shell.fd2.write(`${builtin}: usage: ${usage}\n`);
        return 2;
      }
      options.set(letter, value);
      break;
    }
  }
  return { options, operands: args.slice(index) };
}
