import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { named, numberValue, skipParentheses } from './syntax';
import {
  anyType,
  bigintType,
  booleanType,
  errorType,
  freshLiteralType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  literalType,
  mapType,
  neverType,
  numberType,
  type Property,
  regularOf,
  stringType,
  symbolType,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

const typeofResult = unionOf(
  ['string', 'number', 'bigint', 'boolean', 'symbol', 'undefined', 'object', 'function'].map((name) =>
    literalType(name)
  )
);

/** Checks unary, binary, ternary, and type assertion expressions. */
export class OperatorChecker {
  constructor(private readonly c: Checker) {}

  unary(node: TreeNode): Type {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const argument = node.childForFieldName('argument') as TreeNode;
    switch (operator) {
      case '!': {
        // An operand that is always truthy gives `false`, and one always falsy gives `true`.
        const { type } = this.c.conditions.condition(argument);
        if (isAnyLike(type)) return booleanType;
        if (isIntrinsic(this.c.flow.narrowByTruthiness(type, false), 'never')) return freshLiteralType(false);
        if (isIntrinsic(this.c.flow.narrowByTruthiness(type, true), 'never')) return freshLiteralType(true);
        return booleanType;
      }
      case 'typeof': {
        this.c.expressions.check(argument);
        return typeofResult;
      }
      case 'void': {
        this.c.expressions.check(argument);
        return undefinedType;
      }
      case 'delete': {
        this.checkDelete(argument);
        return booleanType;
      }
      case '-':
      case '+':
      case '~': {
        return this.numericUnary(operator, argument);
      }
      default: {
        this.c.expressions.check(argument);
        return anyType;
      }
    }
  }

  /** `-x`, `+x`, or `~x`, which convert their operand to a number, or keep a bigint for `-` and `~`. */
  private numericUnary(operator: string, argument: TreeNode): Type {
    const type = this.c.expressions.check(argument);
    if (argument.type === 'number' && operator === '-') {
      const value = numberValue(argument.text);
      return freshLiteralType(typeof value === 'bigint' ? -value : -value);
    }
    if (!this.checkNonNullOperand(argument, type)) return numberType;
    // TypeScript rejects a numeric unary operator on a value that may be a symbol, even through a constraint.
    if (this.maySymbol(type)) {
      this.c.error(argument, `演算子 '${operator}' は型 'symbol' には使えません。`);
      return numberType;
    }
    if (operator === '+') {
      if (this.isBigintLike(type)) this.c.error(argument, "演算子 '+' は型 'bigint' には使えません。");
      return numberType;
    }
    return this.isBigintLike(type) ? bigintType : numberType;
  }

  /**
   * Reports an operand that is `unknown` or may be `null` or `undefined`, through its constraint too, returning whether
   * the operator still gives its usual type.
   */
  private checkNonNullOperand(argument: TreeNode, type: Type): boolean {
    if (isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined')) {
      this.c.error(argument, `値 '${this.c.print(type)}' はここでは使えません。`);
      return false;
    }
    if (isIntrinsic(type, 'unknown')) {
      this.c.members.checkNonNullable(argument, type);
      return false;
    }
    const constraint = this.c.baseConstraint(type);
    if (!isAnyLike(constraint) && this.c.relations.isNullable(constraint))
      this.c.members.checkNonNullable(argument, constraint);
    return true;
  }

  private maySymbol(type: Type): boolean {
    if (isAnyLike(type)) return false;
    const constraint = this.c.baseConstraint(type);
    const members = constraint.kind === 'union' ? constraint.types : [constraint];
    return members.some((member) => !isAnyLike(member) && this.c.relations.isAssignable(member, symbolType));
  }

  private checkDelete(argument: TreeNode): void {
    const expression = skipParentheses(argument);
    this.c.expressions.check(expression);
    if (expression.type !== 'member_expression' && expression.type !== 'subscript_expression') {
      this.c.error(argument, 'delete 演算子のオペランドは、プロパティへの参照でなければいけません。');
      return;
    }
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const objectType = this.c.silently(() => this.c.expressions.check(objectNode));
    const index = expression.type === 'subscript_expression' ? expression.childForFieldName('index') : undefined;
    const indexType = index ? this.c.silently(() => this.c.expressions.check(index)) : undefined;
    const name =
      expression.type === 'member_expression'
        ? expression.childForFieldName('property')?.text
        : indexType?.kind === 'literal'
          ? String(indexType.value)
          : undefined;
    if (isAnyLike(objectType)) return;
    const members = objectType.kind === 'union' ? objectType.types : [objectType];
    if (members.some((member) => this.readonlyDeleteTarget(member, name, indexType))) {
      this.c.error(argument, 'delete 演算子のオペランドは、読み取り専用のプロパティにはできません。');
      return;
    }
    const properties = members
      .map((member) => (name === undefined ? undefined : this.c.propertyOf(member, name)))
      .filter((property): property is Property => property !== undefined);
    const type = unionOf(properties.map((property) => property.type()));
    if (
      properties.length > 0 &&
      properties.every((property) => !property.optional) &&
      !isAnyLike(type) &&
      !isIntrinsic(type, 'unknown') &&
      !this.c.relations.isNullable(type)
    )
      this.c.error(argument, 'delete 演算子のオペランドは、省略できるプロパティでなければいけません。');
  }

  private readonlyDeleteTarget(objectType: Type, name: string | undefined, indexType: Type | undefined): boolean {
    const property = name === undefined ? undefined : this.c.propertyOf(objectType, name);
    if (property) return property.readonly === true;
    return this.c.members.isReadonlyIndex(objectType, indexType ?? literalType(name ?? ''));
  }

  isNumberLike(type: Type): boolean {
    const regular = regularOf(type);
    if (isAnyLike(regular) || regular === errorType) return true;
    return this.c.relations.isAssignable(regular, numberType) && !isIntrinsic(regular, 'never');
  }

  isBigintLike(type: Type): boolean {
    const regular = regularOf(type);
    return !isAnyLike(regular) && !isIntrinsic(regular, 'never') && this.c.relations.isAssignable(regular, bigintType);
  }

  private isStringLike(type: Type): boolean {
    const regular = regularOf(type);
    return !isAnyLike(regular) && !isIntrinsic(regular, 'never') && this.c.relations.isAssignable(regular, stringType);
  }

  binary(node: TreeNode, contextual?: Type): Type {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    switch (operator) {
      case '&&':
      case '||':
      case '??': {
        return this.logical(node, operator, left, right, contextual);
      }
      case 'instanceof': {
        return this.instanceofExpression(left, right);
      }
      case 'in': {
        return this.inExpression(left, right);
      }
      default: {
        break;
      }
    }
    const leftType = this.c.expressions.check(left);
    const rightType = this.c.expressions.check(right);
    return this.binaryOperatorType(node, operator, left, right, leftType, rightType);
  }

  binaryOperatorType(
    node: TreeNode,
    operator: string,
    left: TreeNode,
    right: TreeNode,
    leftType: Type,
    rightType: Type
  ): Type {
    if (leftType === errorType || rightType === errorType) return errorType;
    switch (operator) {
      case '===':
      case '!==':
      case '==':
      case '!=': {
        this.checkEqualitySyntax(node, operator, left, right);
        this.checkComparisonOverlap(node, operator, leftType, rightType);
        return booleanType;
      }
      case '<':
      case '>':
      case '<=':
      case '>=': {
        if (!this.checkNullishOperands(left, right, leftType, rightType)) return booleanType;
        const l = this.baseOfLiterals(this.c.relations.removeNullish(leftType));
        const r = this.baseOfLiterals(this.c.relations.removeNullish(rightType));
        // Both operands are numbers, or neither is and they are comparable, as `string | number >= 1` is not.
        const leftNumeric = this.isNumberLike(l) || this.isBigintLike(l);
        const rightNumeric = this.isNumberLike(r) || this.isBigintLike(r);
        const ok =
          isAnyLike(l) ||
          isAnyLike(r) ||
          (leftNumeric && rightNumeric) ||
          (!leftNumeric && !rightNumeric && this.c.relations.isComparable(l, r));
        if (!ok) this.reportOperator(node, operator, leftType, rightType);
        return booleanType;
      }
      case '+': {
        return this.plus(node, left, right, leftType, rightType);
      }
      default: {
        return this.arithmetic(node, operator, left, right, leftType, rightType);
      }
    }
  }

  /** A type with its literals, fresh or not, replaced by their primitives. */
  private baseOfLiterals(type: Type): Type {
    return mapType(type, (member) => {
      if (member.kind !== 'literal') return member;
      if (typeof member.value === 'boolean') return booleanType;
      return typeof member.value === 'string' ? stringType : typeof member.value === 'number' ? numberType : bigintType;
    });
  }

  private plus(node: TreeNode, left: TreeNode, right: TreeNode, leftType: Type, rightType: Type): Type {
    for (const [operand, type] of [
      [left, leftType],
      [right, rightType],
    ] as const) {
      if (this.c.expressions.isSymbolLike(type)) {
        this.c.error(operand, "演算子 '+' は 'symbol' 型には使えません。");
        return errorType;
      }
    }
    if (this.isStringLike(leftType) || this.isStringLike(rightType)) {
      this.c.expressions.checkFunctionText(left, leftType);
      this.c.expressions.checkFunctionText(right, rightType);
      return stringType;
    }
    if (isAnyLike(leftType) || isAnyLike(rightType)) return anyType;
    if (!this.checkNullishOperands(left, right, leftType, rightType)) return numberType;
    const l = this.c.relations.removeNullish(leftType);
    const r = this.c.relations.removeNullish(rightType);
    if (this.isNumberLike(l) && this.isNumberLike(r)) return numberType;
    if (this.isBigintLike(l) && this.isBigintLike(r)) return bigintType;
    this.reportOperator(node, '+', leftType, rightType);
    return errorType;
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Follows TypeScript's checks of arithmetic operands, bigint included.
  private arithmetic(
    node: TreeNode,
    operator: string,
    left: TreeNode,
    right: TreeNode,
    leftType: Type,
    rightType: Type
  ): Type {
    if (!this.checkNullishOperands(left, right, leftType, rightType)) return numberType;
    const l = this.c.relations.removeNullish(leftType);
    const r = this.c.relations.removeNullish(rightType);
    const leftOk = this.isNumberLike(l) || this.isBigintLike(l);
    const rightOk = this.isNumberLike(r) || this.isBigintLike(r);
    if (!leftOk)
      this.c.error(left, '算術演算の左辺は、any 型、number 型、bigint 型、列挙型のいずれかでなければいけません。');
    if (!rightOk)
      this.c.error(right, '算術演算の右辺は、any 型、number 型、bigint 型、列挙型のいずれかでなければいけません。');
    if (!leftOk || !rightOk) return numberType;
    if (isAnyLike(l) || isAnyLike(r))
      return isAnyLike(l) && isAnyLike(r)
        ? numberType
        : this.isBigintLike(l) || this.isBigintLike(r)
          ? bigintType
          : numberType;
    const leftBig = this.isBigintLike(l);
    const rightBig = this.isBigintLike(r);
    if (leftBig !== rightBig) {
      this.reportOperator(node, operator, leftType, rightType);
      return errorType;
    }
    if (leftBig && operator === '>>>') {
      this.c.error(node, "演算子 '>>>' は型 'bigint' には使えません。");
    }
    return leftBig ? bigintType : numberType;
  }

  /** Reports operands that are or may be `null` or `undefined`, returning whether both are usable. */
  private checkNullishOperands(left: TreeNode, right: TreeNode, leftType: Type, rightType: Type): boolean {
    let ok = true;
    for (const [operand, type] of [
      [left, leftType],
      [right, rightType],
    ] as const) {
      if (isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined')) {
        this.c.error(operand, `値 '${this.c.print(type)}' はここでは使えません。`);
        ok = false;
      } else if (!isAnyLike(type) && this.c.relations.isNullable(type)) {
        this.c.members.checkNonNullable(operand, type);
        ok = false;
      }
    }
    return ok;
  }

  private reportOperator(node: TreeNode, operator: string, leftType: Type, rightType: Type): void {
    this.c.error(
      node,
      `演算子 '${operator}' は型 '${this.c.print(this.c.widenLiteral(leftType))}' と型 '${this.c.print(this.c.widenLiteral(rightType))}' には使えません。`
    );
  }

  private checkEqualitySyntax(node: TreeNode, operator: string, left: TreeNode, right: TreeNode): void {
    const operands = [left, right].map(skipParentheses);
    const literal = [left, right].some((operand) => operand.type === 'array' || operand.type === 'object');
    const nan = operands.some((operand) => {
      if (operand.type === 'identifier' && operand.text === 'NaN')
        return (
          this.c.scopeOf(operand).lookupValue('NaN')?.valueDeclaration !== undefined &&
          this.c.isLibrary(this.c.scopeOf(operand).lookupValue('NaN')!.valueDeclaration!)
        );
      return false;
    });
    if (literal || nan)
      this.c.error(node, `この条件は常に '${operator === '!=' || operator === '!==' ? 'true' : 'false'}' になります。`);
  }

  private checkComparisonOverlap(node: TreeNode, operator: string, leftType: Type, rightType: Type): void {
    const l = regularOf(leftType);
    const r = regularOf(rightType);
    if (isAnyLike(l) || isAnyLike(r)) return;
    if (isNullishIntrinsic(l) || isNullishIntrinsic(r)) return;
    if (this.c.relations.isComparable(this.comparableForm(l), this.comparableForm(r))) return;
    this.c.error(
      node,
      `この比較は意図したものではないようです。型 '${this.c.print(l)}' と型 '${this.c.print(r)}' には重なりがありません。`
    );
  }

  /** A type with `null` and `undefined` removed, which comparisons always allow. */
  private comparableForm(type: Type): Type {
    const removed = this.c.relations.removeNullish(type);
    return isIntrinsic(removed, 'never') ? type : removed;
  }

  private logical(node: TreeNode, operator: string, left: TreeNode, right: TreeNode, contextual?: Type): Type {
    if (operator === '??') {
      const nullishness = syntacticNullishness(left);
      if (nullishness === 'never')
        this.c.error(
          left,
          '左のオペランドが null や undefined になることはないので、?? の右のオペランドは使われません。'
        );
      if (nullishness === 'always') this.c.error(left, 'この式は常に null か undefined です。');
      // A left optional chain that stops early is nullish, so the right operand runs there too.
      const { result: leftType, stops } = this.c.members.stoppingChain(skipParentheses(left), () =>
        this.c.expressions.check(left, contextual)
      );
      // The right operand runs only when the left one is nullish, so its effects join the path that skips it.
      const { whenTrue: skipped, whenFalse: nullish } = this.c.conditions.presence(left);
      let rightType: Type = neverType;
      const after = this.c.flow.from(this.c.flow.merge([nullish, ...stops]), () => {
        rightType = this.c.expressions.check(right, contextual);
      });
      this.c.flow.current = this.c.flow.merge([skipped, after]);
      return this.coalescingType(leftType, rightType);
    }
    const { whenTrue, whenFalse, type: leftType } = this.c.conditions.condition(left);
    const rightState = operator === '&&' ? whenTrue : whenFalse;
    let rightType: Type = neverType;
    const after = this.c.flow.from(rightState, () => {
      rightType = this.c.expressions.check(right, contextual ?? leftType);
    });
    this.c.flow.current = this.c.flow.merge([operator === '&&' ? whenFalse : whenTrue, after]);
    void node;
    if (operator === '&&') return unionOf([this.c.flow.narrowByTruthiness(leftType, false), rightType], true);
    return this.c.literals.subtypeReduced([this.c.flow.narrowByTruthiness(leftType, true), rightType]);
  }

  private coalescingType(left: Type, right: Type): Type {
    const constraint = this.nullishConstraint(left);
    if (!this.c.relations.isNullable(constraint) && !isAnyLike(constraint) && !isIntrinsic(constraint, 'unknown'))
      return left;
    const nonNullish = mapType(left, (member): Type => {
      if (member.kind !== 'typeParameter') return this.c.relations.removeNullish(member);
      const bound = this.nullishConstraint(member);
      return isAnyLike(bound) ? member : intersectionOf([member, this.c.relations.removeNullish(bound)], this.c.budget);
    });
    return this.c.literals.subtypeReduced([nonNullish, right]);
  }

  private nullishConstraint(type: Type, seen = new Set<number>()): Type {
    this.c.budget.spend();
    if (seen.has(type.id)) return unknownType;
    seen.add(type.id);
    try {
      if (type.kind === 'typeParameter') {
        const constraint = this.c.constraintOf(type);
        return constraint ? this.nullishConstraint(constraint, seen) : unknownType;
      }
      if (type.kind === 'union') return unionOf(type.types.map((member) => this.nullishConstraint(member, seen)));
      if (type.kind === 'conditional')
        return unionOf([this.nullishConstraint(type.trueType, seen), this.nullishConstraint(type.falseType, seen)]);
      if (type.kind === 'indexedAccess') {
        const constraint = this.c.baseConstraint(type);
        return constraint.kind === 'indexedAccess' ? unknownType : this.nullishConstraint(constraint, seen);
      }
      if (type.kind === 'intersection')
        return intersectionOf(
          type.types.map((member) => this.nullishConstraint(member, seen)),
          this.c.budget
        );
      return type;
    } finally {
      seen.delete(type.id);
    }
  }

  private instanceofExpression(left: TreeNode, right: TreeNode): Type {
    const leftType = this.c.expressions.check(left);
    const rightType = this.c.expressions.check(right);
    const l = regularOf(leftType);
    if (
      !isAnyLike(l) &&
      !isIntrinsic(l, 'unknown') &&
      (l.kind === 'literal' || (l.kind === 'intrinsic' && l.name !== 'object'))
    ) {
      this.c.error(left, 'instanceof の左辺は、any 型、オブジェクト型、型パラメーターのいずれかでなければいけません。');
    }
    if (
      !isAnyLike(rightType) &&
      this.c.signaturesOf(rightType, 'construct').length === 0 &&
      this.c.signaturesOf(rightType, 'call').length === 0 &&
      !this.c.relations.isAssignable(rightType, this.c.globalType('Function'))
    ) {
      this.c.error(right, 'instanceof の右辺は、any 型か、Function 型に代入できる型でなければいけません。');
    }
    return booleanType;
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Follows TypeScript's checks of both operands of `in`.
  private inExpression(left: TreeNode, right: TreeNode): Type {
    const leftType = left.type === 'private_property_identifier' ? stringType : this.c.expressions.check(left);
    const rightType = this.c.expressions.check(right);
    if (
      !isAnyLike(leftType) &&
      !this.c.relations.isAssignable(leftType, unionOf([stringType, numberType, this.c.globalType('Symbol')])) &&
      !isIntrinsic(regularOf(leftType), 'symbol')
    ) {
      this.c.error(left, "in の左辺は、'string'、'number'、'symbol'、'any' のいずれかの型でなければいけません。");
    }
    const r = regularOf(rightType);
    if (
      !isAnyLike(r) &&
      (r.kind === 'literal' ||
        (r.kind === 'intrinsic' && r.name !== 'object' && r.name !== 'unknown') ||
        (r.kind === 'union' &&
          r.types.some(
            (member) => member.kind === 'literal' || (member.kind === 'intrinsic' && member.name !== 'object')
          )))
    ) {
      if (
        this.c.relations.isNullable(r) &&
        !isIntrinsic(this.c.relations.removeNullish(r), 'never') &&
        !this.c.relations.removeNullish(r).kind.startsWith('lit')
      )
        this.c.members.checkNonNullable(right, r);
      else this.c.error(right, 'in の右辺は、プリミティブ型であってはいけません。');
    } else if (isIntrinsic(r, 'unknown')) {
      this.c.error(
        right,
        this.c.members.isEntityName(right)
          ? `'${right.text}' の型は 'unknown' です。`
          : "オブジェクトの型は 'unknown' です。"
      );
    }
    return booleanType;
  }

  ternary(node: TreeNode, contextual?: Type): Type {
    const condition = node.childForFieldName('condition') as TreeNode;
    const consequence = node.childForFieldName('consequence') as TreeNode;
    const alternative = node.childForFieldName('alternative') as TreeNode;
    const { whenTrue, whenFalse } = this.c.conditions.condition(condition);
    this.c.conditions.checkUncalledFunction(condition, consequence);
    let trueType: Type = neverType;
    let falseType: Type = neverType;
    const afterTrue = this.c.flow.from(whenTrue, () => {
      trueType = this.c.expressions.check(consequence, contextual);
    });
    const afterFalse = this.c.flow.from(whenFalse, () => {
      falseType = this.c.expressions.check(alternative, contextual);
    });
    this.c.flow.current = this.c.flow.merge([afterTrue, afterFalse]);
    return this.c.literals.subtypeReduced([trueType, falseType]);
  }

  assertion(node: TreeNode): Type {
    const expression = node.type === 'type_assertion' ? (named(node).at(-1) as TreeNode) : named(node)[0];
    const typeNode = node.type === 'type_assertion' ? named(named(node)[0])[0] : named(node)[1];
    if (!typeNode || node.children.some((child) => child?.type === 'const') || typeNode.text === 'const') {
      const operand = skipParentheses(expression);
      const signedLiteral =
        operand.type === 'unary_expression' &&
        ['+', '-'].includes(operand.childForFieldName('operator')?.text ?? '') &&
        named(operand)[0]?.type === 'number';
      if (
        !['string', 'number', 'true', 'false', 'object', 'array', 'template_string'].includes(operand.type) &&
        !signedLiteral
      )
        this.c.error(node, 'const アサーションは、リテラル式にのみ使えます。');
      return regularOf(this.c.expressions.check(expression));
    }
    const target = this.c.typeNodes.typeFromNode(typeNode);
    const source = this.c.expressions.check(expression, target);
    const widened = this.c.widen(source);
    if (!this.c.relations.isRelated(target, widened, 'comparable')) {
      const reported = this.c.diagnostics.length;
      this.c.expressions.checkAssertedArrayLiterals(expression, source, target);
      if (this.c.diagnostics.length > reported) {
        // TypeScript stops comparing at the first excess property.
        this.c.diagnostics.splice(reported + 1);
        return target;
      }
    }
    if (
      !this.c.relations.isComparable(widened, target) &&
      !this.c.relations.isAssignable(target, widened) &&
      !this.c.relations.isAssignable(widened, target)
    ) {
      this.c.error(
        node,
        `型 '${this.c.print(widened)}' から型 '${this.c.print(target)}' への変換は、どちらの型も他方と十分に重ならないため、誤りの可能性があります。意図したものなら、先に 'unknown' に変換してください。`
      );
    }
    return target;
  }
}

function isNullishIntrinsic(type: Type): boolean {
  return isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined');
}

/** Whether an expression can be `null` or `undefined` by its syntax alone, as TypeScript decides for `??`. */
// code-gauge-allow functionNcss 34 -- One case per kind of expression TypeScript's getSyntacticNullishnessSemantics tells apart.
function syntacticNullishness(node: TreeNode): 'always' | 'never' | 'sometimes' {
  let expression = node;
  while (
    [
      'parenthesized_expression',
      'as_expression',
      'satisfies_expression',
      'non_null_expression',
      'type_assertion',
    ].includes(expression.type)
  ) {
    expression = (expression.type === 'type_assertion' ? named(expression).at(-1) : named(expression)[0]) as TreeNode;
  }
  switch (expression.type) {
    case 'call_expression':
    case 'subscript_expression':
    case 'member_expression':
    case 'new_expression':
    case 'meta_property':
    case 'await_expression':
    case 'yield_expression':
    case 'this': {
      return 'sometimes';
    }
    case 'binary_expression': {
      const operator = expression.childForFieldName('operator')?.text ?? '';
      return ['??', '||', '&&'].includes(operator) ? 'sometimes' : 'never';
    }
    case 'assignment_expression':
    case 'augmented_assignment_expression': {
      const operator =
        expression.type === 'assignment_expression' ? '=' : (expression.childForFieldName('operator')?.text ?? '');
      return ['=', '??=', '||=', '&&='].includes(operator) ? 'sometimes' : 'never';
    }
    case 'sequence_expression': {
      return syntacticNullishness(named(expression).at(-1) as TreeNode);
    }
    case 'ternary_expression': {
      const a = syntacticNullishness(expression.childForFieldName('consequence') as TreeNode);
      const b = syntacticNullishness(expression.childForFieldName('alternative') as TreeNode);
      return a === b ? a : 'sometimes';
    }
    case 'null':
    case 'undefined': {
      return 'always';
    }
    case 'identifier': {
      return expression.text === 'undefined' ? 'always' : 'sometimes';
    }
    default: {
      return 'never';
    }
  }
}
