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
  /** A `family` is a type family, which its equations reduce. */
  sort: 'data' | 'synonym' | 'prim' | 'family';
  /** The class an associated family is declared in, of the same module, which imports it as a child. */
  associatedClass?: string;
  /** A type family's equations, in order, with their own variables as `TGen` indices. */
  equations?: { kinds: Kind[]; lhs: Type[]; rhs: Type }[];
  /** Whether a type family is closed: its equations apply in order, each only once earlier ones cannot apply. */
  closed?: boolean;
  /** Whether the type is a data family, whose instances declare its constructors. */
  dataFamily?: boolean;
  /** For a built-in type family, such as GHC.TypeLits' `+`, how it reduces its arguments, if it can yet. */
  reduceBuiltin?: (args: Type[]) => Type | undefined;
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
  /** The fixity a type operator was declared with, if any. */
  fixity?: Fixity;
  /** For a type-level literal, the string or number it is. */
  literal?: string | bigint;
  /** Whether a standalone kind signature specifies the type's kind variables with `forall`, which `T @k` sets. */
  kindSpecified?: boolean;
  /**
   * The roles of a data type's parameters, as far as they are known: what `Coercible` needs of two applications of
   * the type to convert one to the other, argument by argument.
   */
  roles?: Role[];
  /** For a class used as a type, as ConstraintKinds allows, the class. */
  classOf?: ClassEntity;
  /** For a data constructor used as a type, as DataKinds promotes it, the constructor. */
  promotedFrom?: ConInfo;
  /** How the type prints when it is special syntax: lists, tuples, unit, functions, and a class's arguments. */
  special?: 'list' | 'tuple' | 'unit' | 'function' | 'classArguments' | 'unboxedTuple' | 'unboxedSum';
  traceKind?: 'bool' | 'ratio' | 'maybe' | 'map' | 'set';
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
  /**
   * The field types with the data type's parameters as `TGen` indices, followed by the constructor's existential
   * variables.
   */
  fieldTypes: Type[];
  /** The kinds of the existential variables, which follow the data type's parameters. */
  exKinds?: Kind[];
  /** For a GADT constructor, its variables' indices in the order its signature gives them to type applications. */
  specified?: number[];
  /**
   * The constraints DatatypeContexts puts on the constructor: using it, to build or to match, needs them, but its
   * values hold no dictionaries for them.
   */
  datatypeContext?: Pred[];
  /** The constraints whose dictionaries a value of the constructor holds, after its fields. */
  context?: Pred[];
  /** What a GADT constructor fixes the data type's parameters to, by position, as `IntLit :: Int -> Expr Int` does. */
  equalities?: [number, Type][];
  /**
   * For a constructor of a data instance, the types the instance gives the family, in terms of the instance's own
   * variables as `TGen` indices, whose kinds `instanceKinds` gives; its field types refer to the same variables.
   */
  instanceArgs?: Type[];
  instanceKinds?: Kind[];
  /** The positions of the fields that constructing a value evaluates first, in order. */
  strictFields?: number[];
  isNewtype?: boolean;
  isLibraryPrivate?: true;
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
  unsupportedField?: boolean;
}

export interface Fixity {
  assoc: 'infix' | 'infixl' | 'infixr';
  prec: number;
}

export interface ClassEntity {
  id: number;
  name: string;
  module: string;
  /**
   * The kind of the type a constraint of the class applies it to. A class of other than one parameter applies to
   * the type `packed` makes of its arguments, whose kind is `Type`.
   */
  tyvarKind: Kind;
  /** For a class of other than one parameter, the type constructor that packs its arguments into one type. */
  packed?: TypeEntity;
  /**
   * The type each superclass applies to, in terms of the class's parameters as `TGen` indices; a superclass without
   * one applies to the class's own parameter.
   */
  superTypes?: Type[];
  /** The functional dependencies, by parameter position. */
  fundeps?: { from: number[]; to: number[] }[];
  /** The fixity a class operator was declared with, if any. */
  fixity?: Fixity;
  supers: ClassEntity[];
  methods: ValueEntity[];
  exportedMethods?: ValueEntity[];
  /** The default implementation of each method, taking the class's dictionary, or undefined. */
  defaults: (ValueEntity | undefined)[];
  /**
   * The default implementations that a `default` signature types, by method index: functions of their own scheme,
   * which an instance that leaves the method out defines it as.
   */
  genericDefaults?: Map<number, ValueEntity>;
  span?: Span;
}

/** How a class constraint is satisfied: a dictionary parameter, an instance, or a superclass of another. */
export type Evidence =
  | { kind: 'param'; param: DictParam }
  /** The evidence of a type equality, `a ~ b`, or of the empty constraint, `()`, which holds no value at run time. */
  | { kind: 'equality' }
  /** The evidence of `HasField "f" r a`: the selector of the field. */
  | { kind: 'field'; field: FieldInfo }
  /**
   * The evidence of `Coercible a b`: how to convert a value of one type to the other and back, with the evidence of
   * the given `Coercible` constraints it uses as `leaves`.
   */
  | { kind: 'coercion'; spec: CoercionSpec; leaves: Evidence[] }
  /** The evidence of `KnownNat n` or `KnownSymbol s`: the literal's value. */
  | { kind: 'literal'; value: string | bigint }
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
  /** How the instance may overlap others, as `{-# OVERLAPPING #-}` and the like say. */
  overlap?: 'OVERLAPPING' | 'OVERLAPPABLE' | 'OVERLAPS' | 'INCOHERENT';
  module: string;
  span?: Span;
}

export function resolveEvidence(evidence: Evidence): Evidence {
  let current = evidence;
  while (current.kind === 'hole' && current.hole.solution) current = current.hole.solution;
  return current;
}

/** A parameter's role: whether `Coercible` may convert it (representational), ignores it (phantom), or not (nominal). */
export type Role = 'nominal' | 'representational' | 'phantom';

/**
 * How `Coercible a b` converts a value of type `a` to type `b`, which run time follows forward, and back from `b` to
 * `a`, which reverses each step.
 */
export type CoercionSpec =
  /** The types are the same. */
  | { k: 'refl' }
  /** A given constraint's conversion, reversed when `flipped`. */
  | { k: 'leaf'; index: number; flipped: boolean }
  /** `a` is the newtype of the constructor, whose field converts to `b`. */
  | { k: 'unwrap'; con: ConInfo; inner: CoercionSpec }
  /** `b` is the newtype of the constructor, whose field `a` converts to. */
  | { k: 'wrap'; con: ConInfo; inner: CoercionSpec }
  /** Both are functions, of arguments and results that convert. */
  | { k: 'fun'; arg: CoercionSpec; res: CoercionSpec }
  /** Both are `IO` actions, of results that convert. */
  | { k: 'io'; res: CoercionSpec }
  /** Both apply the same data type, to arguments that convert by position; its fields convert by their types. */
  | { k: 'data'; params: CoercionSpec[] };
