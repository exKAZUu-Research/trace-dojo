import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Sym } from './scopes';
import { arrayPatternElements, named, propertyNameText, skipParentheses } from './syntax';
import {
  anyType,
  bigintType,
  errorType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** Checks assignments, compound assignments, and updates, narrowing the references they assign. */
export class AssignmentChecker {
  constructor(private readonly c: Checker) {}

  assignment(node: TreeNode): Type {
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    const leftExpression = skipParentheses(left);
    if (
      leftExpression.type === 'object_pattern' ||
      leftExpression.type === 'array_pattern' ||
      leftExpression.type === 'object' ||
      leftExpression.type === 'array'
    ) {
      const valueType = this.c.expressions.check(right);
      this.destructuringAssignment(leftExpression, valueType);
      return valueType;
    }
    if (this.isEvolvingArrayAssignment(leftExpression)) {
      const valueType = this.c.expressions.checkWidened(right);
      this.evolve(leftExpression.childForFieldName('object') as TreeNode, valueType);
      this.c.expressions.check(leftExpression.childForFieldName('index') as TreeNode);
      return valueType;
    }
    const targetType = this.targetType(left, false);
    const valueType = this.c.expressions.check(right, targetType === errorType ? undefined : targetType);
    if (targetType !== errorType) this.c.expressions.checkAssignable(leftExpression, valueType, targetType);
    this.assignReference(leftExpression, targetType, valueType);
    return valueType;
  }

  private isEvolvingArrayAssignment(target: TreeNode): boolean {
    if (target.type !== 'subscript_expression') return false;
    const object = target.childForFieldName('object');
    const key = object ? this.c.flow.referenceKey(object) : undefined;
    return key !== undefined && this.c.flow.entry(key)?.evolving === true;
  }

  /** Adds an element type to an evolving array, as `push` does to one declared as `[]`. */
  evolve(objectNode: TreeNode, elementType: Type): void {
    const key = this.c.flow.referenceKey(objectNode);
    const entry = key ? this.c.flow.entry(key) : undefined;
    if (!key || !entry?.evolving) return;
    const element = this.c.elementTypeOf(entry.type as ObjectType);
    this.c.flow.set(key, { ...entry, type: this.c.arrayType(unionOf([element, this.c.widen(elementType)])) });
  }

  isEvolvingArray(node: TreeNode): boolean {
    const key = this.c.flow.referenceKey(node);
    return key !== undefined && this.c.flow.entry(key)?.evolving === true;
  }

  /** Narrows an assigned reference to the assigned type. */
  assignReference(target: TreeNode, declared: Type, assigned: Type): void {
    const key = this.c.flow.referenceKey(target);
    if (!key) return;
    this.c.flow.invalidate(key);
    if (/^this\d+\.[^.]*$/.test(key)) this.c.flow.current?.assignedFields.add(key);
    if (declared === errorType) return;
    const accessor = this.assignedAccessorType(target);
    if (accessor) {
      this.c.flow.set(key, { type: accessor, assigned: true });
      return;
    }
    const entry = this.c.flow.entry(key);
    const symbol = target.type === 'identifier' ? this.c.scopeOf(target).lookupValue(target.text) : undefined;
    const isAuto = symbol !== undefined && this.isAutoTyped(symbol);
    const type = isAuto ? this.c.widen(assigned) : this.c.flow.assignmentReduced(declared, regularOf(assigned));
    this.c.flow.set(key, { type, assigned: true, evolving: entry?.evolving });
  }

  private assignedAccessorType(target: TreeNode): Type | undefined {
    if (target.type !== 'member_expression' && target.type !== 'subscript_expression') return undefined;
    const object = target.childForFieldName('object') as TreeNode;
    const index = target.childForFieldName('index');
    const indexed = index ? this.c.silently(() => this.c.expressions.check(index)) : undefined;
    const name =
      target.childForFieldName('property')?.text ?? (indexed?.kind === 'literal' ? String(indexed.value) : undefined);
    if (name === undefined) return undefined;
    const objectType = this.c.silently(() => this.c.expressions.check(object));
    const properties = (objectType.kind === 'union' ? objectType.types : [objectType]).map((member) =>
      this.c.propertyOf(member, name)
    );
    if (!properties.some((property) => property?.writeType)) return undefined;
    return unionOf(properties.map((property) => property?.type() ?? anyType));
  }

  /** Whether a variable has no annotation nor initializer, so that its type follows what is assigned to it. */
  isAutoTyped(symbol: Sym): boolean {
    const declaration = symbol.valueDeclaration;
    return (
      declaration?.type === 'variable_declarator' &&
      !declaration.childForFieldName('type') &&
      !declaration.childForFieldName('value')
    );
  }

  // code-gauge-allow functionNcss 44 -- One case per kind of destructuring target, in array and object patterns alike.
  // code-gauge-allow functionCognitiveComplexity 24 -- One case per kind of destructuring target, in array and object patterns alike.
  destructuringAssignment(pattern: TreeNode, type: Type): void {
    const assign = (target: TreeNode, valueType: Type): void => {
      if (['assignment_expression', 'assignment_pattern', 'object_assignment_pattern'].includes(target.type)) {
        const left = target.childForFieldName('left') as TreeNode;
        const right = target.childForFieldName('right') as TreeNode;
        const defaultType = this.c.expressions.check(right);
        assign(left, unionOf([this.c.relations.removeUndefined(valueType), regularOf(defaultType)]));
        return;
      }
      if (['array', 'object', 'array_pattern', 'object_pattern'].includes(target.type)) {
        this.destructuringAssignment(target, valueType);
        return;
      }
      const declared = this.targetType(target, false);
      if (declared !== errorType && !this.c.relations.isAssignable(valueType, declared))
        this.c.expressions.reportNotAssignable(target, valueType, declared);
      this.assignReference(skipParentheses(target), declared, valueType);
    };
    if (pattern.type === 'array' || pattern.type === 'array_pattern') {
      for (const { element, index } of arrayPatternElements(pattern)) {
        if (element.type === 'spread_element' || element.type === 'rest_pattern') {
          assign(named(element)[0], this.c.patterns.restOfIterable(type, index));
          break;
        }
        const elementType = this.c.patterns.elementAt(element, type, index);
        assign(element, elementType);
      }
      return;
    }
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier':
        case 'shorthand_property_identifier_pattern': {
          assign(element, this.c.patterns.destructuredProperty(element, type, element.text));
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          assign(element, this.c.patterns.destructuredProperty(left, type, left.text, true));
          break;
        }
        case 'pair':
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          const name = propertyNameText(key) ?? '';
          const hasDefault = ['assignment_expression', 'assignment_pattern'].includes(value.type);
          assign(value, this.c.patterns.destructuredProperty(key, type, name, hasDefault));
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  compoundAssignment(node: TreeNode): Type {
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    const operator = node.childForFieldName('operator')?.text ?? '+=';
    const targetType = this.targetType(left, true);
    if (operator === '&&=' || operator === '||=' || operator === '??=') {
      const valueType = this.c.expressions.check(right, targetType);
      if (targetType !== errorType)
        this.c.expressions.checkAssignable(skipParentheses(left), valueType, this.declaredTargetType(left));
      const kept =
        operator === '??='
          ? this.c.relations.removeNullish(targetType)
          : this.c.flow.narrowByTruthiness(targetType, operator === '||=');
      const result = this.c.literals.subtypeReduced([kept, valueType]);
      // The target holds what it kept or what was assigned, as `s ||= "x"` leaves a truthy `s` or `"x"`.
      if (targetType !== errorType) this.assignReference(skipParentheses(left), this.declaredTargetType(left), result);
      return result;
    }
    const valueType = this.c.expressions.check(right);
    const resultType = this.c.operators.binaryOperatorType(
      node,
      operator.slice(0, -1),
      left,
      right,
      targetType,
      valueType
    );
    const declared = this.declaredTargetType(left);
    if (targetType !== errorType && resultType !== errorType)
      this.c.expressions.checkAssignable(skipParentheses(left), resultType, declared);
    this.assignReference(skipParentheses(left), declared, resultType);
    return resultType;
  }

  private declaredTargetType(left: TreeNode): Type {
    return this.c.silently(() => this.targetType(left, false));
  }

  update(node: TreeNode): Type {
    const argument = node.childForFieldName('argument') as TreeNode;
    const type = this.targetType(argument, true);
    if (type === errorType) return numberType;
    if (
      !this.c.operators.isNumberLike(type) &&
      !isIntrinsic(regularOf(type), 'bigint') &&
      !(type.kind === 'literal' && typeof type.value === 'bigint')
    ) {
      const nonNull = this.c.relations.removeNullish(type);
      if (this.c.operators.isNumberLike(nonNull) && nonNull !== type) this.c.members.checkNonNullable(argument, type);
      else this.c.error(argument, '++ や -- を使える値は、number 型、bigint 型、any 型のものだけです。');
      return numberType;
    }
    const result = this.c.operators.isBigintLike(type) ? bigintType : numberType;
    this.assignReference(skipParentheses(argument), this.declaredTargetType(argument), result);
    return result;
  }

  /** The declared type of an assignment target, reporting a constant or a read-only property. */
  targetType(target: TreeNode, compound: boolean): Type {
    const expression = skipParentheses(target);
    switch (expression.type) {
      case 'identifier':
      case 'shorthand_property_identifier':
      case 'shorthand_property_identifier_pattern': {
        return this.variableTargetType(expression, compound);
      }
      case 'member_expression': {
        return this.propertyTargetType(expression, compound);
      }
      case 'subscript_expression': {
        return this.elementTargetType(expression);
      }
      case 'non_null_expression': {
        return this.targetType(named(expression)[0], compound);
      }
      default: {
        this.c.error(target, '代入の左辺には、変数かプロパティを書いてください。');
        return errorType;
      }
    }
  }

  private variableTargetType(expression: TreeNode, compound: boolean): Type {
    const symbol = this.c.scopeOf(expression).lookupValue(expression.text);
    if (!symbol) {
      this.c.error(expression, `名前 ${expression.text} が見つかりません。`);
      return errorType;
    }
    if (symbol.valueKind === 'const') {
      this.c.error(expression, `${expression.text} は定数なので、代入できません。`);
      return errorType;
    }
    if (symbol.valueKind === 'function' || symbol.valueKind === 'class') {
      this.c.error(
        expression,
        `${expression.text} は${symbol.valueKind === 'class' ? 'クラス' : '関数'}なので、代入できません。`
      );
      return errorType;
    }
    if (compound) return this.c.expressions.identifier(expression);
    this.c.expressions.checkUsedBeforeDeclaration(expression, symbol);
    return this.c.expressions.valueTypeOf(symbol);
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Applies union writability, optional properties, getter read types, and setter write types at one assignment boundary.
  private propertyTargetType(expression: TreeNode, compound: boolean): Type {
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const propertyNode = expression.childForFieldName('property') as TreeNode;
    if (expression.childForFieldName('optional_chain')) {
      this.c.error(expression, 'オプショナルチェーン ?. を含む式には代入できません。');
      return errorType;
    }
    const objectType = this.c.members.checkNonNullable(objectNode, this.c.expressions.check(objectNode));
    const properties = (objectType.kind === 'union' ? objectType.types : [objectType])
      .map((member) => this.c.propertyOf(member, propertyNode.text))
      .filter((property): property is Property => property !== undefined);
    const property = properties[0];
    for (const member of properties) {
      if (this.c.classes.isReadonlyFor(member, expression, objectNode) || member.getterOnly) {
        this.c.error(propertyNode, `${propertyNode.text} は読み取り専用のプロパティなので、代入できません。`);
        return errorType;
      }
    }
    // `r.a = 2` writes through a string index signature when `a` is not declared.
    if (!property && !isAnyLike(objectType) && this.c.structureOf(objectType).stringIndex?.readonly) {
      return this.reportReadonlyIndex(expression, objectType);
    }
    const type = this.c.members.propertyAccess(expression, objectNode, propertyNode, objectType, propertyNode.text);
    if (compound) {
      const key = this.c.flow.referenceKey(expression);
      const entry = key ? this.c.flow.entry(key) : undefined;
      if (entry) return entry.type;
    }
    if (!compound && properties.length > 0)
      return intersectionOf(
        properties.map((member) =>
          member.optional
            ? unionOf([(member.writeType ?? member.type)(), undefinedType])
            : (member.writeType ?? member.type)()
        ),
        this.c.budget
      );
    return type;
  }

  private elementTargetType(expression: TreeNode): Type {
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const indexNode = expression.childForFieldName('index') as TreeNode;
    const objectType = this.c.members.checkNonNullable(objectNode, this.c.expressions.check(objectNode));
    const indexType = this.c.expressions.check(indexNode);
    if (this.isReadonlyArrayLike(objectType)) return this.reportReadonlyIndex(expression, objectType);
    if (indexType.kind === 'literal' && typeof indexType.value === 'string') {
      const properties = (objectType.kind === 'union' ? objectType.types : [objectType]).map((member) =>
        this.c.propertyOf(member, indexType.value as string)
      );
      if (
        properties.some(
          (property) =>
            property && (this.c.classes.isReadonlyFor(property, expression, objectNode) || property.getterOnly)
        )
      ) {
        this.c.error(indexNode, `${indexType.value} は読み取り専用のプロパティなので、代入できません。`);
        return errorType;
      }
    }
    if (this.hasReadonlyIndexSignature(objectType, indexType)) return this.reportReadonlyIndex(expression, objectType);
    const readType = this.c.members.indexedType(expression, objectNode, indexNode, objectType, indexType);
    if (indexType.kind === 'literal') {
      const properties = (objectType.kind === 'union' ? objectType.types : [objectType])
        .map((member) => this.c.propertyOf(member, String(indexType.value)))
        .filter((property): property is Property => property !== undefined);
      if (properties.length > 0)
        return intersectionOf(
          properties.map((property) => (property.writeType ?? property.type)()),
          this.c.budget
        );
    }
    return readType;
  }

  private isReadonlyArrayLike(type: Type): boolean {
    return (
      type.kind === 'object' &&
      (this.c.isReadonlyArrayType(type) || (type.objectKind === 'tuple' && type.tuple?.readonly === true))
    );
  }

  /** Whether the index signature an element assignment writes through is read-only. */
  private hasReadonlyIndexSignature(objectType: Type, indexType: Type): boolean {
    if (isAnyLike(objectType)) return false;
    const structure = this.c.structureOf(objectType);
    const isNumeric = (): boolean => this.c.relations.isAssignable(indexType, numberType);
    return (
      (structure.stringIndex?.readonly === true && !isNumeric()) ||
      (structure.numberIndex?.readonly === true && isNumeric())
    );
  }

  private reportReadonlyIndex(expression: TreeNode, objectType: Type): Type {
    this.c.error(expression, `型 '${this.c.print(objectType)}' のインデックスは読み取り専用です。`);
    return errorType;
  }
}
