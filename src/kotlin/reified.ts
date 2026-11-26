import type { Core } from './compilerBase';
import type { Frame, FunctionInfo } from './runtime';
import type { TypeParameterSymbol } from './symbols';
import { instanceTest } from './typeChecks';
import { type KType, mentionsVariable, resolved, substitute } from './types';
import type { Value } from './values';

/**
 * Where a call passes the type arguments of an inline function's reified type parameters: a hidden local after its
 * parameters, which holds them in the order of those parameters.
 */
export interface ReifiedAccess {
  info: FunctionInfo;
  slot: number;
  index: number;
}

/**
 * Where each compiled version of an inline function, as its ordinary and its suspend version, receives a reified type
 * parameter's argument: the versions share the parameter, and a run reads the one whose frame it runs in.
 */
const accesses = new WeakMap<TypeParameterSymbol, ReifiedAccess[]>();

export function setReifiedAccess(param: TypeParameterSymbol, access: ReifiedAccess): void {
  const known = accesses.get(param);
  if (known) known.push(access);
  else accesses.set(param, [access]);
}

/** Whether a type mentions a reified type parameter, whose type argument only a run knows. */
export function mentionsReified(type: KType): boolean {
  const actual = resolved(type);
  switch (actual.kind) {
    case 'param': {
      return accesses.has(actual.param);
    }
    case 'class': {
      return actual.args.some((argument) => argument.variance !== 'star' && mentionsReified(argument.type));
    }
    case 'function': {
      return [...(actual.receiver ? [actual.receiver] : []), ...actual.params, actual.returnType].some(mentionsReified);
    }
    default: {
      return mentionsVariable(actual, () => false);
    }
  }
}

/** A type with the reified type parameters it mentions replaced by the type arguments the run passed them. */
export function runtimeType(type: KType, frame: Frame): KType {
  const substitution = new Map<TypeParameterSymbol, KType>();
  collect(resolved(type), frame, substitution);
  return substitution.size === 0 ? type : substitute(type, substitution);
}

function collect(type: KType, frame: Frame, substitution: Map<TypeParameterSymbol, KType>): void {
  switch (type.kind) {
    case 'param': {
      if (substitution.has(type.param)) return;
      for (const access of accesses.get(type.param) ?? []) {
        const owner = ownerFrame(frame, access.info);
        if (!owner) continue;
        const passed = owner.locals[access.slot] as unknown as KType[] | undefined;
        const argument = passed?.[access.index];
        if (argument) substitution.set(type.param, argument);
        return;
      }
      return;
    }
    case 'class': {
      for (const argument of type.args) if (argument.variance !== 'star') collect(argument.type, frame, substitution);
      return;
    }
    default: {
      return;
    }
  }
}

/** The frame of the inline function that a frame runs in, itself or the function around the lambda it runs. */
function ownerFrame(frame: Frame, info: FunctionInfo): Frame | undefined {
  for (let current: Frame | undefined = frame; current; current = current.enclosing) {
    if (current.info === info) return current;
  }
  return undefined;
}

/** A test of whether a value is of a type, which for a reified type parameter checks the type the run passed it. */
export function framedInstanceTest(core: Core, type: KType): (frame: Frame, value: Value) => boolean {
  if (!mentionsReified(type)) {
    const test = instanceTest(core, type);
    return (_frame, value) => test(value);
  }
  return (frame, value) => instanceTest(core, runtimeType(type, frame))(value);
}
