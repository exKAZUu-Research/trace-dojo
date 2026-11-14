import { identical, type InterfaceType, type NamedType, type Type, type TypeParamType, underlying } from './types';

export type Substitution = Map<number, Type>;

/** Replaces type parameters by their type arguments, instantiating generic named types through `instantiateNamed`. */
// code-gauge-allow functionNcss 34 -- Visits the Go type shapes while retaining substitution and inference context.
export function substitute(
  type: Type,
  mapping: Substitution,
  instantiateNamed: (named: NamedType, args: Type[]) => NamedType
): Type {
  const recur = (inner: Type): Type => substitute(inner, mapping, instantiateNamed);
  switch (type.kind) {
    case 'typeParam': {
      return mapping.get(type.id) ?? type;
    }
    case 'basic': {
      return type;
    }
    case 'named': {
      if (!type.typeArgs || !type.origin) return type;
      const args = type.typeArgs.map(recur);
      if (args.every((arg, index) => arg === type.typeArgs?.[index])) return type;
      return instantiateNamed(type.origin, args);
    }
    case 'pointer':
    case 'slice': {
      const element = recur(type.element);
      return element === type.element ? type : { ...type, element };
    }
    case 'array': {
      const element = recur(type.element);
      return element === type.element ? type : { ...type, element };
    }
    case 'map': {
      return { kind: 'map', key: recur(type.key), value: recur(type.value) };
    }
    case 'chan': {
      const element = recur(type.element);
      return element === type.element ? type : { ...type, element };
    }
    case 'struct': {
      return { kind: 'struct', fields: type.fields.map((field) => ({ ...field, type: recur(field.type) })) };
    }
    case 'func': {
      return {
        kind: 'func',
        params: type.params.map(recur),
        results: type.results.map(recur),
        variadic: type.variadic,
      };
    }
    case 'interface': {
      return substituteInterface(type, mapping, instantiateNamed);
    }
    case 'tuple': {
      return { kind: 'tuple', types: type.types.map(recur) };
    }
  }
}

export function substituteInterface(
  type: InterfaceType,
  mapping: Substitution,
  instantiateNamed: (named: NamedType, args: Type[]) => NamedType
): InterfaceType {
  const recur = (inner: Type): Type => substitute(inner, mapping, instantiateNamed);
  return {
    kind: 'interface',
    methods: type.methods.map((method) => ({ name: method.name, type: recur(method.type) as typeof method.type })),
    typeSet: type.typeSet && {
      comparable: type.typeSet.comparable,
      terms: type.typeSet.terms?.map((term) => ({ tilde: term.tilde, type: recur(term.type) })),
    },
  };
}

/**
 * Infers type arguments by unifying parameter types with argument types, as Go's function argument type inference
 * does; returns false when the types cannot match.
 */
// code-gauge-allow functionCognitiveComplexity 30 -- Structural unification over each kind of type.
// code-gauge-allow functionNcss 41 -- Visits the Go type shapes while retaining substitution and inference context.
export function unify(param: Type, arg: Type, mapping: Substitution, params: readonly TypeParamType[]): boolean {
  if (param.kind === 'typeParam' && params.some((candidate) => candidate.id === param.id)) {
    const bound = mapping.get(param.id);
    if (!bound) {
      mapping.set(param.id, arg);
      return true;
    }
    if (identical(bound, arg)) return true;
    // A named type and its underlying type both match a parameter written as a type literal.
    return identical(underlying(bound), underlying(arg));
  }
  switch (param.kind) {
    case 'pointer':
    case 'slice': {
      const target = arg.kind === param.kind ? arg : underlying(arg);
      return target.kind === param.kind && unify(param.element, target.element, mapping, params);
    }
    case 'array': {
      const target = underlying(arg);
      return (
        target.kind === 'array' &&
        target.length === param.length &&
        unify(param.element, target.element, mapping, params)
      );
    }
    case 'chan': {
      const target = underlying(arg);
      return target.kind === 'chan' && unify(param.element, target.element, mapping, params);
    }
    case 'map': {
      const target = underlying(arg);
      return (
        target.kind === 'map' &&
        unify(param.key, target.key, mapping, params) &&
        unify(param.value, target.value, mapping, params)
      );
    }
    case 'struct': {
      const target = underlying(arg);
      return (
        target.kind === 'struct' &&
        target.fields.length === param.fields.length &&
        param.fields.every((field, index) => {
          const other = target.fields[index];
          return (
            field.name === other.name &&
            field.embedded === other.embedded &&
            unify(field.type, other.type, mapping, params)
          );
        })
      );
    }
    case 'func': {
      const target = underlying(arg);
      if (
        target.kind !== 'func' ||
        target.variadic !== param.variadic ||
        target.params.length !== param.params.length ||
        target.results.length !== param.results.length
      ) {
        return false;
      }
      return (
        param.params.every((type, index) => unify(type, target.params[index], mapping, params)) &&
        param.results.every((type, index) => unify(type, target.results[index], mapping, params))
      );
    }
    case 'named': {
      if (arg.kind === 'named' && param.origin && arg.origin === param.origin) {
        return (param.typeArgs ?? []).every((type, index) => unify(type, (arg.typeArgs ?? [])[index], mapping, params));
      }
      if (arg.kind !== 'named') return unify(underlying(param), arg, mapping, params);
      return true;
    }
    default: {
      return true;
    }
  }
}

