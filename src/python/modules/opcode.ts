import { builtin } from '../define';
import { registerModule } from '../modules';
import { registerSourceModule } from '../sourceModules';
import { newList, newTuple, None, typeError, typeName } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import type { PyValue } from '../values';

// `opcode`, CPython's Lib/opcode.py, with the bytecode data of CPython 3.14.10's `_opcode` and `_opcode_metadata`.
// This grader runs no bytecode, so what needs it, as `stack_effect`, fails with the unsupported error.

/** The valid opcodes of CPython 3.14.10, as ranges `[first, last]`, and those each `_opcode.has_*` holds for. */
const VALID: readonly [number, number][] = [
  [0, 120],
  [128, 211],
  [234, 266],
];
const HAS: Record<string, readonly number[]> = {
  has_const: [82, 190, 191],
  has_name: [61, 64, 65, 72, 73, 80, 91, 92, 93, 96, 110, 115, 116, 179, 189, 194, 195, 200, 249],
  has_jump: [68, 70, 75, 76, 77, 100, 101, 102, 103, 106, 172, 173, 174, 175, 176, 237, 248, 257, 258, 259, 260],
  has_free: [62, 90, 97, 111],
  has_local: [3, 63, 83, 84, 85, 86, 87, 88, 89, 112, 113, 114, 261, 266],
  has_exc: [263, 264, 265],
};
/** The opcodes that take an argument: 44 to 120 and these. */
const WITH_ARGUMENT: ReadonlySet<number> = new Set([
  128, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165,
  166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188,
  189, 190, 191, 192, 193, 194, 195, 197, 200, 209, 210, 211, 237, 239, 241, 242, 243, 244, 245, 247, 248, 249, 250,
  251, 253, 255, 257, 258, 259, 260, 261, 263, 264, 265, 266,
]);

const INTRINSIC_1 = [
  'INTRINSIC_1_INVALID',
  'INTRINSIC_PRINT',
  'INTRINSIC_IMPORT_STAR',
  'INTRINSIC_STOPITERATION_ERROR',
  'INTRINSIC_ASYNC_GEN_WRAP',
  'INTRINSIC_UNARY_POSITIVE',
  'INTRINSIC_LIST_TO_TUPLE',
  'INTRINSIC_TYPEVAR',
  'INTRINSIC_PARAMSPEC',
  'INTRINSIC_TYPEVARTUPLE',
  'INTRINSIC_SUBSCRIPT_GENERIC',
  'INTRINSIC_TYPEALIAS',
];
const INTRINSIC_2 = [
  'INTRINSIC_2_INVALID',
  'INTRINSIC_PREP_RERAISE_STAR',
  'INTRINSIC_TYPEVAR_WITH_BOUND',
  'INTRINSIC_TYPEVAR_WITH_CONSTRAINTS',
  'INTRINSIC_SET_FUNCTION_TYPE_PARAMS',
  'INTRINSIC_SET_TYPEPARAM_DEFAULT',
];
const NB_OPS: readonly [string, string][] = [
  ['NB_ADD', '+'],
  ['NB_AND', '&'],
  ['NB_FLOOR_DIVIDE', '//'],
  ['NB_LSHIFT', '<<'],
  ['NB_MATRIX_MULTIPLY', '@'],
  ['NB_MULTIPLY', '*'],
  ['NB_REMAINDER', '%'],
  ['NB_OR', '|'],
  ['NB_POWER', '**'],
  ['NB_RSHIFT', '>>'],
  ['NB_SUBTRACT', '-'],
  ['NB_TRUE_DIVIDE', '/'],
  ['NB_XOR', '^'],
  ['NB_INPLACE_ADD', '+='],
  ['NB_INPLACE_AND', '&='],
  ['NB_INPLACE_FLOOR_DIVIDE', '//='],
  ['NB_INPLACE_LSHIFT', '<<='],
  ['NB_INPLACE_MATRIX_MULTIPLY', '@='],
  ['NB_INPLACE_MULTIPLY', '*='],
  ['NB_INPLACE_REMAINDER', '%='],
  ['NB_INPLACE_OR', '|='],
  ['NB_INPLACE_POWER', '**='],
  ['NB_INPLACE_RSHIFT', '>>='],
  ['NB_INPLACE_SUBTRACT', '-='],
  ['NB_INPLACE_TRUE_DIVIDE', '/='],
  ['NB_INPLACE_XOR', '^='],
  ['NB_SUBSCR', '[]'],
];

