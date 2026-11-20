import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { NESTING_TOO_DEEP } from '../interpreter/treeSitter';
import type { Item } from './ast';
import { Checker } from './checker';
import { evaluateConstants } from './constantEvaluation';
import { Converter } from './convert';
import { setPseudoTypes, Unifier } from './infer';
import { ItemCollector, Program, resolveImports } from './items';
import { intoIterItem, intoIterShape, iterationBound } from './iterTypes';
import { turtleImplSource } from './natives/core';
import { parseRust, parseWith } from './parse';
import { STD_SOURCE } from './stdSource';
import { intoConversion } from './traitConversions';
import { TraitSolver } from './traits';
import { hasVars, shallow, type Type } from './types';

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
  try {
    // A loan check can visit a loan at each CFG point, so it has a separate budget from the learner's run.
    return typeCheck(source, atomicRows, new ExecutionBudget(LIMITS.maxMilliseconds, 32 * LIMITS.maxOperations));
  } catch (error) {
    if (error instanceof ExecutionLimitError) {
      throw new CompileError([{ row: 0, message: 'このプログラムは、Rust のコンパイル処理の上限を超えました。' }]);
    }
    if (error instanceof RangeError && /maximum call stack/i.test(error.message)) {
      throw new CompileError([{ row: 0, message: NESTING_TOO_DEEP }]);
    }
    throw error;
  }
}

function typeCheck(source: string, atomicRows: ReadonlySet<number>, budget: ExecutionBudget): BuiltProgram {
  budget.spend(Math.ceil(source.length / 64));
  const program = new Program();
  const collector = new ItemCollector(program);
  collector.collectItems(budget.excludingTime(stdDeclarations), program.std);
  collector.finish();
  setupPrelude(program);
  const conversionSolver = new TraitSolver(program, new Unifier());
  setPseudoTypes({
    parseError: (target) => parseErrorType(program, target),
    // A type parameter's or an opaque type's item stays `IntoItem<T>` unless its bound sets it.
    intoItem: (type) => (isAbstract(type) ? iterationBound(type)?.item : intoIterItem(type)),
    intoShape: (type) => (isAbstract(type) ? undefined : intoIterShape(program, type)),
    tryFromError: (source, target) => tryFromErrorType(conversionSolver, source, target),
  });
  const crate = parseRust(source, budget);
  collector.collectCrate(crate, program.root);
  collector.finish();
  resolveImports(program.root);
  const checker = new Checker(program, atomicRows, budget);
  checker.checkProgram();
  evaluateConstants(checker, budget);
  budget.spend(0);
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

/** The error of `TryFrom<source>` for `target`: none for a conversion that `From` also makes, else by the types. */
function tryFromErrorType(solver: TraitSolver, source: Type, target: Type): Type | undefined {
  const s = shallow(source);
  const t = shallow(target);
  if (hasVars(s) || hasVars(t)) return undefined;
  const { program } = solver;
  if (intoConversion(solver, s, t) === 'yes') return program.builtinType('Infallible');
  if (isAbstract(s) || isAbstract(t)) return undefined;
  if (t.kind === 'char') return program.builtinType('CharTryFromError');
  if (s.kind === 'char') return program.builtinType('TryFromCharError');
  return program.builtinType('TryFromIntError');
}

function isAbstract(type: Type): boolean {
  return type.kind === 'param' || type.kind === 'opaque';
}
