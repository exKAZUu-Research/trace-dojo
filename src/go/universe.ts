import type { Entity } from './entities';
import { Scope } from './scope';
import { TURTLE_TYPE } from './turtle';
import { ANY, BASIC, BYTE, COMPARABLE, ERROR_TYPE, RUNE, type Type } from './types';

/** The builtin functions, which the compiler checks and compiles one by one. */
export const BUILTIN_FUNCTIONS = [
  'append',
  'cap',
  'clear',
  'complex',
  'copy',
  'delete',
  'imag',
  'len',
  'make',
  'max',
  'min',
  'new',
  'panic',
  'print',
  'println',
  'real',
  'recover',
  'close',
  'NewTurtle',
] as const;

/** The scope of the predeclared names, which every file sees. */
export const UNIVERSE = new Scope(undefined);

const types: Record<string, Type> = {
  bool: BASIC.bool,
  string: BASIC.string,
  int: BASIC.int,
  int8: BASIC.int8,
  int16: BASIC.int16,
  int32: BASIC.int32,
  int64: BASIC.int64,
  uint: BASIC.uint,
  uint8: BASIC.uint8,
  uint16: BASIC.uint16,
  uint32: BASIC.uint32,
  uint64: BASIC.uint64,
  uintptr: BASIC.uintptr,
  float32: BASIC.float32,
  float64: BASIC.float64,
  complex64: BASIC.complex64,
  complex128: BASIC.complex128,
  byte: BYTE,
  rune: RUNE,
  error: ERROR_TYPE,
  any: ANY,
  comparable: { kind: 'named', name: 'comparable', pkg: '', underlying: COMPARABLE, methods: [] },
  Turtle: TURTLE_TYPE,
};
for (const [name, type] of Object.entries(types))
  UNIVERSE.entities.set(name, { kind: 'type', name, type } satisfies Entity);
UNIVERSE.entities.set('true', {
  kind: 'const',
  name: 'true',
  type: BASIC.untypedBool,
  value: { kind: 'bool', value: true },
  span: { row: 0, column: 0 },
  used: true,
});
UNIVERSE.entities.set('false', {
  kind: 'const',
  name: 'false',
  type: BASIC.untypedBool,
  value: { kind: 'bool', value: false },
  span: { row: 0, column: 0 },
  used: true,
});
UNIVERSE.entities.set('nil', { kind: 'nil' });
for (const name of BUILTIN_FUNCTIONS) UNIVERSE.entities.set(name, { kind: 'builtin', name });
