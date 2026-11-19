import type { Designation, Pattern, Position, Subpattern } from './ast';
import type { BoundExpression, BoundPattern, OperandKind } from './bound';
import { isEnum, isNumeric } from './conversions';
import type { BindContext } from './convertBinder';
import { ExpressionBinder } from './expressionBinder';
import {
  displayType,
  ERROR_TYPE,
  type FieldSymbol,
  type LocalSymbol,
  type MethodSymbol,
  type NamedType,
  nullableUnderlying,
  type PropertySymbol,
  sameType,
  specialOf,
  substitute,
  substitutionOf,
  type Type,
} from './types';

/** Binds patterns, checking that each can match its input's type. */
export abstract class PatternBinder extends ExpressionBinder {
  // code-gauge-allow functionNcss 40 -- One case per kind of pattern.
  bindPattern(pattern: Pattern, inputType: Type, context: BindContext): BoundPattern {
    switch (pattern.kind) {
      case 'constantPattern': {
        return this.bindConstantPattern(pattern, inputType, context);
      }
      case 'declarationPattern': {
        const type = this.resolveType(pattern.type, context.fn.typeContext);
        this.checkPatternType(type, inputType, pattern);
        return {
          kind: 'type',
          testType: type,
          local: this.patternVariable(pattern.designation, type, context),
          inputType,
        };
      }
      case 'typePattern': {
        const type = this.resolveType(pattern.type, context.fn.typeContext);
        this.checkPatternType(type, inputType, pattern);
        return { kind: 'type', testType: type, local: undefined, inputType };
      }
      case 'varPattern': {
        if (pattern.designation.kind === 'parenthesized')
          return this.bindVarDeconstruction(pattern.designation, inputType, context);
        return { kind: 'any', local: this.patternVariable(pattern.designation, inputType, context), inputType };
      }
      case 'discardPattern': {
        return { kind: 'any', local: undefined, inputType };
      }
      case 'relationalPattern': {
        return this.bindRelationalPattern(pattern, inputType, context);
      }
      case 'notPattern': {
        const saved = this.noPatternVariables;
        this.noPatternVariables = true;
        try {
          return { kind: 'not', pattern: this.bindPattern(pattern.pattern, inputType, context), inputType };
        } finally {
          this.noPatternVariables = saved;
        }
      }
      case 'andPattern': {
        const left = this.bindPattern(pattern.left, inputType, context);
        const narrowed = this.narrowedType(left, inputType);
        return { kind: 'and', left, right: this.bindPattern(pattern.right, narrowed, context), inputType };
      }
      case 'orPattern': {
        const saved = this.noPatternVariables;
        this.noPatternVariables = true;
        try {
          return {
            kind: 'or',
            left: this.bindPattern(pattern.left, inputType, context),
            right: this.bindPattern(pattern.right, inputType, context),
            inputType,
          };
        } finally {
          this.noPatternVariables = saved;
        }
      }
      case 'recursivePattern': {
        return this.bindRecursivePattern(pattern, inputType, context);
      }
    }
  }

  /** Set inside `not` and `or`, where a pattern may not declare variables. */
  private noPatternVariables = false;

  private patternVariable(designation: Designation, type: Type, context: BindContext): LocalSymbol | undefined {
    if (designation.kind !== 'single') return undefined;
    if (this.noPatternVariables) {
      this.error(designation, 'CS8780', "'not' または 'or' パターン内で変数を宣言することはできません。");
      return undefined;
    }
    return this.declareLocal(designation.name, type, designation, context);
  }

  /** The type a pattern narrows its input to, which `and` passes to its right side. */
  private narrowedType(pattern: BoundPattern, inputType: Type): Type {
    if (pattern.kind === 'type') return pattern.testType;
    if (pattern.kind === 'recursive') return pattern.narrowedType;
    return inputType;
  }

  /** A pattern's value that is no constant: Roslyn names the type it expects unless the input is `object`. */
  private reportNotConstant(pattern: Position, inputType: Type): void {
    const target = nullableUnderlying(inputType) ?? inputType;
    if (specialOf(target) === 'object' || target.kind === 'typeParameter')
      this.error(pattern, 'CS0150', '定数値が必要です');
    else this.error(pattern, 'CS9135', `型 '${displayType(target)}' の定数値が必要です`);
  }

