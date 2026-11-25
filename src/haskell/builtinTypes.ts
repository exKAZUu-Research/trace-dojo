import { type ClassEntity, type ConInfo, nextId, type TypeEntity, type ValueEntity } from './entities';
import { compileError } from './errors';
import { rememberKind } from './kindTemplates';
import { freshKindVar, type Kind, kindArrow, setMultiplicityArrows, simpleKind, STAR, type Type } from './types';
import { chargeTypeWork } from './typeWorkBudget';

/** The module that owns the primitive types and the special syntax types (lists, tuples, unit, functions). */
export const BUILTIN_MODULE = 'GHC.Types';

function primType(name: string, arity: number, special?: TypeEntity['special']): TypeEntity {
  return {
    id: nextId(),
    name,
    module: BUILTIN_MODULE,
    sort: 'prim',
    kind: simpleKind(arity),
    arity,
    cons: [],
    fields: new Map(),
    special,
  };
}

function addConstructor(type: TypeEntity, name: string, fieldTypes: Type[], isInfix = false): ConInfo {
  const entity: ValueEntity = { id: nextId(), name, module: BUILTIN_MODULE, sort: 'con' };
  const con: ConInfo = { entity, type, name, tag: type.cons.length, arity: fieldTypes.length, isInfix, fieldTypes };
  entity.con = con;
  type.cons.push(con);
  return con;
}

const gen = (index: number): Type => ({ tag: 'tgen', index });

export const INT_TYPE = primType('Int', 0);
export const INTEGER_TYPE = primType('Integer', 0);
export const WORD_TYPE = primType('Word', 0);
export const DOUBLE_TYPE = primType('Double', 0);
export const FLOAT_TYPE = primType('Float', 0);
export const CHAR_TYPE = primType('Char', 0);
export const IO_TYPE = primType('IO', 1);
export const TURTLE_TYPE = primType('Turtle', 0);
export const FUNCTION_TYPE = primType('->', 2, 'function');

/** The kind of multiplicities, which LinearTypes' arrows take: `One` and `Many`. */
export const MULTIPLICITY_TYPE = primType('Multiplicity', 0);
export const MULTIPLICITY_KIND: Kind = { tag: 'data', entity: MULTIPLICITY_TYPE, args: [] };
export const ONE_TYPE: TypeEntity = { ...primType('One', 0), kind: MULTIPLICITY_KIND };
export const MANY_TYPE: TypeEntity = { ...primType('Many', 0), kind: MULTIPLICITY_KIND };

/**
 * The arrow of a multiplicity other than `Many`, `FUN m a b`, which `a %1 -> b` and `a %m -> b` write; an arrow of
 * `Many` is the ordinary function type.
 */
export const MULTIPLICITY_FUNCTION_TYPE: TypeEntity = {
  ...primType('FUN', 3),
  kind: kindArrow(MULTIPLICITY_KIND, simpleKind(2)),
};
setMultiplicityArrows(MULTIPLICITY_FUNCTION_TYPE, FUNCTION_TYPE, MANY_TYPE);

export const LIST_TYPE: TypeEntity = { ...primType('[]', 1, 'list'), sort: 'data' };
export const NIL_CON = addConstructor(LIST_TYPE, '[]', []);
export const CONS_CON = addConstructor(
  LIST_TYPE,
  ':',
  [gen(0), { tag: 'tap', fn: { tag: 'tcon', entity: LIST_TYPE }, arg: gen(0) }],
  true
);
CONS_CON.entity.fixity = { assoc: 'infixr', prec: 5 };

export const UNIT_TYPE: TypeEntity = { ...primType('()', 0, 'unit'), sort: 'data' };
export const UNIT_CON = addConstructor(UNIT_TYPE, '()', []);

/** The types an equality constraint `a ~ b` compares, packed as a constraint of the class `~` applies to. */
export const EQUALITY_TYPES: TypeEntity = { ...primType('~', 2), special: 'classArguments' };

