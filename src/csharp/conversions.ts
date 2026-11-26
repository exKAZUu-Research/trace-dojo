import {
  allInterfacesOf,
  baseTypeOf,
  isDynamicType,
  isPointerType,
  isReferenceType,
  isRefLikeType,
  isValueType,
  isVoidPointer,
  type NamedType,
  nullableUnderlying,
  sameType,
  specialOf,
  type SpecialType,
  type Type,
  type TypeParameterSymbol,
  type TypeSymbol,
} from './types';

/** How a value of one type becomes a value of another, which decides what the evaluator does with it. */
export type ConversionKind =
  | 'identity'
  /** From `dynamic` to another type, which the value's runtime type decides. */
  | 'dynamic'
  | 'numeric'
  | 'reference'
  /** A reference conversion that checks the value's runtime type, as a downcast does. */
  | 'referenceCheck'
  | 'boxing'
  | 'unboxing'
  | 'nullableWrap'
  | 'nullableUnwrap'
  /** A conversion between nullable types, or from a non-nullable to a nullable one, of the underlying values. */
  | 'nullableLifted'
  | 'nullLiteral'
  | 'enumNumeric'
  | 'tuple'
  | 'userDefined'
  /** A type parameter's value to a type it converts to, which boxes a value type at run time. */
  | 'typeParameterBox'
  /** A value to a type parameter, which unboxes or checks at run time. */
  | 'typeParameterUnbox'
  /** Between pointer types, or between a pointer and an integer, which keeps the address. */
  | 'pointer'
  /** An interpolated string to FormattableString, IFormattable, or a handler type, which binds it again. */
  | 'interpolatedString';

/** The types that conversions and operators know by role. */
export interface WellKnownTypes {
  object: NamedType;
  string: NamedType;
  valueType: NamedType;
  enum: NamedType;
  array: NamedType;
  delegate: NamedType;
  multicastDelegate: NamedType;
  nullable: TypeSymbol;
  /** The interfaces that `T[]` implements. */
  arrayInterfaces(element: Type): NamedType[];
  special(special: SpecialType): NamedType;
}

const NUMERIC_ORDER: ReadonlySet<SpecialType> = new Set<SpecialType>([
  'sbyte',
  'byte',
  'short',
  'ushort',
  'int',
  'uint',
  'long',
  'ulong',
  'char',
  'float',
  'double',
  'decimal',
]);

