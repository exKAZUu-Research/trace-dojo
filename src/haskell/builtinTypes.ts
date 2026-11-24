import { type ConInfo, nextId, type TypeEntity, type ValueEntity } from './entities';
import { compileError } from './errors';
import { simpleKind, type Type } from './types';

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

export const PRIMITIVE_TYPES = [
  INT_TYPE,
  INTEGER_TYPE,
  DOUBLE_TYPE,
  FLOAT_TYPE,
  CHAR_TYPE,
  IO_TYPE,
  TURTLE_TYPE,
  WORD_TYPE,
];