registerModule('_opcode', () => {
  const tests: [string, (op: number) => boolean][] = [
    ['is_valid', isValid],
    ['has_arg', (op) => isValid(op) && ((op >= 44 && op <= 120) || WITH_ARGUMENT.has(op))],
    ...Object.entries(HAS).map(([name, ops]): [string, (op: number) => boolean] => [name, (op) => ops.includes(op)]),
  ];
  return new Map<string, PyValue>([
    ['ENABLE_SPECIALIZATION', 1n],
    ['ENABLE_SPECIALIZATION_FT', 1n],
    ...tests.map(([name, test]): [string, PyValue] => [
      name,
      builtin(name, 'one', 1, 1, ([opcode]) => test(opcodeNumber(opcode))),
    ]),
    ['get_intrinsic1_descs', builtin('get_intrinsic1_descs', 'none', 0, 0, () => newList([...INTRINSIC_1]))],
    ['get_intrinsic2_descs', builtin('get_intrinsic2_descs', 'none', 0, 0, () => newList([...INTRINSIC_2]))],
    [
      'get_special_method_names',
      builtin('get_special_method_names', 'none', 0, 0, () =>
        newList(['__enter__', '__exit__', '__aenter__', '__aexit__'])
      ),
    ],
    ['get_nb_ops', builtin('get_nb_ops', 'none', 0, 0, () => newList(NB_OPS.map((pair) => newTuple([...pair]))))],
    ['get_specialization_stats', builtin('get_specialization_stats', 'none', 0, 0, () => None)],
    ['stack_effect', bytecodeFunction('stack_effect')],
    ['get_executor', bytecodeFunction('get_executor')],
  ]);
});

function isValid(op: number): boolean {
  return VALID.some(([first, last]) => op >= first && op <= last);
}

/** The opcode an argument names, an int as CPython's `_opcode` functions take. */
function opcodeNumber(value: PyValue): number {
  if (typeof value === 'boolean') return Number(value);
  if (typeof value !== 'bigint') throw typeError(`'${typeName(value)}' object cannot be interpreted as an integer`);
  return value > 1_000_000n || value < -1_000_000n ? -1 : Number(value);
}

/** A function of `_opcode` that reads the bytecode CPython compiles, which this grader does not. */
function bytecodeFunction(name: string): PyValue {
  const run = (): never => {
    throw new UnsupportedFeatureError(`バイトコードを扱う _opcode.${name}`);
  };
  return builtin(name, 'expected', 0, Number.POSITIVE_INFINITY, run, { keywords: ['jump'] });
}