const IMPLICIT_NUMERIC: Partial<Record<SpecialType, SpecialType[]>> = {
  sbyte: ['short', 'int', 'long', 'float', 'double', 'decimal'],
  byte: ['short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'decimal'],
  short: ['int', 'long', 'float', 'double', 'decimal'],
  ushort: ['int', 'uint', 'long', 'ulong', 'float', 'double', 'decimal'],
  int: ['long', 'float', 'double', 'decimal'],
  uint: ['long', 'ulong', 'float', 'double', 'decimal'],
  long: ['float', 'double', 'decimal'],
  ulong: ['float', 'double', 'decimal'],
  char: ['ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'decimal'],
  float: ['double'],
};

export function isNumeric(type: Type): boolean {
  const special = specialOf(type);
  return special !== undefined && NUMERIC_ORDER.has(special);
}

export function isIntegral(type: Type): boolean {
  const special = specialOf(type);
  return (
    special !== undefined &&
    ['sbyte', 'byte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'char'].includes(special)
  );
}

export function isEnum(type: Type): boolean {
  return type.kind === 'named' && type.symbol.kind === 'enum';
}

export function implicitNumeric(from: SpecialType, to: SpecialType): boolean {
  return IMPLICIT_NUMERIC[from]?.includes(to) === true;
}

/** The range of values each integral type holds, for constant conversions. */
export const INTEGRAL_RANGES: Partial<Record<SpecialType, [bigint, bigint]>> = {
  sbyte: [-128n, 127n],
  byte: [0n, 255n],
  short: [-32_768n, 32_767n],
  ushort: [0n, 65_535n],
  char: [0n, 65_535n],
  int: [-2_147_483_648n, 2_147_483_647n],
  uint: [0n, 4_294_967_295n],
  long: [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n],
  ulong: [0n, 18_446_744_073_709_551_615n],
};

export class Conversions {
  constructor(private readonly types: WellKnownTypes) {}

  /** The implicit conversion from one type to another, if any, not counting conversions of constants. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  implicit(from: Type, to: Type): ConversionKind | undefined {
    if (to.kind === 'error' || from.kind === 'error' || sameType(from, to)) return 'identity';
    if (from.kind === 'null') return acceptsNullType(to) ? 'nullLiteral' : undefined;
    // `dynamic` converts as `object` does to it, and implicitly to any type, checked at run time.
    if (isDynamicType(to)) return this.implicit(from, this.types.object);
    if (isDynamicType(from))
      return sameType(to, this.types.object) ? 'reference' : isPointerType(to) ? undefined : 'dynamic';
    // Any pointer converts to `void*`; a pointer converts to nothing else implicitly, `object` included.
    if (isPointerType(from) || isPointerType(to))
      return isPointerType(from) && isVoidPointer(to) ? 'pointer' : undefined;
    if (isImplicitNumeric(from, to)) return 'numeric';
    const toUnderlying = nullableUnderlying(to);
    if (toUnderlying) {
      const conversion = this.implicitToNullable(from, toUnderlying);
      if (conversion) return conversion;
    }
    if (isValueTuple(from) && isValueTuple(to))
      return elementsConvert(from, to, (a, b) => this.implicit(a, b)) ? 'tuple' : undefined;
    return this.implicitReferenceOrBoxing(from, to);
  }

  private implicitToNullable(from: Type, toUnderlying: Type): ConversionKind | undefined {
    const fromUnderlying = nullableUnderlying(from);
    const inner = this.implicit(fromUnderlying ?? from, toUnderlying);
    if (fromUnderlying) return inner === 'identity' || inner === 'numeric' ? 'nullableLifted' : undefined;
    if (inner === 'identity') return 'nullableWrap';
    if (inner === 'numeric') return 'nullableLifted';
    return undefined;
  }

  /** The explicit conversion from one type to another that a cast performs, which includes the implicit ones. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  explicit(from: Type, to: Type): ConversionKind | undefined {
    const implicit = this.implicit(from, to);
    if (implicit) return implicit;
    if (isPointerType(from) || isPointerType(to)) {
      const isPointerOrIntegral = (type: Type): boolean =>
        isPointerType(type) || (isIntegral(type) && specialOf(type) !== 'char');
      return isPointerOrIntegral(from) && isPointerOrIntegral(to) ? 'pointer' : undefined;
    }
    const numeric = explicitNumeric(from, to);
    if (numeric) return numeric;
    const fromUnderlying = nullableUnderlying(from);
    const toUnderlying = nullableUnderlying(to);
    if (toUnderlying) {
      const inner = this.explicit(fromUnderlying ?? from, toUnderlying);
      if (keepsValue(inner)) return 'nullableLifted';
      if (inner === 'unboxing' && !fromUnderlying) return 'unboxing';
      return undefined;
    }
    if (fromUnderlying) return keepsValue(this.explicit(fromUnderlying, to)) ? 'nullableUnwrap' : undefined;
    if (isValueTuple(from) && isValueTuple(to))
      return elementsConvert(from, to, (a, b) => this.explicit(a, b)) ? 'tuple' : undefined;
    return this.explicitUnboxingOrReference(from, to);
  }

  private implicitReferenceOrBoxing(from: Type, to: Type): ConversionKind | undefined {
    if (from.kind === 'typeParameter') return this.fromTypeParameter(from.symbol, to);
    if (to.kind === 'typeParameter') return undefined;
    if (isReferenceType(from) || from.kind === 'array') {
      return this.isReferenceConvertible(from, to) ? 'reference' : undefined;
    }
    if (isValueType(from) && this.isBoxingTarget(from, to)) return 'boxing';
    return undefined;
  }

  private explicitUnboxingOrReference(from: Type, to: Type): ConversionKind | undefined {
    if (to.kind === 'typeParameter' || from.kind === 'typeParameter') return this.explicitTypeParameter(from, to);
    const isFromReference = isReferenceType(from) || from.kind === 'array';
    if (isFromReference && isValueType(to)) return this.isBoxingTarget(to, from) ? 'unboxing' : undefined;
    if (isFromReference && (isReferenceType(to) || to.kind === 'array'))
      return this.isExplicitReference(from, to) ? 'referenceCheck' : undefined;
    return undefined;
  }

  private explicitTypeParameter(from: Type, to: Type): ConversionKind | undefined {
    const converts =
      to.kind === 'typeParameter'
        ? from.kind === 'typeParameter' || isReferenceType(from) || this.isBoxingTarget(to, from)
        : isReferenceType(to) || to.kind === 'named';
    return converts ? 'typeParameterUnbox' : undefined;
  }

  /** Whether a value of type `from` is also of type `to` without changing its representation. */
  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  isReferenceConvertible(from: Type, to: Type): boolean {
    if (sameType(from, to)) return true;
    if (to.kind === 'named' && to.symbol === this.types.object.symbol) return true;
    if (from.kind === 'array') {
      if (to.kind === 'array') {
        return (
          from.rank === to.rank &&
          isReferenceType(from.element) &&
          this.isReferenceConvertible(from.element, to.element)
        );
      }
      if (to.kind === 'named' && to.symbol === this.types.array.symbol) return true;
      return (
        to.kind === 'named' &&
        ((from.rank === 1 &&
          this.types.arrayInterfaces(from.element).some((face) => this.isVariantConvertible(face, to))) ||
          // The interfaces of System.Array, such as the non-generic IEnumerable.
          allInterfacesOf(this.types.array, () => []).some((face) => sameType(face, to)))
      );
    }
    if (from.kind === 'typeParameter') return this.fromTypeParameter(from.symbol, to) !== undefined;
    if (from.kind !== 'named' || to.kind !== 'named') return false;
    if (
      from.symbol.kind === 'delegate' &&
      (to.symbol === this.types.delegate.symbol || to.symbol === this.types.multicastDelegate.symbol)
    )
      return true;
    if (to.symbol.kind === 'interface') {
      return (
        allInterfacesOf(from, (element) => this.types.arrayInterfaces(element)).some((face) =>
          this.isVariantConvertible(face, to)
        ) || this.isVariantConvertible(from, to)
      );
    }
    if (from.symbol.kind === 'delegate' && to.symbol.kind === 'delegate') return this.isVariantConvertible(from, to);
    for (let current = baseTypeOf(from); current; current = baseTypeOf(current)) {
      if (sameType(current, to)) return true;
    }
    return false;
  }

  /** Whether one constructed generic interface or delegate converts to another through the variance of its parameters. */
  private isVariantConvertible(from: NamedType, to: NamedType): boolean {
    if (from.symbol !== to.symbol) return false;
    return from.symbol.typeParameters.every((parameter, index) => {
      const a = from.args[index];
      const b = to.args[index];
      if (sameType(a, b)) return true;
      if (parameter.variance === 'out') return isReferenceType(a) && this.isReferenceConvertible(a, b);
      if (parameter.variance === 'in') return isReferenceType(b) && this.isReferenceConvertible(b, a);
      return false;
    });
  }

  /** Whether boxing a value of the value type gives a value of the reference type. */
  private isBoxingTarget(from: Type, to: Type): boolean {
    if (to.kind !== 'named' || isRefLikeType(from)) return false;
    if (to.symbol === this.types.object.symbol || to.symbol === this.types.valueType.symbol) return true;
    if (isEnumType(from) && to.symbol === this.types.enum.symbol) return true;
    if (to.symbol.kind !== 'interface') return false;
    const underlying = nullableUnderlying(from) ?? from;
    return allInterfacesOf(underlying, (element) => this.types.arrayInterfaces(element)).some((face) =>
      this.isVariantConvertible(face, to)
    );
  }

  private fromTypeParameter(parameter: TypeParameterSymbol, to: Type): ConversionKind | undefined {
    if (to.kind === 'named' && to.symbol === this.types.object.symbol) return 'typeParameterBox';
    if (to.kind === 'typeParameter' && to.symbol === parameter) return 'identity';
    for (const constraint of parameter.constraintTypes) {
      if (constraint.kind === 'typeParameter') {
        if (this.fromTypeParameter(constraint.symbol, to)) return 'typeParameterBox';
      } else if (
        sameType(constraint, to) ||
        this.isReferenceConvertible(constraint, to) ||
        (isValueType(constraint) && this.isBoxingTarget(constraint, to))
      ) {
        return 'typeParameterBox';
      }
    }
    if (parameter.hasValueConstraint && to.kind === 'named' && to.symbol === this.types.valueType.symbol)
      return 'typeParameterBox';
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
  private isExplicitReference(from: Type, to: Type): boolean {
    if (this.isReferenceConvertible(to, from)) return true;
    if (from.kind === 'named' && to.kind === 'named') {
      // Between interfaces and non-sealed classes, a cast may succeed on a value of a derived type.
      if (from.symbol.kind === 'interface' && !(to.symbol.isSealed && !this.isReferenceConvertible(to, from)))
        return to.symbol.kind !== 'struct';
      if (to.symbol.kind === 'interface' && !from.symbol.isSealed) return true;
      if (from.symbol.kind === 'interface' && to.symbol.kind === 'interface') return true;
    }
    if (from.kind === 'array' && to.kind === 'array') {
      return (
        from.rank === to.rank &&
        isReferenceType(from.element) &&
        isReferenceType(to.element) &&
        this.isExplicitReference(from.element, to.element)
      );
    }
    if (from.kind === 'named' && from.symbol === this.types.array.symbol && to.kind === 'array') return true;
    if (from.kind === 'named' && from.symbol.kind === 'interface' && to.kind === 'array') return true;
    return false;
  }
}

function isEnumType(type: Type): boolean {
  return type.kind === 'named' && type.symbol.kind === 'enum';
}

function acceptsNullType(type: Type): boolean {
  return isReferenceType(type) || nullableUnderlying(type) !== undefined || type.kind === 'array';
}

function isImplicitNumeric(from: Type, to: Type): boolean {
  const fromSpecial = specialOf(from);
  const toSpecial = specialOf(to);
  return fromSpecial !== undefined && toSpecial !== undefined && implicitNumeric(fromSpecial, toSpecial);
}

function isValueTuple(type: Type): type is NamedType {
  return type.kind === 'named' && specialOf(type) === 'valueTuple';
}

function elementsConvert(
  from: NamedType,
  to: NamedType,
  convert: (from: Type, to: Type) => ConversionKind | undefined
): boolean {
  return (
    from.args.length === to.args.length && from.args.every((arg, index) => convert(arg, to.args[index]) !== undefined)
  );
}

/** The explicit conversion between numeric and enum types, which C# allows in both directions. */
function explicitNumeric(from: Type, to: Type): ConversionKind | undefined {
  if (!(isNumeric(from) || isEnum(from)) || !(isNumeric(to) || isEnum(to))) return undefined;
  if (specialOf(from) !== undefined && specialOf(to) !== undefined && !isEnum(from) && !isEnum(to)) return 'numeric';
  return 'enumNumeric';
}

function keepsValue(conversion: ConversionKind | undefined): boolean {
  return conversion === 'identity' || conversion === 'numeric' || conversion === 'enumNumeric';
}