/** The class of type equality constraints, `a ~ b`, which the type checker solves by unification. */
export const EQUALITY_CLASS: ClassEntity = {
  id: nextId(),
  name: '~',
  module: BUILTIN_MODULE,
  tyvarKind: STAR,
  packed: EQUALITY_TYPES,
  supers: [],
  methods: [],
  defaults: [],
  fixity: { assoc: 'infix', prec: 4 },
};

{
  // Both sides of an equality have one kind, whichever it is.
  const kind = freshKindVar();
  EQUALITY_TYPES.kind = kindArrow(kind, kindArrow(kind, STAR));
  rememberKind(EQUALITY_TYPES, EQUALITY_TYPES.kind);
}

/** The kind of type-level strings, which field names, labels, and DataKinds' string literals have. */
export const SYMBOL_TYPE: TypeEntity = primType('Symbol', 0);
/** The kind of type-level natural numbers, which DataKinds' number literals have. */
export const NATURAL_TYPE: TypeEntity = primType('Natural', 0);

const symbols = new Map<string, TypeEntity>();
const naturals = new Map<bigint, TypeEntity>();

/** The type a type-level string literal, `"name"`, stands for: one type per string, of kind `Symbol`. */
export function symbolType(text: string): TypeEntity {
  let entity = symbols.get(text);
  if (!entity) {
    entity = {
      ...primType(JSON.stringify(text), 0),
      kind: { tag: 'data', entity: SYMBOL_TYPE, args: [] },
      literal: text,
    };
    symbols.set(text, entity);
  }
  return entity;
}

/** The type a type-level number literal, `3`, stands for: one type per number, of kind `Natural`. */
export function naturalType(value: bigint): TypeEntity {
  let entity = naturals.get(value);
  if (!entity) {
    entity = { ...primType(String(value), 0), kind: { tag: 'data', entity: NATURAL_TYPE, args: [] }, literal: value };
    naturals.set(value, entity);
  }
  return entity;
}

const promoted = new Map<ConInfo, TypeEntity>();

/**
 * The type a data constructor stands for in a type, as DataKinds promotes it: `'True` of kind `Bool`. Its kind
 * follows from the constructor's type once that is known.
 */
export function promotedType(con: ConInfo): TypeEntity {
  let entity = promoted.get(con);
  if (!entity) {
    entity = { ...primType(con.type.special ? con.name : `'${con.name}`, con.arity), promotedFrom: con };
    promoted.set(con, entity);
  }
  return entity;
}

/** The types `getField` and record dot syntax use: a field's name, a record type, and the field's type. */
export const HAS_FIELD_TYPES: TypeEntity = { ...primType('HasField', 3), special: 'classArguments' };

/** The class of records with a field of a name, `HasField "name" r a`, which the type checker solves itself. */
export const HAS_FIELD_CLASS: ClassEntity = {
  id: nextId(),
  name: 'HasField',
  module: 'GHC.Records',
  tyvarKind: STAR,
  packed: HAS_FIELD_TYPES,
  supers: [],
  methods: [],
  defaults: [],
  fundeps: [{ from: [0, 1], to: [2] }],
};
HAS_FIELD_TYPES.kind = kindArrow(
  { tag: 'data', entity: SYMBOL_TYPE, args: [] },
  kindArrow(STAR, kindArrow(STAR, STAR))
);

/** The types `Coercible a b` packs: two types of the same representation. */
export const COERCIBLE_TYPES: TypeEntity = { ...primType('Coercible', 2), special: 'classArguments' };
COERCIBLE_TYPES.kind = kindArrow(STAR, kindArrow(STAR, STAR));

/** The class of types of the same representation, which `coerce` converts between and the type checker solves. */
export const COERCIBLE_CLASS: ClassEntity = {
  id: nextId(),
  name: 'Coercible',
  module: 'Data.Coerce',
  tyvarKind: STAR,
  packed: COERCIBLE_TYPES,
  supers: [],
  methods: [],
  defaults: [],
};

/** The types an implicit parameter's constraint `?x :: t` packs: its name and its type. */
export const IMPLICIT_TYPES: TypeEntity = { ...primType('?', 2), special: 'classArguments' };

