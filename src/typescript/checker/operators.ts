import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { named, numberValue, skipParentheses } from './syntax';
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
  regularOf,
  stringType,
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

  // code-gauge-allow functionNcss 38 -- One case per unary operator.
  // code-gauge-allow functionCognitiveComplexity 23 -- One case per unary operator.
  unary(node: TreeNode): Type {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const argument = node.childForFieldName('argument') as TreeNode;
    switch (operator) {
      case '!': {
        this.c.conditions.checkCondition(argument);
        return booleanType;
      }
      case 'typeof': {
        this.c.silently(() => this.c.expressions.check(argument));
        if (argument.type !== 'identifier' || this.c.scopeOf(argument).lookupValue(argument.text))
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
        const type = this.c.expressions.check(argument);
        if (argument.type === 'number' && operator === '-') {
          const value = numberValue(argument.text);
          return freshLiteralType(typeof value === 'bigint' ? -value : -value);
        }
        if (operator === '+') {
          if (this.isBigintLike(type)) this.c.error(argument, "演算子 '+' は型 'bigint' には使えません。");
          return numberType;
        }
        if (isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined')) {
          this.c.error(argument, `値 '${this.c.print(type)}' はここでは使えません。`);
          return numberType;
        }
        if (!isAnyLike(type) && this.c.relations.isNullable(type)) this.c.members.checkNonNullable(argument, type);
        return this.isBigintLike(type) ? bigintType : numberType;
      }
      default: {
        this.c.expressions.check(argument);
        return anyType;
      }
    }
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
    const name = expression.type === 'member_expression' ? expression.childForFieldName('property')?.text : undefined;
    if (!name || isAnyLike(objectType)) return;
    const property = this.c.propertyOf(objectType, name);
    if (property?.readonly) {
      this.c.error(argument, 'delete 演算子のオペランドは、読み取り専用のプロパティにはできません。');
      return;
    }
    if (
      property &&
      !property.optional &&
      !isAnyLike(property.type()) &&
      !isIntrinsic(property.type(), 'unknown') &&
      !this.c.relations.isNullable(property.type())
    )
      this.c.error(argument, 'delete 演算子のオペランドは、省略できるプロパティでなければいけません。');
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
        const ok =
          isAnyLike(l) ||
          isAnyLike(r) ||
          ((this.isNumberLike(l) || this.isBigintLike(l)) && (this.isNumberLike(r) || this.isBigintLike(r))) ||
          (this.c.relations.isComparable(l, r) && !(l.kind === 'object' && false));
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
    if (this.isStringLike(leftType) || this.isStringLike(rightType)) {
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

  private checkComparisonOverlap(node: TreeNode, operator: string, leftType: Type, rightType: Type): void {
    const l = regularOf(leftType);
    const r = regularOf(rightType);
    if (isAnyLike(l) || isAnyLike(r)) return;
    const loose = operator === '==' || operator === '!=';
    if (isNullishIntrinsic(l) || isNullishIntrinsic(r)) return;
    if (this.c.relations.isComparable(this.comparableForm(l), this.comparableForm(r))) return;
    if (loose && (this.isNumberLike(l) || this.isStringLike(l)) && (this.isNumberLike(r) || this.isStringLike(r)))
      return;
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
      const leftType = this.c.expressions.check(left, contextual);
      const rightType = this.c.expressions.check(right, contextual);
      return this.c.literals.subtypeReduced([this.c.relations.removeNullish(leftType), rightType]);
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
      return this.c.expressions.check(expression);
    }
    const target = this.c.typeNodes.typeFromNode(typeNode);
    const source = this.c.expressions.check(expression, target);
    const widened = this.c.widen(source);
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
