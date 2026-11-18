import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { nonNullableType, nullishConstraint } from './nullishConstraints';
import { isConstAssertion, named, numberValue, skipParentheses } from './syntax';
import {
  anyType,
  bigintType,
  booleanType,
  errorType,
  freshLiteralType,
  isAnyLike,
  isIntrinsic,
  literalType,
  mapType,
  neverType,
  numberType,
  primitiveOfLiteral,
  type Property,
  regularOf,
  stringType,
  symbolType,
  type Type,
  undefinedType,
  unionOf,
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
      const constraint = this.c.baseConstraint(type);
      const members = constraint.kind === 'union' ? constraint.types : [constraint];
      if (members.some((member) => this.isBigintLike(member)))
        this.c.error(argument, "演算子 '+' は型 'bigint' には使えません。");
      return numberType;
    }
    const members = type.kind === 'union' ? type.types : [type];
    return unionOf(members.map((member) => (this.isBigintLike(member) ? bigintType : numberType)));
  }

  /**
   * Reports an operand that is `unknown` or may be `null` or `undefined`, through its constraint too, returning whether
   * the operator still gives its usual type.
   */
  private checkNonNullOperand(argument: TreeNode, type: Type): boolean {
    if (isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined') || isIntrinsic(type, 'unknown')) {
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
    return members.some(
      (member) =>
        !isAnyLike(member) && !isIntrinsic(member, 'never') && this.c.relations.isAssignable(member, symbolType)
    );
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
    return this.c.relations.isAssignable(regular, numberType);
  }

  /** Whether a type is a bigint; not `never`, which operators take for a number unless the other operand is a bigint. */
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
        return this.logical(operator, left, right, contextual);
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
        const l = this.baseOfLiterals(this.c.members.checkNonNullable(left, leftType));
        const r = this.baseOfLiterals(this.c.members.checkNonNullable(right, rightType));
        // Both operands are numbers, or neither is and they are comparable, as `string | number >= 1` is not.
        const leftNumeric = this.isNumberLike(l) || this.isBigintLike(l);
        const rightNumeric = this.isNumberLike(r) || this.isBigintLike(r);
        const ok =
          isAnyLike(l) ||
          isAnyLike(r) ||
          (leftNumeric && rightNumeric) ||
          (!leftNumeric && !rightNumeric && this.c.relations.isComparable(l, r));
        if (!ok) this.reportOperator(node, operator, l, r);
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
    return mapType(type, (member) => (member.kind === 'literal' ? primitiveOfLiteral(member) : member));
  }

  private plus(node: TreeNode, left: TreeNode, right: TreeNode, leftType: Type, rightType: Type): Type {
    if (this.reportsSymbolOperand(left, right, leftType, rightType)) return errorType;
    const concatenates = this.isStringLike(leftType) || this.isStringLike(rightType);
    if (!concatenates && (isAnyLike(leftType) || isAnyLike(rightType))) return anyType;
    const l = concatenates ? leftType : this.c.members.checkNonNullable(left, leftType);
    const r = concatenates ? rightType : this.c.members.checkNonNullable(right, rightType);
    if (this.isStringLike(l) || this.isStringLike(r)) {
      this.c.expressions.checkFunctionText(left, l);
      this.c.expressions.checkFunctionText(right, r);
      return stringType;
    }
    if (isAnyLike(l) || isAnyLike(r)) return anyType;
    if (this.isNumberLike(l) && this.isNumberLike(r)) return numberType;
    if ([l, r].every((type) => this.isBigintLike(type) || isIntrinsic(type, 'never'))) return bigintType;
    this.reportOperator(node, '+', l, r);
    return errorType;
  }

  private reportsSymbolOperand(left: TreeNode, right: TreeNode, leftType: Type, rightType: Type): boolean {
    const operand = [left, right].find((_, index) =>
      this.c.expressions.isSymbolLike(index === 0 ? leftType : rightType)
    );
    if (operand) this.c.error(operand, "演算子 '+' は 'symbol' 型には使えません。");
    return operand !== undefined;
  }

  private arithmetic(
    node: TreeNode,
    operator: string,
    left: TreeNode,
    right: TreeNode,
    leftType: Type,
    rightType: Type
  ): Type {
    const l = this.c.members.checkNonNullable(left, leftType);
    const r = this.c.members.checkNonNullable(right, rightType);
    const leftOk = this.isNumericOperand(l);
    const rightOk = this.isNumericOperand(r);
    if (!leftOk)
      this.c.error(left, '算術演算の左辺は、any 型、number 型、bigint 型、列挙型のいずれかでなければいけません。');
    if (!rightOk)
      this.c.error(right, '算術演算の右辺は、any 型、number 型、bigint 型、列挙型のいずれかでなければいけません。');
    if (!leftOk || !rightOk) return numberType;
    const leftBig = this.isBigintLike(l);
    const rightBig = this.isBigintLike(r);
    // `any` and `never` take the kind of the other operand.
    if (leftBig !== rightBig && [l, r].every((type) => !isAnyLike(type) && !isIntrinsic(type, 'never'))) {
      this.reportOperator(node, operator, l, r);
      return errorType;
    }
    const big = leftBig || rightBig;
    if (big && operator === '>>>') {
      this.c.error(node, "演算子 '>>>' は型 'bigint' には使えません。");
    }
    return big ? bigintType : numberType;
  }

  /**
   * Whether both operands of an arithmetic compound assignment are numeric once `null` and `undefined` are left out,
   * as TypeScript requires before it checks the assignment of the result.
   */
  hasNumericOperands(left: TreeNode, right: TreeNode, leftType: Type, rightType: Type): boolean {
    return this.c.silently(() =>
      [
        [left, leftType],
        [right, rightType],
      ].every(([node, type]) => this.isNumericOperand(this.c.members.checkNonNullable(node as TreeNode, type as Type)))
    );
  }

  /** Whether an operand, without its `null` and `undefined`, may be an arithmetic operand; `void` may not. */
  isNumericOperand(type: Type): boolean {
    return this.isNumberLike(type) || this.isBigintLike(type);
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
    const overlaps = (a: Type, b: Type): boolean =>
      this.c.relations.isComparable(this.comparableForm(a), this.comparableForm(b));
    if (overlaps(l, r)) return;
    // As TypeScript does, the message names the operands' base types when those do not overlap either.
    const [leftBase, rightBase] = [baseTypeOfLiteral(l), baseTypeOfLiteral(r)];
    const [shownLeft, shownRight] = overlaps(leftBase, rightBase) ? [l, r] : [leftBase, rightBase];
    this.c.error(
      node,
      `この比較は意図したものではないようです。型 '${this.c.print(shownLeft)}' と型 '${this.c.print(shownRight)}' には重なりがありません。`
    );
  }

  /** A type with `null` and `undefined` removed, which comparisons always allow. */
  private comparableForm(type: Type): Type {
    const removed = this.c.relations.removeNullish(type);
    return isIntrinsic(removed, 'never') ? type : removed;
  }

  private logical(operator: string, left: TreeNode, right: TreeNode, contextual?: Type): Type {
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
    if (operator === '&&')
      return unionOf([falsyValuesOf(this.c.flow.narrowByTruthiness(leftType, false)), rightType], true);
    return this.disjunctionType(leftType, rightType);
  }

  /** The type of `left || right`, which is `left` when it cannot be falsy, as TypeScript's `getTypeFacts` decides. */
  disjunctionType(left: Type, right: Type): Type {
    if (isIntrinsic(this.c.flow.narrowByTruthiness(nullishConstraint(this.c, left), false), 'never')) return left;
    return this.c.literals.subtypeReduced([this.c.flow.narrowByTruthiness(left, true), right]);
  }

  /** The type of `left ?? right`, which is `left` when it cannot be nullish, as TypeScript's `getTypeFacts` decides. */
  coalescingType(left: Type, right: Type): Type {
    const constraint = nullishConstraint(this.c, left);
    if (!this.c.relations.isNullable(constraint) && !isAnyLike(constraint) && !isIntrinsic(constraint, 'unknown'))
      return left;
    return this.c.literals.subtypeReduced([nonNullableType(this.c, left), right]);
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
    if (!typeNode || isConstAssertion(node)) {
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

/** TypeScript's base type of a literal type: its primitive, or `string` for a template literal or string mapping. */
function baseTypeOfLiteral(type: Type): Type {
  return mapType(type, (member) => {
    if (member.kind === 'literal' && typeof member.value !== 'symbol') return primitiveOfLiteral(member);
    return member.kind === 'templateLiteral' || member.kind === 'stringMapping' ? stringType : member;
  });
}

/** The falsy values that `&&` gives for a type: `0` for a number, `""` for a string, and `0n` for a bigint. */
function falsyValuesOf(type: Type): Type {
  return mapType(type, (member) => {
    if (isIntrinsic(member, 'number')) return literalType(0);
    if (isIntrinsic(member, 'string')) return literalType('');
    return isIntrinsic(member, 'bigint') ? literalType(0n) : member;
  });
}
