import { typeError } from './types';
import type { Kwargs, PyValue } from './values';

/**
 * How CPython words an argument-count error for a builtin, which depends on how the builtin parses its arguments:
 * `one` and `none` for single-argument and argument-less builtins, `expected` for positional-only parsers, and `takes`
 * for parsers that also accept keywords.
 */
export type ArgStyle = 'one' | 'none' | 'expected' | 'takes';

export interface ArgSpec {
  /** The name in messages of the `one`, `none`, and no-keyword kinds, such as `len` or `list.append`. */
  qualified: string;
  /** The name in messages of the `expected` and `takes` kinds, such as `pop`. */
  short?: string;
  min: number;
  max: number;
  style: ArgStyle;
  /** The keyword arguments the builtin accepts, which it reads itself. */
  keywords?: readonly string[];
}

const plural = (count: number): string => (count === 1 ? '' : 's');

/** Checks the number of positional arguments and that only accepted keywords are passed, as CPython does. */
// code-gauge-allow functionCognitiveComplexity 18 -- Words argument-count errors as each CPython argument parser does.
export function checkArgs(spec: ArgSpec, args: readonly PyValue[], kwargs: Kwargs): void {
  const { qualified, min, max, style } = spec;
  const short = spec.short ?? qualified.split('.').at(-1) ?? qualified;
  if (kwargs && kwargs.size > 0) {
    const accepted = spec.keywords ?? [];
    if (accepted.length === 0) throw typeError(`${qualified}() takes no keyword arguments`);
    for (const key of kwargs.keys()) {
      if (!accepted.includes(key)) throw typeError(`${short}() got an unexpected keyword argument '${key}'`);
    }
  }
  const count = args.length;
  if (count >= min && count <= max) return;
  switch (style) {
    case 'one': {
      throw typeError(`${qualified}() takes exactly one argument (${count} given)`);
    }
    case 'none': {
      throw typeError(`${qualified}() takes no arguments (${count} given)`);
    }
    case 'expected': {
      if (min === max) throw typeError(`${short} expected ${min} argument${plural(min)}, got ${count}`);
      if (count < min) throw typeError(`${short} expected at least ${min} argument${plural(min)}, got ${count}`);
      throw typeError(`${short} expected at most ${max} argument${plural(max)}, got ${count}`);
    }
    default: {
      if (count > max) throw typeError(`${short}() takes at most ${max} argument${plural(max)} (${count} given)`);
      throw typeError(`${short}() takes at least ${min} positional argument${plural(min)} (${count} given)`);
    }
  }
}

/** Reads a keyword argument, or a positional one at `index`, or undefined when neither was passed. */
export function argument(args: readonly PyValue[], kwargs: Kwargs, index: number, name: string): PyValue | undefined {
  return args[index] ?? kwargs?.get(name);
}
