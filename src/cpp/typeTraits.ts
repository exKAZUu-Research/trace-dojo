import { CompileError } from '../interpreter/diagnostics';
import type { Compiler } from './compiler';
import { implicitConversion } from './conversions';
import type { Expr } from './expr';
import {
  type ClassInfo,
  classType,
  hasVacuousInitialization,
  isArithmetic,
  isConstType,
  isSigned,
  isStandardLayout,
  nonReference,
  type Type,
  unqualified,
} from './types';

type Trait = (compiler: Compiler, types: Type[], row: number) => boolean;

/**
 * The type-trait builtins of clang (`__is_class(T)`) that the library's `<type_traits>` is written with, by name.
 * They ask the compiler what C++ code cannot tell, such as whether a class is a union or derives from another.
 */
export const TYPE_TRAITS: Readonly<Record<string, Trait>> = {
  __is_void: (_, [type]) => unqualified(type).kind === 'void',
  __is_null_pointer: (_, [type]) => unqualified(type).kind === 'nullptr',
  __is_integral: (_, [type]) => type.kind === 'int' && !type.enumeration,
  __is_floating_point: (_, [type]) => type.kind === 'float',
  __is_arithmetic: (_, [type]) => isArithmetic(type) && !(type.kind === 'int' && type.enumeration),
  __is_pointer: (_, [type]) => type.kind === 'pointer',
  __is_lvalue_reference: (_, [type]) => type.kind === 'reference' && !type.isRvalue,
  __is_rvalue_reference: (_, [type]) => type.kind === 'reference' && type.isRvalue === true,
  __is_reference: (_, [type]) => type.kind === 'reference',
  __is_const: (_, [type]) => type.kind !== 'reference' && isConstType(type),
  __is_array: (_, [type]) => type.kind === 'array',
  __is_bounded_array: (_, [type]) => type.kind === 'array' && type.length !== undefined,
  __is_unbounded_array: (_, [type]) => type.kind === 'array' && type.length === undefined,
  __is_function: (_, [type]) => type.kind === 'function',
  __is_enum: (_, [type]) => type.kind === 'int' && type.enumeration !== undefined,
  __is_scoped_enum: (_, [type]) => type.kind === 'int' && type.enumeration?.isScoped === true,
  __is_class: (_, [type]) => type.kind === 'class' && !type.cls.isUnion,
  __is_union: (_, [type]) => type.kind === 'class' && type.cls.isUnion,
  __is_signed: (_, [type]) =>
    type.kind === 'float' || (type.kind === 'int' && !type.enumeration && type.name !== 'bool' && isSigned(type)),
  __is_unsigned: (_, [type]) => type.kind === 'int' && !type.enumeration && (type.name === 'bool' || !isSigned(type)),
  __is_base_of: (_, [base, derived]) =>
    base.kind === 'class' && derived.kind === 'class' && derived.cls.isDerivedFrom(base.cls),
  __is_convertible: (compiler, [from, to], row) =>
    to.kind === 'void' ||
    (from.kind !== 'void' &&
      compiles(compiler, () => implicitConversion(compiler, valueOf(from, row), to) ?? fail(row))),
  __is_constructible: (compiler, [type, ...args], row) =>
    type.kind !== 'void' &&
    compiles(compiler, () =>
      compiler.directInitialization(
        type,
        args.map((arg) => valueOf(arg, row)),
        row
      )
    ),
  __is_assignable: (compiler, [target, source], row) =>
    compiles(compiler, () => compiler.binary('=', valueOf(target, row), valueOf(source, row), row) ?? fail(row)),
  __is_destructible: (_, [type]) => type.kind !== 'void' && type.kind !== 'function',
  __is_polymorphic: (_, [type]) => type.kind === 'class' && type.cls.isPolymorphic,
  __is_abstract: (_, [type]) => type.kind === 'class' && type.cls.isAbstract,
  __is_final: (_, [type]) => type.kind === 'class' && type.cls.isFinal === true,
  __is_empty: (_, [type]) => type.kind === 'class' && isEmpty(type.cls),
  __is_aggregate: (compiler, [type]) =>
    type.kind === 'array' || (type.kind === 'class' && compiler.isAggregateClass(type.cls)),
  __is_standard_layout: (_, [type]) => type.kind !== 'class' || (type.cls.isComplete && isStandardLayout(type.cls)),
  __is_trivially_copyable: (_, [type]) => isTriviallyCopyable(type),
  __is_trivial: (_, [type]) => isTriviallyCopyable(type) && hasVacuousInitialization(unqualified(type)),
};

/** An lvalue of a type, or an rvalue of it when the type is an rvalue reference, as `std::declval<T>()` gives. */
function valueOf(type: Type, row: number): Expr {
  return {
    type: nonReference(type),
    isLvalue: type.kind === 'reference' && !type.isRvalue,
    row,
    run: () => {},
  };
}

function fail(row: number): never {
  throw new CompileError([{ row, message: '' }]);
}

function compiles(compiler: Compiler, compile: () => unknown): boolean {
  return compiler.unevaluated(() => {
    try {
      compile();
      return true;
    } catch (error) {
      if (error instanceof CompileError) return false;
      throw error;
    }
  });
}

function isEmpty(cls: ClassInfo): boolean {
  return !cls.library && !cls.isPolymorphic && cls.fields.length === 0 && (!cls.base || isEmpty(cls.base));
}

function isTriviallyCopyable(type: Type): boolean {
  if (type.kind === 'array') return isTriviallyCopyable(type.of);
  if (type.kind === 'reference' || type.kind === 'void' || type.kind === 'function') return false;
  if (type.kind !== 'class') return true;
  const { cls } = type;
  if (cls.library) return cls.library.kind === 'array' && isTriviallyCopyable(cls.library.args[0]);
  return (
    !cls.isPolymorphic &&
    !cls.hasUserDestructor &&
    !cls.constructors.some((fn) => !fn.native && !fn.isDefaulted && copiesOrMoves(fn.params[0]?.type, cls)) &&
    !(cls.methods.get('operator=') ?? []).some((fn) => !fn.isDefaulted && copiesOrMoves(fn.params[0]?.type, cls)) &&
    (!cls.base || isTriviallyCopyable(classType(cls.base))) &&
    cls.ownFields.every((field) => isTriviallyCopyable(field.type))
  );
}

function copiesOrMoves(type: Type | undefined, cls: ClassInfo): boolean {
  const target = type?.kind === 'reference' ? type.to : type;
  return target?.kind === 'class' && target.cls === cls;
}
