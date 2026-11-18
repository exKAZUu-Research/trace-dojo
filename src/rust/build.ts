import type { Item } from './ast';
import { Checker } from './checker';
import { setSourceForMessages } from './compiler';
import { Converter } from './convert';
import { setPseudoTypes } from './infer';
import { ItemCollector, Program, resolveImports } from './items';
import { turtleImplSource } from './natives/core';
import { parseRust, parseWith } from './parse';
import { STD_SOURCE } from './stdSource';
import { shallow, type Type } from './types';

let stdItems: Item[] | undefined;

/** The standard library's declarations, parsed once per process. */
function stdDeclarations(): Item[] {
  stdItems ??= parseWith(
    `${STD_SOURCE}\npub mod dojo_impl { use super::dojo::Turtle; ${turtleImplSource()} }\n`,
    (root, reparse, source) => new Converter(source, reparse, true).convertCrate(root)
  ).items;
  return stdItems;
}

export interface BuiltProgram {
  program: Program;
  checker: Checker;
}

/** Parses, resolves, and type-checks a program with the standard library, throwing a `CompileError` for errors. */
export function buildProgram(source: string, atomicRows: ReadonlySet<number> = new Set()): BuiltProgram {
  const program = new Program();
  const collector = new ItemCollector(program);
  collector.collectItems(stdDeclarations(), program.std);
  collector.finish();
  setupPrelude(program);
  setPseudoTypes({
    parseError: (target) => parseErrorType(program, target),
  });
  const crate = parseRust(source);
  setSourceForMessages(source);
  collector.collectCrate(crate, program.root);
  collector.finish();
  resolveImports(program.root);
  const checker = new Checker(program, atomicRows);
  checker.checkProgram();
  return { program, checker };
}

function setupPrelude(program: Program): void {
  const prelude = program.std.types.get('prelude');
  if (prelude?.binding.kind !== 'mod') throw new Error('The standard library has no prelude');
  for (const name of prelude.binding.module.imports.keys()) program.prelude.set(name, ['std', 'prelude', name]);
}

function parseErrorType(program: Program, target: Type): Type | undefined {
  const t = shallow(target);
  switch (t.kind) {
    case 'int': {
      return program.builtinType('ParseIntError');
    }
    case 'float': {
      return program.builtinType('ParseFloatError');
    }
    case 'bool': {
      return program.builtinType('ParseBoolError');
    }
    case 'char': {
      return program.builtinType('ParseCharError');
    }
    case 'adt': {
      return t.def.builtin === 'String' ? program.builtinType('Infallible') : undefined;
    }
    default: {
      return undefined;
    }
  }
}
