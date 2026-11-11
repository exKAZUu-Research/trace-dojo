// `type.__flags__`, whose heap-type bit copyreg reads to tell C types from classes; the other bits follow CPython 3.14's
// values for the builtin types and the classes programs define.
import { baseExceptionClass } from './types';
import { type PyClass, PySet } from './values';

const HEAP_BASE = 0x56_00;
const IS_ABSTRACT = 1 << 20;
/** The bits a class inherits from its builtin base: the subclass bits, MATCH_SELF, SEQUENCE and MAPPING. */
const INHERITED = 0xff_40_00_60;

const BUILTIN_FLAGS: Record<string, number> = {
  bool: 0x1_40_11_02,
  bytearray: 0x40_15_02,
  bytes: 0x8_40_15_02,
  classmethod: 0x55_02,
  complex: 0x15_02,
  dict: 0x20_40_55_42,
  enumerate: 0x55_02,
  filter: 0x55_02,
  float: 0x40_15_02,
  frozenset: 0x40_55_02,
  int: 0x1_40_15_02,
  list: 0x2_40_55_22,
  map: 0x55_02,
  memoryview: 0x51_22,
  object: 0x15_02,
  property: 0x55_02,
  range: 0x11_22,
  reversed: 0x55_02,
  set: 0x40_55_02,
  slice: 0x51_02,
  staticmethod: 0x55_02,
  str: 0x10_40_15_02,
  super: 0x55_02,
  tuple: 0x4_40_55_22,
  type: 0x80_80_5d_02,
  zip: 0x55_02,
  NoneType: 0x11_02,
  builtin_function_or_method: 0x59_82,
  function: 0x2_59_02,
  method: 0x59_02,
  ellipsis: 0x11_02,
  NotImplementedType: 0x11_02,
  generator: 0x51_82,
  module: 0x55_02,
};

export function typeFlags(cls: PyClass): number {
  if (cls.isBuiltin) return builtinFlags(cls);
  const base = cls.mro.find((each) => each.isBuiltin) ?? cls;
  const baseFlags = builtinFlags(base);
  let flags = HEAP_BASE | (baseFlags & INHERITED);
  if (base.isSubclassOf(baseExceptionClass)) flags |= 0x8;
  else if (cls.slotNames === undefined) flags |= ['object', 'list', 'dict'].includes(base.name) ? 0x1c : 0x10;
  const abstract = cls.dict.get('__abstractmethods__');
  if (abstract instanceof PySet && abstract.table.size > 0) flags |= IS_ABSTRACT;
  return flags >>> 0;
}

function builtinFlags(cls: PyClass): number {
  if (cls.module === undefined || cls.module === 'builtins') {
    const known = BUILTIN_FLAGS[cls.name];
    if (known !== undefined) return known;
    if (cls.isSubclassOf(baseExceptionClass)) return 0x40_00_55_02;
  }
  return cls.isBaseType ? 0x55_02 : 0x51_02;
}
