import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { State } from './flow';
import { defaultedTarget } from './patterns';
import { printedPropertyName } from './print';
import type { Sym } from './scopes';
import { nameSuggestionHint } from './spelling';
import { arrayPatternElements, named, skipParentheses } from './syntax';
import {
  anyType,
  bigintType,
  errorType,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  literalType,
  neverType,
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
      const implied = this.c.silently(() => this.patternContext(leftExpression));
      const valueType = this.c.expressions.check(right, implied);
      this.c.patterns.checkInitializer(leftExpression, right, valueType, implied);
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
    if (targetType !== errorType) this.c.expressions.checkAssignable(leftExpression, valueType, targetType, right);
    this.assignReference(leftExpression, targetType, valueType);
    return valueType;
  }

  /** The type the targets of an assignment pattern imply for its right side, so that a literal there takes their types. */
  private patternContext(pattern: TreeNode): Type | undefined {
    return this.c.patterns.impliedType(pattern, (element) => {
      const declared = this.targetType(defaultedTarget(element) ?? element, false);
      return declared === errorType ? anyType : declared;
    });
  }

  private isEvolvingArrayAssignment(target: TreeNode): boolean {
    if (target.type !== 'subscript_expression' || !this.isElementWrite(target)) return false;
    const object = target.childForFieldName('object');
    const key = object ? this.c.flow.referenceKey(object) : undefined;
    return key !== undefined && this.c.flow.entry(key)?.evolving === true;
  }

  /** Whether `x[i] = …` writes an element, with a numeric index, which adds to the element type of an evolving array. */
  isElementWrite(subscript: TreeNode): boolean {
    const assignment = subscript.parent;
    if (assignment?.type !== 'assignment_expression' || assignment.childForFieldName('left')?.id !== subscript.id)
      return false;
    const index = subscript.childForFieldName('index') as TreeNode;
    return this.c.operators.isNumberLike(this.c.silently(() => this.c.expressions.check(index)));
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

  destructuringAssignment(pattern: TreeNode, type: Type): void {
    const assign = (target: TreeNode, valueType: Type): void => {
      const left = defaultedTarget(target);
      if (left) {
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
          assign(named(element)[0], this.c.patterns.restOfIterable(pattern, type, index));
          break;
        }
        const elementType = this.c.patterns.elementAt(element, type, index);
        assign(element, elementType);
      }
      return;
    }
    this.destructuringObjectAssignment(pattern, type, assign);
  }

  private destructuringObjectAssignment(
    pattern: TreeNode,
    type: Type,
    assign: (target: TreeNode, type: Type) => void
  ): void {
    const used: string[] = [];
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier':
        case 'shorthand_property_identifier_pattern': {
          used.push(element.text);
          assign(element, this.c.patterns.destructuredProperty(element, type, element.text));
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          used.push(left.text);
          assign(element, this.c.patterns.destructuredProperty(left, type, left.text));
          break;
        }
        case 'pair':
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          const selected = this.c.patterns.destructuredKey(key, type);
          used.push(...(selected.names ?? []));
          assign(value, selected.type);
          break;
        }
        case 'spread_element':
        case 'rest_pattern': {
          assign(named(element)[0], this.c.patterns.restObject(type, used));
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
      // The right operand runs only on some paths, so its effects join the path that skips it.
      const { skipped, evaluating } = this.logicalAssignmentPaths(left, operator);
      let valueType: Type = neverType;
      const evaluated = this.c.flow.from(evaluating, () => {
        valueType = this.c.expressions.check(right, targetType);
      });
      this.c.flow.current = this.c.flow.merge([skipped, evaluated]);
      if (targetType !== errorType)
        this.c.expressions.checkAssignable(skipParentheses(left), valueType, this.declaredTargetType(left));
      const result = this.logicalAssignmentType(operator, targetType, valueType);
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

  private logicalAssignmentType(operator: string, targetType: Type, valueType: Type): Type {
    if (operator === '??=') return this.c.operators.coalescingType(targetType, valueType);
    if (operator === '||=') return this.c.operators.disjunctionType(targetType, valueType);
    return this.c.literals.subtypeReduced([this.c.flow.narrowByTruthiness(targetType, false), valueType]);
  }

  /** The flow states where a logical assignment keeps its target and where it evaluates the right operand. */
  private logicalAssignmentPaths(left: TreeNode, operator: string): { skipped: State; evaluating: State } {
    if (operator === '??=') {
      const { whenTrue, whenFalse } = this.c.conditions.presence(left);
      return { skipped: whenTrue, evaluating: whenFalse };
    }
    const { whenTrue, whenFalse } = this.c.conditions.truthiness(skipParentheses(left));
    return operator === '&&='
      ? { skipped: whenFalse, evaluating: whenTrue }
      : { skipped: whenTrue, evaluating: whenFalse };
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
        return this.elementTargetType(expression, compound);
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
      this.c.error(
        expression,
        `名前 ${expression.text} が見つかりません。${nameSuggestionHint(this.c.scopeOf(expression), expression.text, 'value')}`
      );
      return errorType;
    }
    // A library constant is declared with the kind `declared`, its entry recording `const`.
    if (symbol.valueEntries[0]?.kind === 'const') {
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

  private propertyTargetType(expression: TreeNode, compound: boolean): Type {
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const propertyNode = expression.childForFieldName('property') as TreeNode;
    if (expression.childForFieldName('optional_chain')) {
      this.c.error(expression, 'オプショナルチェーン ?. を含む式には代入できません。');
      return errorType;
    }
    const objectType =
      objectNode.type === 'super'
        ? this.c.classes.superType(expression)
        : this.c.members.checkNonNullable(objectNode, this.c.expressions.check(objectNode));
    const key = this.c.classes.propertyKey(expression, propertyNode);
    const properties = (objectType.kind === 'union' ? objectType.types : [objectType])
      .map((member) => this.c.propertyOf(member, key))
      .filter((property): property is Property => property !== undefined);
    for (const member of properties) {
      if (this.c.classes.isReadonlyFor(member, expression, objectNode) || member.getterOnly) {
        this.c.error(propertyNode, `${propertyNode.text} は読み取り専用のプロパティなので、代入できません。`);
        return errorType;
      }
    }
    if (this.c.members.isReadonlyIndex(objectType, literalType(propertyNode.text)))
      return this.reportReadonlyIndex(expression, objectType);
    if (this.c.members.isGenericIndexWrite(objectType, literalType(propertyNode.text))) {
      this.c.error(propertyNode, `プロパティ '${propertyNode.text}' は型 '${this.c.print(objectType)}' にありません。`);
      return errorType;
    }
    const type = this.c.members.propertyAccess(expression, objectNode, propertyNode, objectType, propertyNode.text);
    if (compound) return this.narrowedType(expression) ?? type;
    return unionOf(
      (objectType.kind === 'union' ? objectType.types : [objectType]).map((member) => this.namedWriteType(member, key))
    );
  }

  private elementTargetType(expression: TreeNode, compound: boolean): Type {
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const indexNode = expression.childForFieldName('index') as TreeNode;
    const objectType = this.c.members.checkNonNullable(objectNode, this.c.expressions.check(objectNode));
    const indexType = this.c.expressions.check(indexNode);
    if (this.isReadonlyArrayLike(objectType)) return this.reportReadonlyIndex(expression, objectType);
    if (isPropertyKeyLiteral(indexType) && this.isReadonlyProperty(expression, objectType, String(indexType.value))) {
      this.c.error(
        indexNode,
        `${printedPropertyName(String(indexType.value))} は読み取り専用のプロパティなので、代入できません。`
      );
      return errorType;
    }
    if (this.c.members.isReadonlyIndex(objectType, indexType)) return this.reportReadonlyIndex(expression, objectType);
    if (this.c.members.isGenericIndexWrite(objectType, regularOf(indexType))) {
      this.c.error(
        expression,
        `型 '${this.c.print(objectType)}' はジェネリックなので、インデックスでは読み取りしかできません。`
      );
      return errorType;
    }
    const readType = this.c.members.indexedType(expression, objectNode, indexNode, objectType, indexType);
    if (readType !== errorType && this.c.members.isReadonlyMappedWrite(objectType, indexType))
      return this.reportReadonlyIndex(expression, objectType);
    const narrowed = compound ? this.narrowedType(expression) : undefined;
    if (narrowed) return narrowed;
    if (indexType.kind === 'literal')
      return unionOf(
        (objectType.kind === 'union' ? objectType.types : [objectType]).map((member) =>
          this.namedWriteType(member, String(indexType.value))
        )
      );

    return readType;
  }

  /** Whether `expression`, an element access by a literal key, names a property that it cannot write. */
  private isReadonlyProperty(expression: TreeNode, objectType: Type, name: string): boolean {
    const objectNode = expression.childForFieldName('object') as TreeNode;
    return (objectType.kind === 'union' ? objectType.types : [objectType]).some((member) => {
      const property = this.c.propertyOf(member, name);
      return (
        property !== undefined &&
        (this.c.classes.isReadonlyFor(property, expression, objectNode) || property.getterOnly)
      );
    });
  }

  /** The type a compound assignment reads from a reference that the flow has narrowed. */
  private narrowedType(reference: TreeNode): Type | undefined {
    const key = this.c.flow.referenceKey(reference);
    return key ? this.c.flow.entry(key)?.type : undefined;
  }

  private isReadonlyArrayLike(type: Type): boolean {
    return (
      type.kind === 'object' &&
      (this.c.isReadonlyArrayType(type) || (type.objectKind === 'tuple' && type.tuple?.readonly === true))
    );
  }

  private namedWriteType(type: Type, name: string): Type {
    const property = this.c.propertyOf(type, name);
    // The access, checked before, has reported a property that neither exists nor falls under an index signature.
    if (!property) return isAnyLike(type) ? type : (this.c.members.indexSignatureType(type, name) ?? errorType);
    const value = (property.writeType ?? property.type)();
    return property.optional ? unionOf([value, undefinedType]) : value;
  }

  private reportReadonlyIndex(expression: TreeNode, objectType: Type): Type {
    this.c.error(expression, `型 '${this.c.print(objectType)}' のインデックスは読み取り専用です。`);
    return errorType;
  }
}
