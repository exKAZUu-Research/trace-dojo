import type { Span } from './syntax';
import type { Kind, Pred, Scheme, Type } from './types';

let nextEntityId = 0;

export function nextId(): number {
  return nextEntityId++;
}

/** A type constructor: a data type, a type synonym, or a primitive type such as `Int`. */
export interface TypeEntity {
  id: number;
  name: string;
  module: string;
  sort: 'data' | 'synonym' | 'prim';
  unsupported?: string;
  kind: Kind;
  /** The number of type parameters a data type or synonym declares. */
  arity: number;
  cons: ConInfo[];
  /** The fields of a record type by name. */
  fields: Map<string, FieldInfo>;
  /** What a synonym stands for, with its parameters as `TGen` indices. */
  synonym?: Type;
  span?: Span;
  /** How the type prints when it is special syntax: lists, tuples, unit, and functions. */
  special?: 'list' | 'tuple' | 'unit' | 'function';
}

export interface ConInfo {
  entity: ValueEntity;
  type: TypeEntity;
  name: string;
  /** The position among its type's constructors, which orders and enumerates them. */
  tag: number;
  arity: number;
  fieldNames?: string[];
  isInfix: boolean;
  /** The field types with the data type's parameters as `TGen` indices. */
  fieldTypes: Type[];
  /** The positions of the fields that constructing a value evaluates first, in order. */
  strictFields?: number[];
  isNewtype?: boolean;
  span?: Span;
}

export interface FieldInfo {
  entity: ValueEntity;
  type: TypeEntity;
  name: string;
  /** The position of the field in each constructor that has it. */
  positions: Map<ConInfo, number>;
  /** The field's type with the data type's parameters as `TGen` indices. */
  fieldType: Type;
}

/** A value-level name defined at the top of a module: a variable, a constructor, a field selector, or a method. */
export interface ValueEntity {
  id: number;
  name: string;
  module: string;
  sort: 'var' | 'con' | 'field' | 'method';
  scheme?: Scheme;
  con?: ConInfo;
  field?: FieldInfo;
  method?: { cls: ClassEntity; index: number };
  span?: Span;
  /** A name this environment provides beyond GHC's (the Turtle API), which a program's own definitions hide. */
  weak?: boolean;
  /** The fixity an operator was declared with, if any. */
  fixity?: Fixity;
  /** What to name when rejecting a use of a library value this environment does not support. */
  unsupported?: string;
}

export interface Fixity {
  assoc: 'infix' | 'infixl' | 'infixr';
  prec: number;
}

export interface ClassEntity {
  id: number;
  name: string;
  module: string;
  tyvarKind: Kind;
  supers: ClassEntity[];
  methods: ValueEntity[];
  /** The default implementation of each method, taking the class's dictionary, or undefined. */
  defaults: (ValueEntity | undefined)[];
  span?: Span;
}

/** How a class constraint is satisfied: a dictionary parameter, an instance, or a superclass of another. */
export type Evidence =
  | { kind: 'param'; param: DictParam }
  | { kind: 'instance'; instance: InstanceInfo; args: Evidence[] }
  | { kind: 'super'; of: Evidence; index: number }
  | { kind: 'hole'; hole: EvidenceHole };

/** A dictionary that a generalized binding or an instance takes as a parameter. */
export interface DictParam {
  id: number;
  pred: Pred;
}

/** A constraint the type checker has yet to satisfy, which code refers to before it is solved. */
export interface EvidenceHole {
  id: number;
  pred: Pred;
  span: Span;
  /** What gave rise to the constraint, for messages: a variable, a literal, and so on. */
  origin: string;
  solution?: Evidence;
}

export interface InstanceInfo {
  id: number;
  cls: ClassEntity;
  /** The kinds of the instance's type variables, which `head` and `context` refer to by `TGen` index. */
  kinds: Kind[];
  head: Type;
  context: Pred[];
  /** Equalities the instance imposes when chosen, as `a ~ ()` does. */
  equalities: [number, Type][];
  /** Each method's implementation, taking the context's dictionaries, or undefined to use the default. */
  methods: (ValueEntity | undefined)[];
  /** The evidence for each superclass of the class at the instance's type, in terms of the context's dictionaries. */
  supers: Evidence[];
  contextParams: DictParam[];
  module: string;
  span?: Span;
}

export function resolveEvidence(evidence: Evidence): Evidence {
  let current = evidence;
  while (current.kind === 'hole' && current.hole.solution) current = current.hole.solution;
  return current;
}