  private checkPatternType(type: Type, inputType: Type, position: Position): void {
    if (type.kind === 'error' || inputType.kind === 'error') return;
    if (type.kind === 'named' && type.symbol.special === 'nullable') {
      this.error(
        position,
        'CS8116',
        `パターンで Null 許容型 '${displayType(type)}' を使用することはできません。代わりに基になる型 '${displayType(type.args[0])}' をご使用ください。`
      );
      return;
    }
    const input = nullableUnderlying(inputType) ?? inputType;
    if (this.isTypeTestOperator) return;
    if (!this.conversions.explicit(input, type) && !this.conversions.explicit(inputType, type)) {
      this.error(
        position,
        'CS8121',
        `種類 '${displayType(inputType)}' の式は、種類 '${displayType(type)}' のパターンで処理することができません。`
      );
    }
  }

  private bindConstantPattern(
    pattern: Extract<Pattern, { kind: 'constantPattern' }>,
    inputType: Type,
    context: BindContext
  ): BoundPattern {
    const bound = this.bindExpression(pattern.value, context);
    if (bound.kind === 'typeRef') {
      this.checkPatternType(bound.type, inputType, pattern);
      return { kind: 'type', testType: bound.type, local: undefined, inputType };
    }
    const value = this.toValue(bound, pattern);
    if (value.type.kind === 'null') {
      if (
        inputType.kind !== 'error' &&
        !this.isReference(inputType) &&
        !nullableUnderlying(inputType) &&
        inputType.kind !== 'typeParameter'
      ) {
        this.error(
          pattern,
          'CS0037',
          `Null 非許容の値型であるため、Null を '${displayType(inputType)}' に変換できません`
        );
      }
      return { kind: 'constant', value, inputType, type: inputType };
    }
    if (value.type.kind === 'error') return { kind: 'constant', value, inputType, type: ERROR_TYPE };
    if (value.kind !== 'constant') {
      this.reportNotConstant(pattern, inputType);
      return { kind: 'constant', value, inputType, type: ERROR_TYPE };
    }
    const target = nullableUnderlying(inputType) ?? inputType;
    // Against `object`, an interface, or a type parameter, a constant tests the input's type and keeps its own,
    // so `(object)1 is 1` holds while `(object)1L is 1` does not.
    if (
      specialOf(target) === 'object' ||
      target.kind === 'typeParameter' ||
      (target.kind === 'named' && target.symbol.kind === 'interface')
    ) {
      return { kind: 'constant', value, inputType, type: value.type };
    }
    if (this.implicitConversionOf(value, target))
      return { kind: 'constant', value: this.convert(value, target, pattern), inputType, type: target };
    this.error(
      pattern,
      'CS0029',
      `型 '${displayType(value.type, true)}' を '${displayType(inputType, true)}' に暗黙的に変換できません`
    );
    return { kind: 'constant', value, inputType, type: ERROR_TYPE };
  }

  private bindRelationalPattern(
    pattern: Extract<Pattern, { kind: 'relationalPattern' }>,
    inputType: Type,
    context: BindContext
  ): BoundPattern {
    const value = this.bindValue(pattern.value, context);
    const target = nullableUnderlying(inputType) ?? inputType;
    if (value.type.kind === 'error' || target.kind === 'error')
      return { kind: 'relational', operator: pattern.operator, value, operandKind: 'int', inputType };
    if (value.kind !== 'constant') {
      this.reportNotConstant(pattern, inputType);
      return { kind: 'relational', operator: pattern.operator, value, operandKind: 'int', inputType };
    }
    const comparedType = isNumeric(target) || isEnum(target) ? target : value.type;
    if (!isNumeric(comparedType) && !isEnum(comparedType)) {
      this.error(
        pattern,
        'CS8781',
        `リレーショナル パターンは、'${displayType(comparedType)}' 型の値に使用することはできません。`
      );
      return { kind: 'relational', operator: pattern.operator, value, operandKind: 'int', inputType };
    }
    const converted = this.convert(value, comparedType, pattern);
    return {
      kind: 'relational',
      operator: pattern.operator,
      value: converted,
      operandKind: operandKindOf(comparedType),
      inputType,
    };
  }

  private bindVarDeconstruction(
    designation: Extract<Designation, { kind: 'parenthesized' }>,
    inputType: Type,
    context: BindContext
  ): BoundPattern {
    const { elementTypes, deconstruct } = this.deconstructionOf(
      inputType,
      designation.elements.length,
      undefined,
      designation
    );
    const positional = designation.elements.map((element, index): BoundPattern => {
      const type = elementTypes[index] ?? ERROR_TYPE;
      if (element.kind === 'parenthesized') return this.bindVarDeconstruction(element, type, context);
      return { kind: 'any', local: this.patternVariable(element, type, context), inputType: type };
    });
    return {
      kind: 'recursive',
      testType: undefined,
      inputType,
      narrowedType: inputType,
      deconstruct,
      isTuple: deconstruct === undefined,
      positional,
      properties: [],
      local: undefined,
    };
  }

