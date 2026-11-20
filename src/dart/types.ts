// code-gauge-allow-file fileNcss 556 -- The operations of Dart's types belong together; each is a short case analysis.
import type { ClassInfo } from './classes';

/** A type parameter of a class, a function type, or a generic function. */
export class TypeParam {
  private static nextId = 0;
  readonly id = TypeParam.nextId++;
  /** Undefined until the declaration's bound is resolved; an omitted bound is `Object?`. */
  bound: DartType | undefined;

  constructor(readonly name: string) {}
}

export interface InterfaceType {
  kind: 'interface';
  cls: ClassInfo;
  args: readonly DartType[];
  nullable: boolean;
}

export interface NamedParameterType {
  name: string;
  type: DartType;
  isRequired: boolean;
}

export interface FunctionType {
  kind: 'function';
  typeParams: readonly TypeParam[];
  positional: readonly DartType[];
  requiredCount: number;
  /** Sorted by name, as Dart compares them. */
  named: readonly NamedParameterType[];
  /** The order a declared function lists its named parameters in, which the VM prints them in; closures sort them. */
  namedOrder?: readonly string[];
  returnType: DartType;
  nullable: boolean;
}

export interface RecordType {
  kind: 'record';
  positional: readonly DartType[];
  /** Sorted by name. */
  named: readonly { name: string; type: DartType }[];
  nullable: boolean;
}

export interface TypeParamType {
  kind: 'typeParam';
  param: TypeParam;
  nullable: boolean;
  /** The type a variable of this type was promoted to (`X & S`). */
  promoted?: DartType;
}

export type DartType =
  | InterfaceType
  | FunctionType
  | RecordType
  | TypeParamType
  | { kind: 'dynamic' }
  | { kind: 'void' }
  | { kind: 'never'; nullable: boolean }
  | { kind: 'null' };

export const DYNAMIC: DartType = { kind: 'dynamic' };
export const VOID: DartType = { kind: 'void' };
export const NEVER: DartType = { kind: 'never', nullable: false };
export const NULL: DartType = { kind: 'null' };

/** The classes of dart:core that the type rules name, set once the core library is loaded. */
export const coreTypes = {} as {
  object: ClassInfo;
  num: ClassInfo;
  int: ClassInfo;
  double: ClassInfo;
  string: ClassInfo;
  bool: ClassInfo;
  list: ClassInfo;
  map: ClassInfo;
  set: ClassInfo;
  iterable: ClassInfo;
  iterator: ClassInfo;
  function: ClassInfo;
  record: ClassInfo;
  type: ClassInfo;
  symbol: ClassInfo;
  comparable: ClassInfo;
  enum: ClassInfo;
  mapEntry: ClassInfo;
  nullClass: ClassInfo;
  stackTrace: ClassInfo;
};

export function interfaceType(cls: ClassInfo, args: readonly DartType[] = [], nullable = false): InterfaceType {
  return { kind: 'interface', cls, args, nullable };
}

export function objectType(nullable = false): InterfaceType {
  return interfaceType(coreTypes.object, [], nullable);
}

export function typeParamType(param: TypeParam, nullable = false): TypeParamType {
  return { kind: 'typeParam', param, nullable };
}

export function boundOf(param: TypeParam): DartType {
  return param.bound ?? objectType(true);
}

/** Whether a type is `dynamic`, `void`, `Object?`, or another top type. */
export function isTop(type: DartType): boolean {
  if (type.kind === 'dynamic' || type.kind === 'void') return true;
  return type.kind === 'interface' && type.cls === coreTypes.object && type.nullable;
}

export function isObject(type: DartType): boolean {
  return type.kind === 'interface' && type.cls === coreTypes.object && !type.nullable;
}

/** Whether `null` is a value of the type. */
export function isNullable(type: DartType): boolean {
  switch (type.kind) {
    case 'dynamic':
    case 'void':
    case 'null': {
      return true;
    }
    case 'never': {
      return type.nullable;
    }
    default: {
      return type.nullable;
    }
  }
}

/**
 * Whether the type may hold `null` for some instantiation: nullable, or a type parameter whose bound is (`T` with no
 * bound), which Dart calls potentially nullable.
 */
