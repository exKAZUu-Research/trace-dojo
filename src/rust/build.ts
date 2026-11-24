import { CompileError } from '../interpreter/diagnostics';
import { ExecutionBudget, ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { NESTING_TOO_DEEP } from '../interpreter/treeSitter';
import type { Item } from './ast';
import { Checker } from './checker';
import { evaluateConstants } from './constantEvaluation';
import { Converter } from './convert';
import { normalize, setPseudoTypes, Unifier } from './infer';
import { ItemCollector, Program, resolveImports } from './items';
import { intoIterItem, intoIterShape, iterationBound } from './iterTypes';
import { boundsOf } from './methods';
import { turtleImplSource } from './natives/core';
import { parseRust, parseWith } from './parse';
import { STD_SOURCE } from './stdSource';
import { arrayTryFrom, intoConversion } from './traitConversions';
import { TraitSolver } from './traits';
import { allSupertraits, hasVars, resolve, shallow, substitute, type TraitDef, type Type } from './types';

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
  // Declaring the standard library is the same work for every program, so its time is not the program's.
  budget.excludingTime(() => declareStd(program, collector));
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

function declareStd(program: Program, collector: ItemCollector): void {
  collector.collectItems(stdDeclarations(), program.std);
  collector.finish();
  setupPrelude(program);
  const conversionSolver = new TraitSolver(program, new Unifier());
  setPseudoTypes({
    parseError: (target) => parseErrorType(program, target),
    // A type parameter's or an opaque type's item stays `IntoItem<T>` unless its bound sets it.
    intoItem: (type) => (isAbstract(type) ? iterationBound(type)?.item : intoIterItem(type)),
    intoShape: (type) => (isAbstract(type) ? undefined : intoIterShape(program, type)),
    tryFromError: (source, target) => tryFromErrorType(conversionSolver, source, target),
    projection: (type) => projectionType(conversionSolver, type),
  });
}

/**
 * The type `<Self as Trait>::Name` stands for: what a bound of `Self` sets, an iterator's item, or the type the impl
 * of the trait for `Self` gives, once `Self` is known.
 */
// code-gauge-allow functionCognitiveComplexity -- Each kind of `Self` finds its associated types differently.
function projectionType(solver: TraitSolver, type: Type & { kind: 'adt' }): Type | undefined {
  const projection = type.def.projection;
  if (!projection) return undefined;
  const { trait, name } = projection;
  const self = normalize(shallow(type.args[0]));
  const traitArgs = type.args.slice(1);
  if (self.kind === 'var') return undefined;
  const bounds = boundsOf(self);
  if (bounds) {
    for (const bound of allSupertraits(bounds, self)) {
      if (bound.trait !== trait) continue;
      const set = bound.assoc?.get(name) ?? (name === 'Item' ? bound.item : undefined);
      if (set) return set;
    }
    return undefined;
  }
  if (name === 'Item' && (trait.builtin === 'Iterator' || trait.builtin === 'IntoIterator')) {
    const item = intoIterItem(self);
    if (item) return item;
  }
  const builtin = builtinAssocType(solver.program, trait, name, self, traitArgs);
  if (builtin) return builtin;
  const { unifier } = solver;
  // A type not fully known yet (`MyBox<{integer}>`) settles the projection only when one impl can be its.
  let found: Type | undefined;
  for (const impl of solver.program.impls) {
    if (impl.trait?.trait !== trait) continue;
    const assoc = impl.assocTypes.get(name);
    if (!assoc) continue;
    const snapshot = unifier.snapshot();
    const subst = solver.matchImpl(impl, self, traitArgs);
    const result = subst && resolve(substitute(assoc, subst));
    unifier.rollback(snapshot);
    if (!result) continue;
    if (!hasVars(self)) return result;
    if (found) return undefined;
    found = result;
  }
  return found;
}

/** The associated types of the standard library's traits for the types whose impls the interpreter knows. */
function builtinAssocType(program: Program, trait: TraitDef, name: string, self: Type, args: Type[]): Type | undefined {
  const builtin = trait.builtin;
  if (!builtin) return undefined;
  if (name === 'Output' && OPERATOR_OUTPUTS.has(builtin)) {
    const primitive = (type: Type | undefined): Type | undefined => {
      const t = type && normalize(shallow(type));
      if (t?.kind === 'ref') return primitive(t.target);
      return t?.kind === 'int' || t?.kind === 'float' || t?.kind === 'bool' ? t : undefined;
    };
    const left = primitive(self);
    // std's impls for numbers take numbers (`i32 + &i32`); one with another type on the right is the program's.
    if (left && (args.length === 0 || primitive(args[0]))) return left;
    if (builtin === 'Add' && self.kind === 'adt' && self.def.builtin === 'String') return self;
    return undefined;
  }
  if (name === 'Target' && (builtin === 'Deref' || builtin === 'DerefMut')) {
    if (self.kind === 'ref') return self.target;
    if (self.kind === 'adt') {
      if (self.def.builtin === 'Box') return self.args[0];
      if (self.def.builtin === 'String') return { kind: 'str' };
      if (self.def.builtin === 'Vec') return { kind: 'slice', elem: self.args[0] };
    }
    return undefined;
  }
  if (name === 'Output' && (builtin === 'Index' || builtin === 'IndexMut')) {
    const index = args[0] && normalize(shallow(args[0]));
    const elem =
      self.kind === 'array' || self.kind === 'slice'
        ? self.elem
        : self.kind === 'adt' && (self.def.builtin === 'Vec' || self.def.builtin === 'VecDeque')
          ? self.args[0]
          : undefined;
    if (elem && index?.kind === 'int') return elem;
    if (self.kind === 'adt' && (self.def.builtin === 'HashMap' || self.def.builtin === 'BTreeMap')) return self.args[1];
    return undefined;
  }
  void program;
  return undefined;
}

const OPERATOR_OUTPUTS = new Set([
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Rem',
  'Neg',
  'Not',
  'BitAnd',
  'BitOr',
  'BitXor',
  'Shl',
  'Shr',
]);

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
  const array = arrayTryFrom(s, t);
  if (array) return array.mode === 'move' ? s : program.builtinType('TryFromSliceError');
  if (t.kind === 'char') return program.builtinType('CharTryFromError');
  if (s.kind === 'char') return program.builtinType('TryFromCharError');
  return program.builtinType('TryFromIntError');
}

function isAbstract(type: Type): boolean {
  return type.kind === 'param' || type.kind === 'opaque';
}