/** The class of implicit parameters, whose evidence is the parameter's value, which `let ?x = e` gives. */
export const IMPLICIT_CLASS: ClassEntity = {
  id: nextId(),
  name: '?',
  module: BUILTIN_MODULE,
  tyvarKind: STAR,
  packed: IMPLICIT_TYPES,
  supers: [],
  methods: [],
  defaults: [],
  fundeps: [{ from: [0], to: [1] }],
};
IMPLICIT_TYPES.kind = kindArrow({ tag: 'data', entity: SYMBOL_TYPE, args: [] }, kindArrow(STAR, STAR));

/** The kind of types, `Type` (or `*`), which Data.Kind exports and kind signatures name. */
export const TYPE_KIND: TypeEntity = primType('Type', 0);
/** The kind of constraints, `Constraint`, which Data.Kind exports. */
export const CONSTRAINT_KIND: TypeEntity = primType('Constraint', 0);

export const MAX_TUPLE_SIZE = 64;
const tupleTypes = new Map<number, TypeEntity>();

export function tupleType(size: number): TypeEntity {
  if (size > MAX_TUPLE_SIZE) throw compileError(0, `タプルの要素は ${MAX_TUPLE_SIZE} 個までです。`);
  let type = tupleTypes.get(size);
  if (!type) {
    const name = `(${','.repeat(size - 1)})`;
    type = { ...primType(name, size, 'tuple'), sort: 'data' };
    addConstructor(
      type,
      name,
      Array.from({ length: size }, (_, index) => gen(index))
    );
    tupleTypes.set(size, type);
  }
  return type;
}

export function tupleCon(size: number): ConInfo {
  return tupleType(size).cons[0];
}

/** A mutable reference, which Data.IORef's functions read and write. */
export const IOREF_TYPE: TypeEntity = primType('IORef', 1);

export const PRIMITIVE_TYPES = [
  INT_TYPE,
  INTEGER_TYPE,
  DOUBLE_TYPE,
  FLOAT_TYPE,
  CHAR_TYPE,
  IO_TYPE,
  TURTLE_TYPE,
  WORD_TYPE,
  IOREF_TYPE,
  NATURAL_TYPE,
  SYMBOL_TYPE,
];

const NATURAL_KIND: Kind = { tag: 'data', entity: NATURAL_TYPE, args: [] };
const SYMBOL_KIND: Kind = { tag: 'data', entity: SYMBOL_TYPE, args: [] };

/** The library's `Ordering` and `Bool` constructors, which the comparison families promote. */
let comparisonCons: { ordering: ConInfo[]; bool: ConInfo[] } | undefined;

export function setComparisonConstructors(ordering: ConInfo[], bool: ConInfo[]): void {
  comparisonCons = { ordering, bool };
}

/** A type family GHC.TypeLits defines by computation on the literals it is applied to. */
function builtinFamily(
  name: string,
  params: Kind[],
  result: Kind | (() => Kind),
  reduce: (values: (bigint | string)[]) => Type | undefined
): TypeEntity {
  const entity: TypeEntity = {
    ...primType(name, params.length),
    sort: 'family',
    reduceBuiltin: (args) => {
      const values = args.map((arg) => {
        let node = arg;
        while (node.tag === 'tvar' && node.ref) node = node.ref;
        return node.tag === 'tcon' ? node.entity.literal : undefined;
      });
      return values.every((value) => value !== undefined) ? reduce(values as (bigint | string)[]) : undefined;
    },
  };
  let kind = typeof result === 'function' ? STAR : result;
  for (const param of params.toReversed()) kind = kindArrow(param, kind);
  entity.kind = kind;
  if (typeof result === 'function') {
    Object.defineProperty(entity, 'kind', {
      get: () => {
        let lazy = result();
        for (const param of params.toReversed()) lazy = kindArrow(param, lazy);
        return lazy;
      },
      set: () => {},
    });
  }
  return entity;
}

function natural(value: bigint): Type | undefined {
  return value < 0n ? undefined : { tag: 'tcon', entity: naturalType(value) };
}