  private bindRecursivePattern(
    pattern: Extract<Pattern, { kind: 'recursivePattern' }>,
    inputType: Type,
    context: BindContext
  ): BoundPattern {
    const testType = pattern.type ? this.resolveType(pattern.type, context.fn.typeContext) : undefined;
    if (testType) this.checkPatternType(testType, inputType, pattern);
    const narrowed = testType ?? nullableUnderlying(inputType) ?? inputType;
    let positional: BoundPattern[] = [];
    let deconstruct: MethodSymbol | undefined;
    let isTuple = false;
    if (pattern.positional) {
      const result = this.deconstructionOf(narrowed, pattern.positional.length, undefined, pattern);
      deconstruct = result.deconstruct;
      isTuple = deconstruct === undefined;
      positional = pattern.positional.map((sub, index) =>
        this.bindPattern(sub.pattern, result.elementTypes[index] ?? ERROR_TYPE, context)
      );
    }
    const properties = (pattern.properties ?? []).map((sub) => this.bindPropertySubpattern(sub, narrowed, context));
    const local = pattern.designation ? this.patternVariable(pattern.designation, narrowed, context) : undefined;
    return {
      kind: 'recursive',
      testType,
      inputType,
      narrowedType: narrowed,
      deconstruct,
      isTuple,
      positional,
      properties,
      local,
    };
  }

  private bindPropertySubpattern(
    sub: Subpattern,
    type: Type,
    context: BindContext
  ): BoundPattern extends never ? never : Extract<BoundPattern, { kind: 'recursive' }>['properties'][number] {
    const members: (FieldSymbol | PropertySymbol)[] = [];
    const owners: NamedType[] = [];
    let current = type;
    for (const name of sub.names ?? []) {
      const { found, inaccessible } = this.lookupMember(current, name, context.fn.typeContext);
      if (!found || (found.kind !== 'field' && found.kind !== 'property')) {
        if (inaccessible) this.reportInaccessible(inaccessible, sub);
        else this.error(sub, 'CS0117', `'${displayType(current)}' に '${name}' の定義がありません`);
        return { members: [], owners: [], pattern: this.bindPattern(sub.pattern, ERROR_TYPE, context) };
      }
      const member = found.kind === 'field' ? found.field : found.property;
      members.push(member);
      owners.push(found.owner);
      current = substitute(member.type, substitutionOf(found.owner));
    }
    return { members, owners, pattern: this.bindPattern(sub.pattern, current, context) };
  }

  /** Whether a pattern matches every value of its input type, which makes later cases unreachable. */
  isIrrefutable(pattern: BoundPattern, inputType: Type): boolean {
    switch (pattern.kind) {
      case 'any': {
        return true;
      }
      case 'type': {
        return !this.isReference(inputType) && !nullableUnderlying(inputType) && sameType(pattern.testType, inputType);
      }
      case 'or': {
        return this.isIrrefutable(pattern.left, inputType) || this.isIrrefutable(pattern.right, inputType);
      }
      case 'and': {
        return this.isIrrefutable(pattern.left, inputType) && this.isIrrefutable(pattern.right, inputType);
      }
      case 'recursive': {
        return (
          pattern.testType === undefined &&
          !this.isReference(inputType) &&
          !nullableUnderlying(inputType) &&
          pattern.positional.every((sub) => this.isIrrefutable(sub, sub.inputType)) &&
          pattern.properties.every((sub) => this.isIrrefutable(sub.pattern, sub.pattern.inputType))
        );
      }
      default: {
        return false;
      }
    }
  }

  /** The constant a pattern compares with, for duplicate case labels. */
  constantOfPattern(pattern: BoundPattern): BoundExpression | undefined {
    return pattern.kind === 'constant' && pattern.value.kind === 'constant' ? pattern.value : undefined;
  }
}

function operandKindOf(type: Type): OperandKind {
  if (isEnum(type)) return 'enum';
  const special = specialOf(type);
  if (
    special === 'uint' ||
    special === 'long' ||
    special === 'ulong' ||
    special === 'float' ||
    special === 'double' ||
    special === 'decimal'
  )
    return special;
  return 'int';
}