registerSourceModule(
  '_opcode_metadata',
  String.raw`
# This file is generated by Tools/cases_generator/py_metadata_generator.py
# from:
#   Python/bytecodes.c
# Do not edit!
_specializations = {
    "RESUME": [
        "RESUME_CHECK",
    ],
    "LOAD_CONST": [
        "LOAD_CONST_MORTAL",
        "LOAD_CONST_IMMORTAL",
    ],
    "TO_BOOL": [
        "TO_BOOL_ALWAYS_TRUE",
        "TO_BOOL_BOOL",
        "TO_BOOL_INT",
        "TO_BOOL_LIST",
        "TO_BOOL_NONE",
        "TO_BOOL_STR",
    ],
    "BINARY_OP": [
        "BINARY_OP_MULTIPLY_INT",
        "BINARY_OP_ADD_INT",
        "BINARY_OP_SUBTRACT_INT",
        "BINARY_OP_MULTIPLY_FLOAT",
        "BINARY_OP_ADD_FLOAT",
        "BINARY_OP_SUBTRACT_FLOAT",
        "BINARY_OP_ADD_UNICODE",
        "BINARY_OP_SUBSCR_LIST_INT",
        "BINARY_OP_SUBSCR_LIST_SLICE",
        "BINARY_OP_SUBSCR_TUPLE_INT",
        "BINARY_OP_SUBSCR_STR_INT",
        "BINARY_OP_SUBSCR_DICT",
        "BINARY_OP_SUBSCR_GETITEM",
        "BINARY_OP_EXTEND",
        "BINARY_OP_INPLACE_ADD_UNICODE",
    ],
    "STORE_SUBSCR": [
        "STORE_SUBSCR_DICT",
        "STORE_SUBSCR_LIST_INT",
    ],
    "SEND": [
        "SEND_GEN",
    ],
    "UNPACK_SEQUENCE": [
        "UNPACK_SEQUENCE_TWO_TUPLE",
        "UNPACK_SEQUENCE_TUPLE",
        "UNPACK_SEQUENCE_LIST",
    ],
    "STORE_ATTR": [
        "STORE_ATTR_INSTANCE_VALUE",
        "STORE_ATTR_SLOT",
        "STORE_ATTR_WITH_HINT",
    ],
    "LOAD_GLOBAL": [
        "LOAD_GLOBAL_MODULE",
        "LOAD_GLOBAL_BUILTIN",
    ],
    "LOAD_SUPER_ATTR": [
        "LOAD_SUPER_ATTR_ATTR",
        "LOAD_SUPER_ATTR_METHOD",
    ],
    "LOAD_ATTR": [
        "LOAD_ATTR_INSTANCE_VALUE",
        "LOAD_ATTR_MODULE",
        "LOAD_ATTR_WITH_HINT",
        "LOAD_ATTR_SLOT",
        "LOAD_ATTR_CLASS",
        "LOAD_ATTR_CLASS_WITH_METACLASS_CHECK",
        "LOAD_ATTR_PROPERTY",
        "LOAD_ATTR_GETATTRIBUTE_OVERRIDDEN",
        "LOAD_ATTR_METHOD_WITH_VALUES",
        "LOAD_ATTR_METHOD_NO_DICT",
        "LOAD_ATTR_METHOD_LAZY_DICT",
        "LOAD_ATTR_NONDESCRIPTOR_WITH_VALUES",
        "LOAD_ATTR_NONDESCRIPTOR_NO_DICT",
    ],
    "COMPARE_OP": [
        "COMPARE_OP_FLOAT",
        "COMPARE_OP_INT",
        "COMPARE_OP_STR",
    ],
    "CONTAINS_OP": [
        "CONTAINS_OP_SET",
        "CONTAINS_OP_DICT",
    ],
    "JUMP_BACKWARD": [
        "JUMP_BACKWARD_NO_JIT",
        "JUMP_BACKWARD_JIT",
    ],
    "FOR_ITER": [
        "FOR_ITER_LIST",
        "FOR_ITER_TUPLE",
        "FOR_ITER_RANGE",
        "FOR_ITER_GEN",
    ],
    "CALL": [
        "CALL_BOUND_METHOD_EXACT_ARGS",
        "CALL_PY_EXACT_ARGS",
        "CALL_TYPE_1",
        "CALL_STR_1",
        "CALL_TUPLE_1",
        "CALL_BUILTIN_CLASS",
        "CALL_BUILTIN_O",
        "CALL_BUILTIN_FAST",
        "CALL_BUILTIN_FAST_WITH_KEYWORDS",
        "CALL_LEN",
        "CALL_ISINSTANCE",
        "CALL_LIST_APPEND",
        "CALL_METHOD_DESCRIPTOR_O",
        "CALL_METHOD_DESCRIPTOR_FAST_WITH_KEYWORDS",
        "CALL_METHOD_DESCRIPTOR_NOARGS",
        "CALL_METHOD_DESCRIPTOR_FAST",
        "CALL_ALLOC_AND_ENTER_INIT",
        "CALL_PY_GENERAL",
        "CALL_BOUND_METHOD_GENERAL",
        "CALL_NON_PY_GENERAL",
    ],
    "CALL_KW": [
        "CALL_KW_BOUND_METHOD",
        "CALL_KW_PY",
        "CALL_KW_NON_PY",
    ],
}

_specialized_opmap = {
    'BINARY_OP_ADD_FLOAT': 129,
    'BINARY_OP_ADD_INT': 130,
    'BINARY_OP_ADD_UNICODE': 131,
    'BINARY_OP_EXTEND': 132,
    'BINARY_OP_INPLACE_ADD_UNICODE': 3,
    'BINARY_OP_MULTIPLY_FLOAT': 133,
    'BINARY_OP_MULTIPLY_INT': 134,
    'BINARY_OP_SUBSCR_DICT': 135,
    'BINARY_OP_SUBSCR_GETITEM': 136,
    'BINARY_OP_SUBSCR_LIST_INT': 137,
    'BINARY_OP_SUBSCR_LIST_SLICE': 138,
    'BINARY_OP_SUBSCR_STR_INT': 139,
    'BINARY_OP_SUBSCR_TUPLE_INT': 140,
    'BINARY_OP_SUBTRACT_FLOAT': 141,
    'BINARY_OP_SUBTRACT_INT': 142,
    'CALL_ALLOC_AND_ENTER_INIT': 143,
    'CALL_BOUND_METHOD_EXACT_ARGS': 144,
    'CALL_BOUND_METHOD_GENERAL': 145,
    'CALL_BUILTIN_CLASS': 146,
    'CALL_BUILTIN_FAST': 147,
    'CALL_BUILTIN_FAST_WITH_KEYWORDS': 148,
    'CALL_BUILTIN_O': 149,
    'CALL_ISINSTANCE': 150,
    'CALL_KW_BOUND_METHOD': 151,
    'CALL_KW_NON_PY': 152,
    'CALL_KW_PY': 153,
    'CALL_LEN': 154,
    'CALL_LIST_APPEND': 155,
    'CALL_METHOD_DESCRIPTOR_FAST': 156,
    'CALL_METHOD_DESCRIPTOR_FAST_WITH_KEYWORDS': 157,
    'CALL_METHOD_DESCRIPTOR_NOARGS': 158,
    'CALL_METHOD_DESCRIPTOR_O': 159,
    'CALL_NON_PY_GENERAL': 160,
    'CALL_PY_EXACT_ARGS': 161,
    'CALL_PY_GENERAL': 162,
    'CALL_STR_1': 163,
    'CALL_TUPLE_1': 164,
    'CALL_TYPE_1': 165,
    'COMPARE_OP_FLOAT': 166,
    'COMPARE_OP_INT': 167,
    'COMPARE_OP_STR': 168,
    'CONTAINS_OP_DICT': 169,
    'CONTAINS_OP_SET': 170,
    'FOR_ITER_GEN': 171,
    'FOR_ITER_LIST': 172,
    'FOR_ITER_RANGE': 173,
    'FOR_ITER_TUPLE': 174,
    'JUMP_BACKWARD_JIT': 175,
    'JUMP_BACKWARD_NO_JIT': 176,
    'LOAD_ATTR_CLASS': 177,
    'LOAD_ATTR_CLASS_WITH_METACLASS_CHECK': 178,
    'LOAD_ATTR_GETATTRIBUTE_OVERRIDDEN': 179,
    'LOAD_ATTR_INSTANCE_VALUE': 180,
    'LOAD_ATTR_METHOD_LAZY_DICT': 181,
    'LOAD_ATTR_METHOD_NO_DICT': 182,
    'LOAD_ATTR_METHOD_WITH_VALUES': 183,
    'LOAD_ATTR_MODULE': 184,
    'LOAD_ATTR_NONDESCRIPTOR_NO_DICT': 185,
    'LOAD_ATTR_NONDESCRIPTOR_WITH_VALUES': 186,
    'LOAD_ATTR_PROPERTY': 187,
    'LOAD_ATTR_SLOT': 188,
    'LOAD_ATTR_WITH_HINT': 189,
    'LOAD_CONST_IMMORTAL': 190,
    'LOAD_CONST_MORTAL': 191,
    'LOAD_GLOBAL_BUILTIN': 192,
    'LOAD_GLOBAL_MODULE': 193,
    'LOAD_SUPER_ATTR_ATTR': 194,
    'LOAD_SUPER_ATTR_METHOD': 195,
    'RESUME_CHECK': 196,
    'SEND_GEN': 197,
    'STORE_ATTR_INSTANCE_VALUE': 198,
    'STORE_ATTR_SLOT': 199,
    'STORE_ATTR_WITH_HINT': 200,
    'STORE_SUBSCR_DICT': 201,
    'STORE_SUBSCR_LIST_INT': 202,
    'TO_BOOL_ALWAYS_TRUE': 203,
    'TO_BOOL_BOOL': 204,
    'TO_BOOL_INT': 205,
    'TO_BOOL_LIST': 206,
    'TO_BOOL_NONE': 207,
    'TO_BOOL_STR': 208,
    'UNPACK_SEQUENCE_LIST': 209,
    'UNPACK_SEQUENCE_TUPLE': 210,
    'UNPACK_SEQUENCE_TWO_TUPLE': 211,
}

opmap = {
    'CACHE': 0,
    'RESERVED': 17,
    'RESUME': 128,
    'INSTRUMENTED_LINE': 254,
    'ENTER_EXECUTOR': 255,
    'BINARY_SLICE': 1,
    'BUILD_TEMPLATE': 2,
    'CALL_FUNCTION_EX': 4,
    'CHECK_EG_MATCH': 5,
    'CHECK_EXC_MATCH': 6,
    'CLEANUP_THROW': 7,
    'DELETE_SUBSCR': 8,
    'END_FOR': 9,
    'END_SEND': 10,
    'EXIT_INIT_CHECK': 11,
    'FORMAT_SIMPLE': 12,
    'FORMAT_WITH_SPEC': 13,
    'GET_AITER': 14,
    'GET_ANEXT': 15,
    'GET_ITER': 16,
    'GET_LEN': 18,
    'GET_YIELD_FROM_ITER': 19,
    'INTERPRETER_EXIT': 20,
    'LOAD_BUILD_CLASS': 21,
    'LOAD_LOCALS': 22,
    'MAKE_FUNCTION': 23,
    'MATCH_KEYS': 24,
    'MATCH_MAPPING': 25,
    'MATCH_SEQUENCE': 26,
    'NOP': 27,
    'NOT_TAKEN': 28,
    'POP_EXCEPT': 29,
    'POP_ITER': 30,
    'POP_TOP': 31,
    'PUSH_EXC_INFO': 32,
    'PUSH_NULL': 33,
    'RETURN_GENERATOR': 34,
    'RETURN_VALUE': 35,
    'SETUP_ANNOTATIONS': 36,
    'STORE_SLICE': 37,
    'STORE_SUBSCR': 38,
    'TO_BOOL': 39,
    'UNARY_INVERT': 40,
    'UNARY_NEGATIVE': 41,
    'UNARY_NOT': 42,
    'WITH_EXCEPT_START': 43,
    'BINARY_OP': 44,
    'BUILD_INTERPOLATION': 45,
    'BUILD_LIST': 46,
    'BUILD_MAP': 47,
    'BUILD_SET': 48,
    'BUILD_SLICE': 49,
    'BUILD_STRING': 50,
    'BUILD_TUPLE': 51,
    'CALL': 52,
    'CALL_INTRINSIC_1': 53,
    'CALL_INTRINSIC_2': 54,
    'CALL_KW': 55,
    'COMPARE_OP': 56,
    'CONTAINS_OP': 57,
    'CONVERT_VALUE': 58,
    'COPY': 59,
    'COPY_FREE_VARS': 60,
    'DELETE_ATTR': 61,
    'DELETE_DEREF': 62,
    'DELETE_FAST': 63,
    'DELETE_GLOBAL': 64,
    'DELETE_NAME': 65,
    'DICT_MERGE': 66,
    'DICT_UPDATE': 67,
    'END_ASYNC_FOR': 68,
    'EXTENDED_ARG': 69,
    'FOR_ITER': 70,
    'GET_AWAITABLE': 71,
    'IMPORT_FROM': 72,
    'IMPORT_NAME': 73,
    'IS_OP': 74,
    'JUMP_BACKWARD': 75,
    'JUMP_BACKWARD_NO_INTERRUPT': 76,
    'JUMP_FORWARD': 77,
    'LIST_APPEND': 78,
    'LIST_EXTEND': 79,
    'LOAD_ATTR': 80,
    'LOAD_COMMON_CONSTANT': 81,
    'LOAD_CONST': 82,
    'LOAD_DEREF': 83,
    'LOAD_FAST': 84,
    'LOAD_FAST_AND_CLEAR': 85,
    'LOAD_FAST_BORROW': 86,
    'LOAD_FAST_BORROW_LOAD_FAST_BORROW': 87,
    'LOAD_FAST_CHECK': 88,
    'LOAD_FAST_LOAD_FAST': 89,
    'LOAD_FROM_DICT_OR_DEREF': 90,
    'LOAD_FROM_DICT_OR_GLOBALS': 91,
    'LOAD_GLOBAL': 92,
    'LOAD_NAME': 93,
    'LOAD_SMALL_INT': 94,
    'LOAD_SPECIAL': 95,
    'LOAD_SUPER_ATTR': 96,
    'MAKE_CELL': 97,
    'MAP_ADD': 98,
    'MATCH_CLASS': 99,
    'POP_JUMP_IF_FALSE': 100,
    'POP_JUMP_IF_NONE': 101,
    'POP_JUMP_IF_NOT_NONE': 102,
    'POP_JUMP_IF_TRUE': 103,
    'RAISE_VARARGS': 104,
    'RERAISE': 105,
    'SEND': 106,
    'SET_ADD': 107,
    'SET_FUNCTION_ATTRIBUTE': 108,
    'SET_UPDATE': 109,
    'STORE_ATTR': 110,
    'STORE_DEREF': 111,
    'STORE_FAST': 112,
    'STORE_FAST_LOAD_FAST': 113,
    'STORE_FAST_STORE_FAST': 114,
    'STORE_GLOBAL': 115,
    'STORE_NAME': 116,
    'SWAP': 117,
    'UNPACK_EX': 118,
    'UNPACK_SEQUENCE': 119,
    'YIELD_VALUE': 120,
    'INSTRUMENTED_END_FOR': 234,
    'INSTRUMENTED_POP_ITER': 235,
    'INSTRUMENTED_END_SEND': 236,
    'INSTRUMENTED_FOR_ITER': 237,
    'INSTRUMENTED_INSTRUCTION': 238,
    'INSTRUMENTED_JUMP_FORWARD': 239,
    'INSTRUMENTED_NOT_TAKEN': 240,
    'INSTRUMENTED_POP_JUMP_IF_TRUE': 241,
    'INSTRUMENTED_POP_JUMP_IF_FALSE': 242,
    'INSTRUMENTED_POP_JUMP_IF_NONE': 243,
    'INSTRUMENTED_POP_JUMP_IF_NOT_NONE': 244,
    'INSTRUMENTED_RESUME': 245,
    'INSTRUMENTED_RETURN_VALUE': 246,
    'INSTRUMENTED_YIELD_VALUE': 247,
    'INSTRUMENTED_END_ASYNC_FOR': 248,
    'INSTRUMENTED_LOAD_SUPER_ATTR': 249,
    'INSTRUMENTED_CALL': 250,
    'INSTRUMENTED_CALL_KW': 251,
    'INSTRUMENTED_CALL_FUNCTION_EX': 252,
    'INSTRUMENTED_JUMP_BACKWARD': 253,
    'ANNOTATIONS_PLACEHOLDER': 256,
    'JUMP': 257,
    'JUMP_IF_FALSE': 258,
    'JUMP_IF_TRUE': 259,
    'JUMP_NO_INTERRUPT': 260,
    'LOAD_CLOSURE': 261,
    'POP_BLOCK': 262,
    'SETUP_CLEANUP': 263,
    'SETUP_FINALLY': 264,
    'SETUP_WITH': 265,
    'STORE_FAST_MAYBE_NULL': 266,
}

HAVE_ARGUMENT = 43
MIN_INSTRUMENTED_OPCODE = 234
`
);