function compared(order: number): Type {
  const cons = (comparisonCons as { ordering: ConInfo[] }).ordering;
  return { tag: 'tcon', entity: promotedType(cons[order < 0 ? 0 : order === 0 ? 1 : 2]) };
}

function orderingKind(): Kind {
  return { tag: 'data', entity: (comparisonCons as { ordering: ConInfo[] }).ordering[0].type, args: [] };
}

function boolKind(): Kind {
  return { tag: 'data', entity: (comparisonCons as { bool: ConInfo[] }).bool[0].type, args: [] };
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/** The bits a unit of the compilation budget pays for, when a type-level number operation produces a result. */
const BITS_PER_UNIT = 8;

/** Charges the compilation budget for a type-level result of `bits` bits, before computing it. */
function chargeNaturalBits(bits: number): void {
  chargeTypeWork(Math.ceil(bits / BITS_PER_UNIT));
}

const naturalOperands = [NATURAL_KIND, NATURAL_KIND];

/** GHC.TypeLits' type families, by name. */
export const TYPE_LIT_FAMILIES: Record<string, TypeEntity> = {
  '+': builtinFamily('+', naturalOperands, NATURAL_KIND, ([a, b]) => {
    chargeNaturalBits(Math.max(bitLength(a as bigint), bitLength(b as bigint)) + 1);
    return natural((a as bigint) + (b as bigint));
  }),
  '*': builtinFamily('*', naturalOperands, NATURAL_KIND, ([a, b]) => {
    chargeNaturalBits(bitLength(a as bigint) + bitLength(b as bigint));
    return natural((a as bigint) * (b as bigint));
  }),
  '-': builtinFamily('-', naturalOperands, NATURAL_KIND, ([a, b]) => {
    chargeNaturalBits(bitLength(a as bigint));
    return natural((a as bigint) - (b as bigint));
  }),
  '^': builtinFamily('^', naturalOperands, NATURAL_KIND, ([a, b]) => {
    const [base, exponent] = [a as bigint, b as bigint];
    if (base > 1n) chargeNaturalBits(Number(BigInt(bitLength(base) - 1) * exponent));
    return natural(base ** exponent);
  }),
  Div: builtinFamily('Div', naturalOperands, NATURAL_KIND, ([a, b]) => {
    chargeNaturalBits(bitLength(a as bigint) + bitLength(b as bigint));
    return b === 0n ? undefined : natural((a as bigint) / (b as bigint));
  }),
  Mod: builtinFamily('Mod', naturalOperands, NATURAL_KIND, ([a, b]) => {
    chargeNaturalBits(bitLength(a as bigint) + bitLength(b as bigint));
    return b === 0n ? undefined : natural((a as bigint) % (b as bigint));
  }),
  Log2: builtinFamily('Log2', [NATURAL_KIND], NATURAL_KIND, ([a]) =>
    (a as bigint) <= 0n ? undefined : natural(BigInt((a as bigint).toString(2).length - 1))
  ),
  CmpNat: builtinFamily('CmpNat', naturalOperands, orderingKind, ([a, b]) => compared(a < b ? -1 : a === b ? 0 : 1)),
  CmpSymbol: builtinFamily('CmpSymbol', [SYMBOL_KIND, SYMBOL_KIND], orderingKind, ([a, b]) =>
    compared(a < b ? -1 : a === b ? 0 : 1)
  ),
  AppendSymbol: builtinFamily('AppendSymbol', [SYMBOL_KIND, SYMBOL_KIND], SYMBOL_KIND, ([a, b]) => {
    // One unit per character, as the C preprocessor charges for the text it produces.
    chargeTypeWork((a as string).length + (b as string).length);
    return { tag: 'tcon', entity: symbolType(`${a as string}${b as string}`) };
  }),
  '<=?': builtinFamily('<=?', naturalOperands, boolKind, ([a, b]) => {
    const cons = (comparisonCons as { bool: ConInfo[] }).bool;
    return { tag: 'tcon', entity: promotedType(cons[(a as bigint) <= (b as bigint) ? 1 : 0]) };
  }),
};
for (const [name, entity] of Object.entries(TYPE_LIT_FAMILIES)) {
  if (['+', '-'].includes(name)) entity.fixity = { assoc: 'infixl', prec: 6 };
  else if (name === '*') entity.fixity = { assoc: 'infixl', prec: 7 };
  else if (name === '^') entity.fixity = { assoc: 'infixr', prec: 8 };
  else if (name === '<=?') entity.fixity = { assoc: 'infix', prec: 4 };
}

/**
 * The class of constraints written as types, `c a` for a variable `c :: Type -> Constraint`, as ConstraintKinds
 * allows; once `c` is known to be a class, the constraint is that class's, whose dictionary is its evidence.
 */
export const CONSTRAINT_TYPE_CLASS: ClassEntity = {
  id: nextId(),
  name: 'Constraint',
  module: BUILTIN_MODULE,
  tyvarKind: { tag: 'constraint' },
  supers: [],
  methods: [],
  defaults: [],
};

const classTypes = new Map<ClassEntity, TypeEntity>();

/** A class used as a type, `Show` in `Proxy Show`, of kind `Type -> Constraint` for a class of one parameter. */
export function classType(cls: ClassEntity, kind: Kind): TypeEntity {
  let entity = classTypes.get(cls);
  if (!entity) {
    entity = { ...primType(cls.name, cls.packed?.arity ?? 1), module: cls.module, kind, classOf: cls };
    classTypes.set(cls, entity);
  }
  return entity;
}

const constraintTuples = new Map<number, TypeEntity>();

/** The type of a tuple of constraints, `(Show a, Eq a)`, which a constraint synonym's application may stand for. */
export function constraintTupleType(arity: number): TypeEntity {
  let entity = constraintTuples.get(arity);
  if (!entity) {
    let kind: Kind = { tag: 'constraint' };
    for (let index = 0; index < arity; index++) kind = kindArrow({ tag: 'constraint' }, kind);
    entity = { ...primType(`(${','.repeat(arity - 1)})`, arity, 'tuple'), kind };
    constraintTuples.set(arity, entity);
  }
  return entity;
}

const unboxedTuples = new Map<number, TypeEntity>();

/** The name of the unboxed tuple type of a size and of its constructor: `(# #)`, `(#_#)`, `(#,#)`, `(#,,#)`. */
export function unboxedTupleName(size: number): string {
  if (size === 0) return '(# #)';
  return size === 1 ? '(#_#)' : `(#${','.repeat(size - 1)}#)`;
}

/** An unboxed tuple, `(# a, b #)`, as UnboxedTuples writes it, which holds its parts like a tuple does. */
export function unboxedTupleType(size: number): TypeEntity {
  let type = unboxedTuples.get(size);
  if (!type) {
    const name = unboxedTupleName(size);
    type = { ...primType(name, size, 'unboxedTuple'), sort: 'data' };
    addConstructor(
      type,
      name,
      Array.from({ length: size }, (_, index) => gen(index))
    );
    unboxedTuples.set(size, type);
  }
  return type;
}

const unboxedSums = new Map<number, TypeEntity>();

/** The name of an alternative of an unboxed sum, `(#_|#)` for the first of two. */
export function unboxedSumConName(alternative: number, arity: number): string {
  return `(#${'|'.repeat(alternative)}_${'|'.repeat(arity - 1 - alternative)}#)`;
}

/** An unboxed sum, `(# a | b #)`, as UnboxedSums writes it, whose alternatives are its constructors. */
export function unboxedSumType(arity: number): TypeEntity {
  let type = unboxedSums.get(arity);
  if (!type) {
    type = { ...primType(`(#${'|'.repeat(arity - 1)}#)`, arity, 'unboxedSum'), sort: 'data' };
    for (let index = 0; index < arity; index++) addConstructor(type, unboxedSumConName(index, arity), [gen(index)]);
    unboxedSums.set(arity, type);
  }
  return type;
}