export function isPotentiallyNullable(type: DartType): boolean {
  if (isNullable(type)) return true;
  if (type.kind === 'typeParam') return type.promoted ? false : isPotentiallyNullable(boundOf(type.param));
  return false;
}

/** Whether the type excludes `null` for every instantiation. */
export function isNonNullable(type: DartType): boolean {
  if (isNullable(type)) return false;
  if (type.kind === 'typeParam')
    return type.promoted ? isNonNullable(type.promoted) : isNonNullable(boundOf(type.param));
  return true;
}

export function makeNullable(type: DartType): DartType {
  switch (type.kind) {
    case 'dynamic':
    case 'void':
    case 'null': {
      return type;
    }
    case 'never': {
      return NULL;
    }
    case 'typeParam': {
      return { kind: 'typeParam', param: type.param, nullable: true };
    }
    default: {
      return type.nullable ? type : { ...type, nullable: true };
    }
  }
}

/** `NonNull(T)`: the type without `null`. */
export function nonNullable(type: DartType): DartType {
  switch (type.kind) {
    case 'null': {
      return NEVER;
    }
    case 'never': {
      return NEVER;
    }
    case 'dynamic':
    case 'void': {
      return type;
    }
    case 'typeParam': {
      if (type.promoted) return { ...type, nullable: false, promoted: nonNullable(type.promoted) };
      if (type.nullable) return { kind: 'typeParam', param: type.param, nullable: false };
      // `T` with a nullable bound promotes to `T & B` where B is the non-nullable bound.
      if (isNullable(boundOf(type.param))) {
        return { kind: 'typeParam', param: type.param, nullable: false, promoted: nonNullable(boundOf(type.param)) };
      }
      return type;
    }
    default: {
      return type.nullable ? { ...type, nullable: false } : type;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of type, in the order of Dart's rules.
// code-gauge-allow functionNcss 32 -- Each kind compares its own structure.
export function sameType(a: DartType, b: DartType): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'interface': {
      const other = b as InterfaceType;
      return (
        a.cls === other.cls &&
        a.nullable === other.nullable &&
        a.args.length === other.args.length &&
        a.args.every((arg, index) => sameType(arg, other.args[index]))
      );
    }
    case 'typeParam': {
      const other = b as TypeParamType;
      if (a.param !== other.param || a.nullable !== other.nullable) return false;
      if (!a.promoted || !other.promoted) return a.promoted === other.promoted;
      return sameType(a.promoted, other.promoted);
    }
    case 'never': {
      return a.nullable === (b as { nullable: boolean }).nullable;
    }
    case 'record': {
      const other = b as RecordType;
      return (
        a.nullable === other.nullable &&
        a.positional.length === other.positional.length &&
        a.positional.every((type, index) => sameType(type, other.positional[index])) &&
        a.named.length === other.named.length &&
        a.named.every(
          (field, index) => field.name === other.named[index].name && sameType(field.type, other.named[index].type)
        )
      );
    }
    case 'function': {
      const other = b as FunctionType;
      if (
        a.nullable !== other.nullable ||
        a.positional.length !== other.positional.length ||
        a.requiredCount !== other.requiredCount ||
        a.named.length !== other.named.length
      ) {
        return false;
      }
      const aligned = alignTypeParams(a, other, sameType);
      if (!aligned) return false;
      const [left, right] = aligned;
      return (
        sameType(left.returnType, right.returnType) &&
        left.positional.every((type, index) => sameType(type, right.positional[index])) &&
        left.named.every(
          (named, index) =>
            named.name === right.named[index].name &&
            named.isRequired === right.named[index].isRequired &&
            sameType(named.type, right.named[index].type)
        )
      );
    }
    default: {
      return true;
    }
  }
}

function alignTypeParams(
  a: FunctionType,
  b: FunctionType,
  equalBounds: (left: DartType, right: DartType) => boolean
): [FunctionType, FunctionType] | undefined {
  if (a.typeParams.length !== b.typeParams.length) return undefined;
  if (a.typeParams.length === 0) return [a, b];
  const map = new Map<TypeParam, DartType>(
    b.typeParams.map((param, index) => [param, typeParamType(a.typeParams[index])])
  );
  if (!a.typeParams.every((param, index) => equalBounds(boundOf(param), substitute(boundOf(b.typeParams[index]), map))))
    return undefined;
  const renamed = substitute({ ...b, typeParams: [] }, map) as FunctionType;
  return [{ ...a, typeParams: [] }, renamed];
}

// code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of type, in the order of Dart's rules.
export function substitute(type: DartType, map: ReadonlyMap<TypeParam, DartType>): DartType {
  if (map.size === 0) return type;
  switch (type.kind) {
    case 'typeParam': {
      const replacement = map.get(type.param);
      if (!replacement) {
        return type.promoted ? { ...type, promoted: substitute(type.promoted, map) } : type;
      }
      return type.nullable ? makeNullable(replacement) : replacement;
    }
    case 'interface': {
      if (type.args.length === 0) return type;
      return { ...type, args: type.args.map((arg) => substitute(arg, map)) };
    }
    case 'record': {
      return {
        ...type,
        positional: type.positional.map((field) => substitute(field, map)),
        named: type.named.map((field) => ({ name: field.name, type: substitute(field.type, map) })),
      };
    }
    case 'function': {
      let { typeParams } = type;
      let inner = map;
      if (typeParams.length > 0) {
        // Fresh parameters keep the function's own type parameters apart from those being replaced.
        const fresh = typeParams.map((param) => new TypeParam(param.name));
        const extended = new Map(map);
        for (const [index, param] of typeParams.entries()) extended.set(param, typeParamType(fresh[index]));
        for (const [index, param] of typeParams.entries()) {
          fresh[index].bound = param.bound ? substitute(param.bound, extended) : undefined;
        }
        typeParams = fresh;
        inner = extended;
      }
      return {
        kind: 'function',
        typeParams,
        positional: type.positional.map((parameter) => substitute(parameter, inner)),
        requiredCount: type.requiredCount,
        named: type.named.map((parameter) => ({ ...parameter, type: substitute(parameter.type, inner) })),
        returnType: substitute(type.returnType, inner),
        nullable: type.nullable,
      };
    }
    default: {
      return type;
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 27 -- Acyclic dependencies and recursive references use different substitutions.
export function instantiateToBounds(
  params: readonly TypeParam[],
  inferred?: ReadonlyMap<TypeParam, DartType>
): DartType[] {
  if (params.every((param) => param.bound === undefined)) return params.map((param) => inferred?.get(param) ?? DYNAMIC);
  const dependencies = new Map(
    params.map((param) => {
      const bound = inferred?.has(param) ? undefined : param.bound;
      return [param, bound ? params.filter((other) => mentionsTypeParams(bound, new Set([other]))) : []];
    })
  );
  const resolved = new Map(inferred);
  const resolve = (param: TypeParam): DartType => {
    const existing = resolved.get(param);
    if (existing) return existing;
    const map = new Map<TypeParam, DartType>();
    const cyclic = new Set<TypeParam>();
    for (const dependency of dependencies.get(param) ?? []) {
      if (boundReaches(dependencies, dependency, param, new Set())) cyclic.add(dependency);
      else map.set(dependency, resolve(dependency));
    }
    let type = substitute(param.bound ?? DYNAMIC, map);
    if (cyclic.size > 0) {
      type = replaceTypeVariables(type, (variable, covariant) => {
        if (!cyclic.has(variable.param)) return variable;
        const replacement = covariant ? DYNAMIC : NEVER;
        return variable.nullable ? makeNullable(replacement) : replacement;
      });
    }
    resolved.set(param, type);
    return type;
  };
  return params.map(resolve);
}

function boundReaches(
  dependencies: ReadonlyMap<TypeParam, readonly TypeParam[]>,
  current: TypeParam,
  target: TypeParam,
  seen: Set<TypeParam>
): boolean {
  if (current === target) return true;
  if (seen.has(current)) return false;
  seen.add(current);
  return (dependencies.get(current) ?? []).some((next) => boundReaches(dependencies, next, target, seen));
}

/** Instantiates a generic function type with type arguments. */
export function instantiateFunction(type: FunctionType, args: readonly DartType[]): FunctionType {
  const map = new Map(type.typeParams.map((param, index) => [param, args[index] ?? DYNAMIC]));
  return substitute({ ...type, typeParams: [] }, map) as FunctionType;
}

/** The supertype of `type` that is an instance of `cls`, with its type arguments, if `cls` is a supertype. */
export function asInstanceOf(type: InterfaceType, cls: ClassInfo): InterfaceType | undefined {
  if (type.cls === cls) return type;
  const path = cls === coreTypes.object ? undefined : type.cls.supertypePath(cls);
  if (cls === coreTypes.object) return interfaceType(cls, [], type.nullable);
  if (!path) return undefined;
  const map = new Map(type.cls.typeParams.map((param, index) => [param, type.args[index] ?? DYNAMIC]));
  const result = substitute(path, map) as InterfaceType;
  return type.nullable ? { ...result, nullable: true } : result;
}

/** Whether `s` is a subtype of `t` (Dart's subtyping rules, in the specification's order). */
export function isSubtype(s: DartType, t: DartType): boolean {
  return topBottomSubtype(s, t) ?? typeParamSubtype(s, t) ?? structuralSubtype(s, t);
}

/** The rules for top and bottom types, Object, Null, and a nullable left side; undefined when none applies. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type, in the order of Dart's rules.
function topBottomSubtype(s: DartType, t: DartType): boolean | undefined {
  if (s === t) return true;
  if (isTop(t)) return true;
  if (s.kind === 'never' && !s.nullable) return true;
  if (isObject(t)) return isSubtypeOfObject(s, t);
  if (s.kind === 'null' || (s.kind === 'never' && s.nullable)) {
    if (t.kind === 'typeParam') return t.nullable || (t.promoted === undefined && false);
    return isNullable(t);
  }
  if (isTop(s)) return false;
  // Left nullable: both S0 and Null must be subtypes.
  if (isNullable(s) && s.kind !== 'typeParam') {
    return isNullable(t) || (t.kind === 'typeParam' && t.nullable) ? isSubtype(nonNullable(s), t) : false;
  }
  if (s.kind === 'typeParam' && s.nullable) {
    if (!isNullable(t) && !(t.kind === 'typeParam' && t.nullable)) return false;
    return isSubtype({ ...s, nullable: false, promoted: undefined }, t);
  }
  return undefined;
}

function isSubtypeOfObject(s: DartType, t: DartType): boolean {
  if (s.kind === 'typeParam') return s.promoted ? isSubtype(s.promoted, t) : isSubtype(boundOf(s.param), t);
  return !isNullable(s) && s.kind !== 'dynamic';
}

/** The rules for type parameters and a nullable right side; undefined when none applies. */
// code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of type, in the order of Dart's rules.
function typeParamSubtype(s: DartType, t: DartType): boolean | undefined {
  if (s.kind === 'typeParam' && t.kind === 'typeParam' && s.param === t.param && !t.promoted) return true;
  if (t.kind === 'typeParam' && t.nullable) {
    return isSubtype(s, { ...t, nullable: false }) || isSubtype(s, NULL);
  }
  if (isNullable(t) && t.kind !== 'typeParam') {
    return isSubtype(s, nonNullable(t));
  }
  if (s.kind === 'typeParam') {
    if (t.kind === 'typeParam' && t.promoted && s.param === t.param) {
      return isSubtype(s.promoted ?? boundOf(s.param), t.promoted);
    }
    if (s.promoted) return isSubtype(s.promoted, t) || (t.kind === 'typeParam' && t.param === s.param);
    return isSubtype(boundOf(s.param), t);
  }
  if (t.kind === 'typeParam') {
    if (t.promoted) return isSubtype(s, typeParamType(t.param)) && isSubtype(s, t.promoted);
    return false;
  }
  return undefined;
}

/** The rules for non-nullable functions, records, and interfaces. */
// code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of type, in the order of Dart's rules.
function structuralSubtype(s: DartType, t: DartType): boolean {
  if (t.kind === 'never') return false;
  if (s.kind === 'function') {
    if (t.kind === 'interface') return t.cls === coreTypes.function || t.cls === coreTypes.object;
    if (t.kind !== 'function') return false;
    return isFunctionSubtype(s, t);
  }
  if (s.kind === 'record') {
    if (t.kind === 'interface') return t.cls === coreTypes.record || t.cls === coreTypes.object;
    if (t.kind !== 'record') return false;
    return (
      s.positional.length === t.positional.length &&
      s.named.length === t.named.length &&
      s.positional.every((field, index) => isSubtype(field, t.positional[index])) &&
      s.named.every((field, index) => field.name === t.named[index].name && isSubtype(field.type, t.named[index].type))
    );
  }
  if (s.kind === 'interface' && t.kind === 'interface') {
    const instance = asInstanceOf(s, t.cls);
    if (!instance) return false;
    return instance.args.every((arg, index) => isSubtype(arg, t.args[index] ?? DYNAMIC));
  }
  return false;
}

// code-gauge-allow functionCognitiveComplexity 27 -- One case per kind of type, in the order of Dart's rules.
// code-gauge-allow functionNcss 32 -- One case per kind of type, in the order of Dart's rules.
function isFunctionSubtype(s: FunctionType, t: FunctionType): boolean {
  const aligned = alignTypeParams(s, t, mutualSubtypes);
  if (!aligned) return false;
  const [left, right] = aligned;
  if (!isSubtype(left.returnType, right.returnType)) return false;
  if (left.requiredCount > right.requiredCount) return false;
  if (left.positional.length < right.positional.length) return false;
  for (const [index, type] of right.positional.entries()) {
    if (!isSubtype(type, left.positional[index])) return false;
  }
  for (const named of left.named) {
    const other = right.named.find((parameter) => parameter.name === named.name);
    if (!other) {
      if (named.isRequired) return false;
      continue;
    }
    if (named.isRequired && !other.isRequired) return false;
    if (!isSubtype(other.type, named.type)) return false;
  }
  return right.named.every((named) => left.named.some((parameter) => parameter.name === named.name));
}

function mutualSubtypes(a: DartType, b: DartType): boolean {
  return isSubtype(a, b) && isSubtype(b, a);
}

/** The least upper bound of two types (Dart's UP), used for conditional expressions and collection literals. */
export function upperBound(a: DartType, b: DartType): DartType {
  return specialUpperBound(a, b) ?? structuralUpperBound(a, b);
}

/** The bound when either type is a top, bottom, null, nullable, Object, or type parameter type. */
// code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of type, in the order of Dart's rules.
function specialUpperBound(a: DartType, b: DartType): DartType | undefined {
  if (sameType(a, b)) return a;
  if (isTop(a) || isTop(b)) {
    if (a.kind === 'dynamic' || b.kind === 'dynamic') return DYNAMIC;
    if (a.kind === 'void' || b.kind === 'void') return VOID;
    return objectType(true);
  }
  if (a.kind === 'never' && !a.nullable) return b;
  if (b.kind === 'never' && !b.nullable) return a;
  if (a.kind === 'null' || (a.kind === 'never' && a.nullable)) return makeNullable(b);
  if (b.kind === 'null' || (b.kind === 'never' && b.nullable)) return makeNullable(a);
  if (isNullable(a) || isNullable(b)) return makeNullable(upperBound(nonNullable(a), nonNullable(b)));
  if (isObject(a) || isObject(b)) return objectType();
  if (a.kind === 'typeParam' || b.kind === 'typeParam') return typeParamUpperBound(a, b);
  return undefined;
}

function typeParamUpperBound(a: DartType, b: DartType): DartType {
  if (isSubtype(a, b)) return b;
  if (isSubtype(b, a)) return a;
  const left = a.kind === 'typeParam' ? (a.promoted ?? boundOf(a.param)) : a;
  const right = b.kind === 'typeParam' ? (b.promoted ?? boundOf(b.param)) : b;
  return upperBound(left, right);
}

function structuralUpperBound(a: DartType, b: DartType): DartType {
  if (a.kind === 'function' && b.kind === 'function') return functionUpperBound(a, b);
  if (a.kind === 'record' && b.kind === 'record') return recordUpperBound(a, b);
  const left = asInterface(a);
  const right = asInterface(b);
  if (!left || !right) return objectType();
  if (isSubtype(left, right)) return right;
  if (isSubtype(right, left)) return left;
  // Two types of the same generic class bound to that class of the bounds of their arguments: List<num> for
  // List<int> and List<double>.
  if (left.cls === right.cls && left.args.length > 0) {
    return interfaceType(
      left.cls,
      left.args.map((arg, index) => upperBound(arg, right.args[index] ?? DYNAMIC))
    );
  }
  return interfaceUpperBound(left, right);
}

function recordUpperBound(a: RecordType, b: RecordType): DartType {
  if (
    a.positional.length !== b.positional.length ||
    a.named.length !== b.named.length ||
    a.named.some((field, index) => field.name !== b.named[index].name)
  ) {
    return interfaceType(coreTypes.record);
  }
  return {
    kind: 'record',
    positional: a.positional.map((field, index) => upperBound(field, b.positional[index])),
    named: a.named.map((field, index) => ({ name: field.name, type: upperBound(field.type, b.named[index].type) })),
    nullable: false,
  };
}

/** Function types and records are interfaces of `Function` and `Record` when compared with classes. */
function asInterface(type: DartType): InterfaceType | undefined {
  if (type.kind === 'interface') return type;
  if (type.kind === 'function') return interfaceType(coreTypes.function);
  if (type.kind === 'record') return interfaceType(coreTypes.record);
  return undefined;
}

function functionUpperBound(a: FunctionType, b: FunctionType): DartType {
  if (a.typeParams.length > 0 || b.typeParams.length > 0 || a.named.length > 0 || b.named.length > 0) {
    if (sameType(a, b)) return a;
    return interfaceType(coreTypes.function);
  }
  const requiredCount = Math.max(a.requiredCount, b.requiredCount);
  const length = Math.min(a.positional.length, b.positional.length);
  if (requiredCount > length) return interfaceType(coreTypes.function);
  return {
    kind: 'function',
    typeParams: [],
    positional: Array.from({ length }, (_, index) => lowerBound(a.positional[index], b.positional[index])),
    requiredCount,
    named: [],
    returnType: upperBound(a.returnType, b.returnType),
    nullable: false,
  };
}

/** The greatest lower bound (Dart's DOWN), approximated by the smaller of two related types. */
export function lowerBound(a: DartType, b: DartType): DartType {
  if (isSubtype(a, b)) return a;
  if (isSubtype(b, a)) return b;
  if (isTop(a)) return b;
  if (isTop(b)) return a;
  if (isNullable(a) && isNullable(b)) return NULL;
  return NEVER;
}

/** The standard upper bound of two interface types: the unique deepest shared supertype. */
function interfaceUpperBound(a: InterfaceType, b: InterfaceType): DartType {
  const left = allSupertypes(a);
  const right = allSupertypes(b);
  const shared = left.filter((type) => right.some((other) => sameType(type, other)));
  const byDepth = new Map<number, InterfaceType[]>();
  for (const type of shared) {
    const depth = type.cls.depth;
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), type]);
  }
  for (const depth of [...byDepth.keys()].toSorted((x, y) => y - x)) {
    const candidates = byDepth.get(depth) as InterfaceType[];
    if (candidates.length === 1) return candidates[0];
  }
  return objectType();
}

function allSupertypes(type: InterfaceType): InterfaceType[] {
  const result: InterfaceType[] = [];
  const visit = (current: InterfaceType): void => {
    if (result.some((other) => sameType(other, current))) return;
    result.push(current);
    for (const supertype of current.cls.directSupertypes) {
      const map = new Map(current.cls.typeParams.map((param, index) => [param, current.args[index] ?? DYNAMIC]));
      visit(substitute(supertype, map) as InterfaceType);
    }
  };
  visit({ ...type, nullable: false });
  return result;
}

export function closeTypeVariables(type: DartType, params: ReadonlySet<TypeParam>): DartType {
  return replaceTypeVariables(type, (variable, covariant) =>
    params.has(variable.param) ? (covariant ? NEVER : objectType(true)) : variable
  );
}

function replaceTypeVariables(
  type: DartType,
  replace: (variable: TypeParamType, covariant: boolean) => DartType,
  covariant = true
): DartType {
  const close = (part: DartType): DartType => replaceTypeVariables(part, replace, covariant);
  switch (type.kind) {
    case 'typeParam': {
      return replace(type, covariant);
    }
    case 'interface': {
      return { ...type, args: type.args.map(close) };
    }
    case 'record': {
      return {
        ...type,
        positional: type.positional.map(close),
        named: type.named.map((field) => ({ ...field, type: close(field.type) })),
      };
    }
    case 'function': {
      const parameter = (part: DartType): DartType => replaceTypeVariables(part, replace, !covariant);
      return {
        ...type,
        returnType: close(type.returnType),
        positional: type.positional.map(parameter),
        named: type.named.map((field) => ({ ...field, type: parameter(field.type) })),
      };
    }
    default: {
      return type;
    }
  }
}

/** Whether a type mentions one of the given type parameters. */
export function mentionsTypeParams(type: DartType, params?: ReadonlySet<TypeParam>): boolean {
  switch (type.kind) {
    case 'typeParam': {
      return params ? params.has(type.param) : true;
    }
    case 'interface': {
      return type.args.some((arg) => mentionsTypeParams(arg, params));
    }
    case 'record': {
      return (
        type.positional.some((field) => mentionsTypeParams(field, params)) ||
        type.named.some((field) => mentionsTypeParams(field.type, params))
      );
    }
    case 'function': {
      return (
        mentionsTypeParams(type.returnType, params) ||
        type.positional.some((parameter) => mentionsTypeParams(parameter, params)) ||
        type.named.some((parameter) => mentionsTypeParams(parameter.type, params))
      );
    }
    default: {
      return false;
    }
  }
}

/** A type as Dart writes it in messages and `runtimeType` (`List<int>`, `int Function(String)`, `(int, {String a})`). */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of type.
export function typeToString(type: DartType): string {
  switch (type.kind) {
    case 'interface': {
      const args = type.args.length > 0 ? `<${type.args.map(typeToString).join(', ')}>` : '';
      return `${type.cls.name}${args}${type.nullable ? '?' : ''}`;
    }
    case 'typeParam': {
      const base = `${type.param.name}${type.nullable ? '?' : ''}`;
      return type.promoted ? `${base} & ${typeToString(type.promoted)}` : base;
    }
    case 'function': {
      return functionTypeToString(type);
    }
    case 'record': {
      const parts = type.positional.map(typeToString);
      if (type.named.length > 0)
        parts.push(`{${type.named.map((field) => `${typeToString(field.type)} ${field.name}`).join(', ')}}`);
      const inner = parts.length === 1 && type.named.length === 0 ? `${parts[0]},` : parts.join(', ');
      return `(${inner})${type.nullable ? '?' : ''}`;
    }
    case 'dynamic': {
      return 'dynamic';
    }
    case 'void': {
      return 'void';
    }
    case 'never': {
      return type.nullable ? 'Null' : 'Never';
    }
    case 'null': {
      return 'Null';
    }
  }
}

// code-gauge-allow duplicateLines 16 -- Dart's and the VM's notations of function types share their shape but differ in every part.
function functionTypeToString(type: FunctionType): string {
  const typeParams =
    type.typeParams.length > 0
      ? `<${type.typeParams
          .map((param) =>
            param.bound && !isTop(param.bound) ? `${param.name} extends ${typeToString(param.bound)}` : param.name
          )
          .join(', ')}>`
      : '';
  const required = type.positional.slice(0, type.requiredCount).map(typeToString);
  const optional = type.positional.slice(type.requiredCount).map(typeToString);
  const parts = [...required];
  if (optional.length > 0) parts.push(`[${optional.join(', ')}]`);
  if (type.named.length > 0) {
    parts.push(
      `{${type.named.map((named) => `${named.isRequired ? 'required ' : ''}${typeToString(named.type)} ${named.name}`).join(', ')}}`
    );
  }
  const text = `${typeToString(type.returnType)} Function${typeParams}(${parts.join(', ')})`;
  return type.nullable ? `(${text})?` : text;
}

export function functionType(
  positional: readonly DartType[],
  returnType: DartType,
  options: { requiredCount?: number; named?: NamedParameterType[]; typeParams?: TypeParam[] } = {}
): FunctionType {
  return {
    kind: 'function',
    typeParams: options.typeParams ?? [],
    positional,
    requiredCount: options.requiredCount ?? positional.length,
    named: (options.named ?? []).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    returnType,
    nullable: false,
  };
}

/** Whether the type is `int`, `double`, or `num`, without `?`. */
export function numericClassOf(type: DartType): 'int' | 'double' | 'num' | undefined {
  const base = type.kind === 'typeParam' ? (type.promoted ?? boundOf(type.param)) : type;
  if (base.kind !== 'interface' || base.nullable) return undefined;
  if (base.cls === coreTypes.int) return 'int';
  if (base.cls === coreTypes.double) return 'double';
  if (base.cls === coreTypes.num) return 'num';
  return undefined;
}

/** The type bounding a type parameter type or its promotion, used to look up members. */
export function resolveBound(type: DartType): DartType {
  if (type.kind !== 'typeParam') return type;
  const bound = type.promoted ?? boundOf(type.param);
  const resolved = resolveBound(bound);
  return type.nullable ? makeNullable(resolved) : resolved;
}

/** The element type of an `Iterable` type, if it is one. */
export function iterableElementOf(type: DartType): DartType | undefined {
  const base = resolveBound(type);
  if (base.kind === 'dynamic') return DYNAMIC;
  if (base.kind !== 'interface' || base.nullable) return undefined;
  return asInstanceOf(base, coreTypes.iterable)?.args[0];
}

export function isFunctionLike(type: DartType): boolean {
  const base = resolveBound(type);
  return base.kind === 'function' || (base.kind === 'interface' && base.cls === coreTypes.function);
}

/** A type as the VM's `Type.toString` and closures' `toString` write it: function types as `(int) => int`. */
export function vmTypeString(type: DartType): string {
  switch (type.kind) {
    case 'interface': {
      const args = type.args.length > 0 ? `<${type.args.map(vmTypeString).join(', ')}>` : '';
      return `${type.cls.vmName ?? type.cls.name}${args}${type.nullable ? '?' : ''}`;
    }
    case 'function': {
      return type.typeParams.length > 0 ? vmGenericFunctionString(type) : vmFunctionString(type);
    }
    case 'record': {
      const parts = type.positional.map(vmTypeString);
      if (type.named.length > 0)
        parts.push(`{${type.named.map((field) => `${vmTypeString(field.type)} ${field.name}`).join(', ')}}`);
      // Unlike a record value, the VM writes a type of one positional field without a trailing comma.
      const inner = parts.join(', ');
      return `(${inner})${type.nullable ? '?' : ''}`;
    }
    default: {
      return typeToString(type);
    }
  }
}

/** The VM names a generic function's type parameters Y0, Y1, and so on. */
function vmGenericFunctionString(type: FunctionType): string {
  const renamed = type.typeParams.map((_, position) => new TypeParam(`Y${position}`));
  const map = new Map(type.typeParams.map((param, position) => [param, typeParamType(renamed[position]) as DartType]));
  for (const [position, param] of type.typeParams.entries())
    renamed[position].bound = param.bound ? substitute(param.bound, map) : undefined;
  const body = substitute({ ...type, typeParams: [] }, map) as FunctionType;
  const typeParams = `<${renamed.map((param) => (param.bound && !isTop(param.bound) ? `${param.name} extends ${vmTypeString(param.bound)}` : param.name)).join(', ')}>`;
  return typeParams + vmFunctionString(body);
}

function vmFunctionString(type: FunctionType): string {
  const parts = type.positional.slice(0, type.requiredCount).map(vmTypeString);
  const optional = type.positional.slice(type.requiredCount).map(vmTypeString);
  if (optional.length > 0) parts.push(`[${optional.join(', ')}]`);
  const order = type.namedOrder;
  const named = order ? type.named.toSorted((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : type.named;
  if (named.length > 0)
    parts.push(
      `{${named.map((field) => `${field.isRequired ? 'required ' : ''}${vmTypeString(field.type)} ${field.name}`).join(', ')}}`
    );
  const text = `(${parts.join(', ')}) => ${vmTypeString(type.returnType)}`;
  return type.nullable ? `(${text})?` : text;
}