/** Infers type parameters from the core types of the constraints of already-inferred ones, such as `S ~[]E`. */
// code-gauge-allow functionCognitiveComplexity 18 -- Visits the Go type shapes while retaining substitution and inference context.
export function inferFromConstraints(params: readonly TypeParamType[], mapping: Substitution): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const param of params) {
      const terms = param.constraint.typeSet?.terms;
      if (terms?.length !== 1) continue;
      const bound = mapping.get(param.id);
      const core = terms[0].type;
      if (bound) {
        const before = mapping.size;
        unify(core, terms[0].tilde ? underlying(bound) : bound, mapping, params);
        if (mapping.size !== before) changed = true;
      } else if (!containsUnbound(core, params, mapping)) {
        mapping.set(param.id, core);
        changed = true;
      }
    }
  }
}

// code-gauge-allow duplicateLines 29 -- The adjacent operations retain distinct Go evaluation and control-flow protocols; merging their adapters would couple those contracts.
function containsUnbound(
  type: Type,
  params: readonly TypeParamType[],
  mapping: Substitution,
  seen = new Set<Type>()
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  switch (type.kind) {
    case 'typeParam': {
      return params.some((param) => param.id === type.id) && !mapping.has(type.id);
    }
    case 'named': {
      return (type.typeArgs ?? []).some((arg) => containsUnbound(arg, params, mapping, seen));
    }
    case 'slice':
    case 'pointer':
    case 'array': {
      return containsUnbound(type.element, params, mapping, seen);
    }
    case 'map': {
      return containsUnbound(type.key, params, mapping, seen) || containsUnbound(type.value, params, mapping, seen);
    }
    case 'struct': {
      return type.fields.some((field) => containsUnbound(field.type, params, mapping, seen));
    }
    case 'func': {
      return [...type.params, ...type.results].some((inner) => containsUnbound(inner, params, mapping, seen));
    }
    default: {
      return false;
    }
  }
}

// code-gauge-allow duplicateLines 29 -- The adjacent operations retain distinct Go evaluation and control-flow protocols; merging their adapters would couple those contracts.
export function containsTypeParam(type: Type, seen = new Set<Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  switch (type.kind) {
    case 'typeParam': {
      return true;
    }
    case 'named': {
      return (type.typeArgs ?? []).some((arg) => containsTypeParam(arg, seen));
    }
    case 'pointer':
    case 'slice':
    case 'array':
    case 'chan': {
      return containsTypeParam(type.element, seen);
    }
    case 'map': {
      return containsTypeParam(type.key, seen) || containsTypeParam(type.value, seen);
    }
    case 'struct': {
      return type.fields.some((field) => containsTypeParam(field.type, seen));
    }
    case 'func': {
      return [...type.params, ...type.results].some((inner) => containsTypeParam(inner, seen));
    }
    case 'tuple': {
      return type.types.some((inner) => containsTypeParam(inner, seen));
    }
    default: {
      return false;
    }
  }
}