registerSourceModule(
  'opcode',
  String.raw`

"""
opcode module - potentially shared between dis and other modules which
operate on bytecodes (e.g. peephole optimizers).
"""


__all__ = ["cmp_op", "stack_effect", "hascompare", "opname", "opmap",
           "HAVE_ARGUMENT", "EXTENDED_ARG", "hasarg", "hasconst", "hasname",
           "hasjump", "hasjrel", "hasjabs", "hasfree", "haslocal", "hasexc"]

import builtins
import _opcode
from _opcode import stack_effect

from _opcode_metadata import (_specializations, _specialized_opmap, opmap,  # noqa: F401
                              HAVE_ARGUMENT, MIN_INSTRUMENTED_OPCODE)  # noqa: F401
EXTENDED_ARG = opmap['EXTENDED_ARG']

opname = ['<%r>' % (op,) for op in range(max(opmap.values()) + 1)]
for m in (opmap, _specialized_opmap):
    for op, i in m.items():
        opname[i] = op

cmp_op = ('<', '<=', '==', '!=', '>', '>=')

# These lists are documented as part of the dis module's API
hasarg = [op for op in opmap.values() if _opcode.has_arg(op)]
hasconst = [op for op in opmap.values() if _opcode.has_const(op)]
hasname = [op for op in opmap.values() if _opcode.has_name(op)]
hasjump = [op for op in opmap.values() if _opcode.has_jump(op)]
hasjrel = hasjump  # for backward compatibility
hasjabs = []
hasfree = [op for op in opmap.values() if _opcode.has_free(op)]
haslocal = [op for op in opmap.values() if _opcode.has_local(op)]
hasexc = [op for op in opmap.values() if _opcode.has_exc(op)]


_intrinsic_1_descs = _opcode.get_intrinsic1_descs()
_intrinsic_2_descs = _opcode.get_intrinsic2_descs()
_special_method_names = _opcode.get_special_method_names()
_common_constants = [builtins.AssertionError, builtins.NotImplementedError,
                     builtins.tuple, builtins.all, builtins.any]
_nb_ops = _opcode.get_nb_ops()

hascompare = [opmap["COMPARE_OP"]]

_cache_format = {
    "LOAD_GLOBAL": {
        "counter": 1,
        "index": 1,
        "module_keys_version": 1,
        "builtin_keys_version": 1,
    },
    "BINARY_OP": {
        "counter": 1,
        "descr": 4,
    },
    "UNPACK_SEQUENCE": {
        "counter": 1,
    },
    "COMPARE_OP": {
        "counter": 1,
    },
    "CONTAINS_OP": {
        "counter": 1,
    },
    "FOR_ITER": {
        "counter": 1,
    },
    "LOAD_SUPER_ATTR": {
        "counter": 1,
    },
    "LOAD_ATTR": {
        "counter": 1,
        "version": 2,
        "keys_version": 2,
        "descr": 4,
    },
    "STORE_ATTR": {
        "counter": 1,
        "version": 2,
        "index": 1,
    },
    "CALL": {
        "counter": 1,
        "func_version": 2,
    },
    "CALL_KW": {
        "counter": 1,
        "func_version": 2,
    },
    "STORE_SUBSCR": {
        "counter": 1,
    },
    "SEND": {
        "counter": 1,
    },
    "JUMP_BACKWARD": {
        "counter": 1,
    },
    "TO_BOOL": {
        "counter": 1,
        "version": 2,
    },
    "POP_JUMP_IF_TRUE": {
        "counter": 1,
    },
    "POP_JUMP_IF_FALSE": {
        "counter": 1,
    },
    "POP_JUMP_IF_NONE": {
        "counter": 1,
    },
    "POP_JUMP_IF_NOT_NONE": {
        "counter": 1,
    },
}

_inline_cache_entries = {
    name : sum(value.values()) for (name, value) in _cache_format.items()
}
`
);
