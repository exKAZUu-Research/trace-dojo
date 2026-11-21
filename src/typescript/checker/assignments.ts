// code-gauge-allow-file fileNcss 406 -- Assignment targets share write validation and updates to reference flow.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { FlowEntry, State } from './flow';
import { applicableIndex } from './indexInfos';
import { defaultedTarget, isEmptyPattern } from './patterns';
import { printedPropertyName } from './print';
import type { Sym } from './scopes';
import { nameSuggestionHint } from './spelling';
import { arrayPatternElements, isOptionalChain, named, skipParentheses, withoutAssertions } from './syntax';
import {
  anyType,
  baseTypeOfLiteral,
  bigintType,
  errorType,
  intersectionOf,
  isAnyLike,
  isPropertyKeyLiteral,
  type LiteralType,
  literalType,
  mapType,
  neverType,
  numberType,
  type ObjectType,
  type Property,
  propertyAccessType,
  regularOf,
  type Type,
  typeMembers,
  unionOf,
} from './types';

interface AssignmentTargetOptions {
  evaluate?: (expression: TreeNode, conditional: boolean) => void;
  expressionTypes?: ReadonlyMap<number, Type>;
  inferField?: boolean;
}

/** Checks assignments, compound assignments, and updates, narrowing the references they assign. */
export class AssignmentChecker {
  constructor(private readonly c: Checker) {}

  assignment(node: TreeNode): Type {
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    const leftExpression = skipParentheses(left);
    if (isAssignmentPattern(leftExpression)) {
      const expressionTypes = new Map<number, Type>();
      this.checkPatternExpressions(leftExpression, expressionTypes);
      const implied = this.patternContext(leftExpression, expressionTypes);
      const valueType = this.c.expressions.check(right, implied);
      if (implied) this.c.expressions.checkExcessProperties(right, valueType, implied);
      this.destructuringAssignment(leftExpression, valueType, expressionTypes);
      return valueType;
    }
    if (this.isEvolvingArrayAssignment(leftExpression)) {
      this.c.expressions.check(leftExpression.childForFieldName('index') as TreeNode);
      const valueType = this.c.expressions.checkWidened(right);
      this.evolve(leftExpression.childForFieldName('object') as TreeNode, valueType);
      return valueType;
    }
    const targetType = this.targetType(left, false);
    const valueType = this.c.expressions.checkAssignedValue(right, targetType === errorType ? undefined : targetType);
    this.c.expressions.expandos.recordAssignment(node, valueType);
    if (targetType !== errorType) this.c.expressions.checkAssignable(leftExpression, valueType, targetType, right);
    this.assignReference(leftExpression, targetType, valueType);
    return valueType;
  }

  // TypeScript binds the pattern's expressions before the initializer, then applies the destructured writes.
  private checkPatternExpressions(pattern: TreeNode, types: Map<number, Type>): void {
    const target = skipParentheses(pattern);
    const defaultTarget = defaultedTarget(target);
    if (defaultTarget) {
      const value = target.childForFieldName('right') as TreeNode;
      const nested = isAssignmentPattern(skipParentheses(defaultTarget));
      if (!nested) this.checkPatternExpressions(defaultTarget, types);
      types.set(value.id, this.c.expressions.check(value));
      if (nested) this.checkPatternExpressions(defaultTarget, types);
    } else if (isAssignmentPattern(target)) {
      for (const child of named(target)) this.checkPatternExpressions(child, types);
    } else if (target.type === 'pair' || target.type === 'pair_pattern') {
      const key = target.childForFieldName('key') as TreeNode;
      if (key.type === 'computed_property_name') types.set(key.id, this.c.expressions.check(named(key)[0]));
      this.checkPatternExpressions(target.childForFieldName('value') as TreeNode, types);
    } else if (target.type === 'spread_element' || target.type === 'rest_pattern') {
      this.checkPatternExpressions(named(target)[0], types);
    } else {
      types.set(pattern.id, this.targetType(pattern, false));
    }
  }

  private patternContext(pattern: TreeNode, expressionTypes?: ReadonlyMap<number, Type>): Type | undefined {
    return this.c.patterns.impliedType(pattern, (element) => {
      const target = defaultedTarget(element) ?? element;
      const declared = expressionTypes?.get(target.id) ?? this.targetType(target, false);
      return declared === errorType ? anyType : declared;
    });
  }

  private isEvolvingArrayAssignment(target: TreeNode): boolean {
    if (target.type !== 'subscript_expression') return false;
    const object = target.childForFieldName('object');
    const key = object ? this.c.flow.referenceKey(object) : undefined;
    return key !== undefined && this.c.flow.entry(key)?.evolving === true && this.isElementWrite(target);
  }

  /** Whether `x[i] = …` writes an element, with a numeric index, which adds to the element type of an evolving array. */
  isElementWrite(subscript: TreeNode): boolean {
    const assignment = subscript.parent;
    if (assignment?.type !== 'assignment_expression' || assignment.childForFieldName('left')?.id !== subscript.id)
      return false;
    const index = subscript.childForFieldName('index') as TreeNode;
    return this.c.flow.probe(() =>
      this.c.operators.isNumberLike(this.c.silently(() => this.c.expressions.check(index)))
    );
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
  assignReference(target: TreeNode, declared: Type, assigned: Type, initializesField = true): void {
    const key = this.c.flow.referenceKey(target);
    if (!key) return;
    this.c.flow.invalidate(key);
    if (initializesField && /^this\d+\.[^.]*$/.test(key)) this.c.flow.current?.assignedFields.add(key);
    if (declared === errorType) return;
    const entry = this.c.flow.entry(key);
    const symbol = target.type === 'identifier' ? this.c.scopeOf(target).lookupValue(target.text) : undefined;
    const isAuto = symbol !== undefined && this.isAutoTyped(symbol);
    const accessor = this.accessorTypes(target);
    const type = isAuto ? this.c.widen(assigned) : this.c.flow.assignmentReduced(accessor?.read ?? declared, assigned);
    const writeType = accessor && this.c.flow.assignmentReduced(accessor.write, assigned);
    this.c.flow.set(key, { type, writeType, assigned: true, evolving: entry?.evolving }, target);
  }

  accessorTypes(target: TreeNode): { read: Type; write: Type } | undefined {
    target = skipParentheses(target);
    if (target.type !== 'member_expression' && target.type !== 'subscript_expression') return undefined;
    return this.c.flow.probe(() =>
      this.c.silently(() => {
        const object = target.childForFieldName('object') as TreeNode;
        const objectType = this.c.expressions.check(object);
        const name = this.accessorKey(target);
        if (name === undefined) return;
        const properties = (objectType.kind === 'union' ? objectType.types : [objectType]).map((member) =>
          this.c.propertyOf(member, name)
        );
        if (!properties.some((property) => property?.writeType)) return;
        return {
          read: unionOf(properties.map((property) => (property ? propertyAccessType(property) : anyType))),
          write: this.namedWriteType(objectType, literalType(name)),
        };
      })
    );
  }

  private accessorKey(target: TreeNode): string | undefined {
    const property = target.childForFieldName('property');
    if (property) return this.c.classes.propertyKey(target, property);
    const index = target.childForFieldName('index');
    const indexed = index ? this.c.expressions.check(index) : undefined;
    return indexed?.kind === 'literal' ? String(indexed.value) : undefined;
  }

  isAutoTyped(symbol: Sym, declaration = symbol.valueDeclaration): boolean {
    if (
      declaration?.type !== 'variable_declarator' ||
      (declaration.parent?.type !== 'variable_declaration' &&
        declaration.parent?.childForFieldName('kind')?.text !== 'let') ||
      declaration.childForFieldName('name')?.type !== 'identifier' ||
      declaration.childForFieldName('type')
    )
      return false;
    const value = declaration.childForFieldName('value');
    if (!value) return true;
    const initializer = skipParentheses(value);
    return initializer.type === 'null' || this.c.isGlobalUndefined(initializer);
  }

  destructuringAssignment(pattern: TreeNode, type: Type, expressionTypes?: ReadonlyMap<number, Type>): void {
    this.assignmentTargets(
      pattern,
      type,
      (target, valueType) => {
        const declared = expressionTypes?.get(target.id) ?? this.targetType(target, false);
        if (declared !== errorType && !this.c.relations.isAssignable(valueType, declared))
          this.c.expressions.reportNotAssignable(target, valueType, declared);
        this.assignReference(skipParentheses(target), declared, valueType);
      },
      { expressionTypes }
    );
  }

  assignmentTargets(
    pattern: TreeNode,
    type: Type,
    assignLeaf: (target: TreeNode, type: Type) => void,
    options: AssignmentTargetOptions = {}
  ): void {
    const { evaluate, expressionTypes, inferField } = options;
    const assign = (target: TreeNode, valueType: Type): void => {
      const left = defaultedTarget(target);
      if (left) {
        const right = target.childForFieldName('right') as TreeNode;
        evaluate?.(right, true);
        const defaultType =
          expressionTypes?.get(right.id) ??
          (inferField ? this.assignmentValueType(right) : this.c.expressions.check(right));
        assign(left, unionOf([this.c.relations.removeUndefined(valueType), regularOf(defaultType)]));
        return;
      }
      const unwrapped = skipParentheses(target);
      if (isAssignmentPattern(unwrapped)) {
        if (unwrapped.type === 'array' || unwrapped.type === 'array_pattern')
          this.destructuringArrayAssignment(unwrapped, valueType, assign);
        else this.destructuringObjectAssignment(unwrapped, valueType, assign, options);
        return;
      }
      evaluate?.(target, false);
      assignLeaf(target, valueType);
    };
    assign(pattern, type);
  }

  assignmentValueType(expression: TreeNode, pattern?: TreeNode): Type {
    const value = skipParentheses(expression);
    const right = value.type === 'assignment_expression' ? value.childForFieldName('right') : undefined;
    if (right) return this.assignmentValueType(right);
    return pattern
      ? this.c.expressions.deferredContexts.with(
          value,
          () => this.patternContext(pattern),
          () => this.c.expressions.check(expression)
        )
      : this.c.expressions.check(expression);
  }

  private destructuringArrayAssignment(
    pattern: TreeNode,
    type: Type,
    assign: (target: TreeNode, type: Type) => void
  ): void {
    if (isEmptyPattern(pattern)) this.c.patterns.iteratedType(pattern, type);
    for (const { element, index } of arrayPatternElements(pattern)) {
      if (element.type === 'spread_element' || element.type === 'rest_pattern') {
        assign(named(element)[0], this.c.patterns.restOfIterable(pattern, type, index));
        break;
      }
      assign(element, this.c.patterns.elementAt(element, type, index));
    }
  }

  // code-gauge-allow functionNcss 34 -- Keeps object assignment targets with computed key evaluation, key transport, and rest flow typing.
  private destructuringObjectAssignment(
    pattern: TreeNode,
    type: Type,
    assign: (target: TreeNode, type: Type) => void,
    { evaluate, expressionTypes, inferField }: AssignmentTargetOptions
  ): void {
    // Unlike a declaration's pattern, an assignment's empty object pattern accepts `void`, as TypeScript does.
    if (isEmptyPattern(pattern)) this.c.members.checkNonNullable(pattern, type);
    const used: Type[] = [];
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier':
        case 'shorthand_property_identifier_pattern': {
          used.push(literalType(element.text));
          assign(element, this.c.patterns.destructuredProperty(element, type, element.text));
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          used.push(literalType(left.text));
          assign(element, this.c.patterns.destructuredProperty(left, type, left.text, true));
          break;
        }
        case 'pair':
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          if (key.type === 'computed_property_name') evaluate?.(key, false);
          const computedType =
            expressionTypes?.get(key.id) ??
            (inferField && key.type === 'computed_property_name' ? this.assignmentValueType(named(key)[0]) : undefined);
          const selected = this.c.patterns.destructuredKey(
            key,
            type,
            defaultedTarget(value) !== undefined,
            computedType
          );
          used.push(selected.keyType);
          assign(value, selected.type);
          break;
        }
        case 'spread_element':
        case 'rest_pattern': {
          const target = named(element)[0];
          assign(target, inferField ? anyType : this.objectRestAssignmentType(target, type, used));
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private objectRestAssignmentType(target: TreeNode, source: Type, omitted: Type[]): Type {
    const identifier = skipParentheses(target);
    const symbol =
      identifier.type === 'identifier' ? this.c.scopeOf(identifier).lookupValue(identifier.text) : undefined;
    return symbol && this.isAutoTyped(symbol) ? anyType : this.c.patterns.restObject(source, omitted);
  }

  compoundAssignment(node: TreeNode): Type {
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    const operator = node.childForFieldName('operator')?.text ?? '+=';
    const declared = this.declaredTargetType(left);
    const targetType = this.targetType(left, true);
    if (operator === '&&=' || operator === '||=' || operator === '??=') {
      // The right operand runs only on some paths, so its effects join the path that skips it.
      const { skipped, evaluating } = this.logicalAssignmentPaths(left, operator);
      let valueType: Type = neverType;
      const evaluated = this.c.flow.from(evaluating, () => {
        valueType = this.c.expressions.check(right, targetType);
      });
      this.c.flow.current = this.c.flow.merge([skipped, evaluated]);
      if (targetType !== errorType) this.c.expressions.checkAssignable(skipParentheses(left), valueType, declared);
      const result = this.logicalAssignmentType(operator, targetType, valueType);
      // The target holds what it kept or what was assigned, as `s ||= "x"` leaves a truthy `s` or `"x"`.
      if (targetType !== errorType) this.assignReference(skipParentheses(left), declared, result, operator !== '&&=');
      return result;
    }
    const reference = skipParentheses(left);
    const writeType = this.compoundWriteType(reference, declared, targetType);
    const valueType = this.c.expressions.check(right);
    const resultType = this.c.operators.binaryOperatorType(
      node,
      operator.slice(0, -1),
      left,
      right,
      targetType,
      valueType
    );
    if (
      targetType !== errorType &&
      resultType !== errorType &&
      (operator === '+=' || this.c.operators.hasNumericOperands(left, right, targetType, valueType))
    )
      this.c.expressions.checkAssignable(reference, resultType, mapType(writeType, baseTypeOfLiteral));
    this.recordCompoundWrite(reference, declared);
    return resultType;
  }

  private compoundWriteType(reference: TreeNode, declared: Type, read: Type): Type {
    if (reference.type !== 'member_expression' && reference.type !== 'subscript_expression') return read;
    const entry = this.referenceFlow(reference);
    return entry ? intersectionOf([declared, entry.writeType ?? entry.type], this.c) : declared;
  }

  private recordCompoundWrite(reference: TreeNode, declared: Type): void {
    const key = this.c.flow.referenceKey(reference);
    if (!key) return;
    this.c.flow.invalidate(key);
    if (declared === errorType) return;
    const entry = this.c.flow.entry(key);
    const accessor = this.accessorTypes(reference);
    const read = entry?.type ?? accessor?.read ?? declared;
    const write = entry?.writeType ?? accessor?.write;
    const type = mapType(read, baseTypeOfLiteral);
    const writeType = write && mapType(write, baseTypeOfLiteral);
    if (entry || type !== read || writeType !== write)
      this.c.flow.set(key, { ...entry, type, writeType, assigned: entry?.assigned ?? true }, reference);
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
    return this.c.flow.probe(() => this.c.silently(() => this.targetType(left, false)));
  }

  update(node: TreeNode): Type {
    const argument = node.childForFieldName('argument') as TreeNode;
    const declared = this.declaredTargetType(argument);
    const type = this.targetType(argument, true);
    if (type === errorType) return numberType;
    // As TypeScript's `checkNonNullType`, then its arithmetic operand check, which rejects `void`.
    const operand = this.c.members.checkNonNullable(argument, type);
    if (operand === errorType) return numberType;
    if (!this.c.operators.isNumericOperand(operand)) {
      this.c.error(argument, '++ や -- を使える値は、number 型、bigint 型、any 型のものだけです。');
      return numberType;
    }
    const result = this.c.operators.isBigintLike(operand) ? bigintType : numberType;
    this.recordCompoundWrite(skipParentheses(argument), declared);
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
      case 'as_expression':
      case 'type_assertion': {
        return this.assertedTargetType(target, expression);
      }
      default: {
        this.c.error(target, '代入の左辺には、変数かプロパティを書いてください。');
        return errorType;
      }
    }
  }

  /**
   * The type of an asserted target, as `(x as number)` in `(x as number) = 2`. As in TypeScript, the target takes the
   * asserted type and reads the reference it wraps, which therefore counts neither as assigned nor as written to, so
   * that a constant or a read-only property there is accepted and the flow keeps what it knew of the reference.
   */
  private assertedTargetType(target: TreeNode, expression: TreeNode): Type {
    const reference = withoutAssertions(expression);
    if (!['identifier', 'member_expression', 'subscript_expression'].includes(reference.type)) {
      this.c.error(target, '代入の左辺には、変数かプロパティを書いてください。');
      return errorType;
    }
    if (isOptionalChain(reference)) {
      this.c.error(target, 'オプショナルチェーン ?. を含む式には代入できません。');
      return errorType;
    }
    return this.c.expressions.check(expression);
  }

  private variableTargetType(expression: TreeNode, compound: boolean): Type {
    if (this.c.isGlobalUndefined(expression)) {
      this.c.error(expression, "変数ではないため、'undefined' に割り当てられません。");
      return errorType;
    }
    const symbol = this.c.scopeOf(expression).lookupValue(expression.text);
    if (!symbol) {
      this.c.error(
        expression,
        `名前 ${expression.text} が見つかりません。${nameSuggestionHint(this.c.scopeOf(expression), expression.text, 'value', this.c.budget)}`
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
    const objectType = this.c.members.targetReceiverType(expression, objectNode);
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
    const type = this.c.members.propertyAccess(expression, objectNode, propertyNode, objectType, propertyNode.text, {
      write: true,
    });
    if (type === errorType) return type;
    if (compound) return this.referenceFlow(expression)?.type ?? type;
    return this.namedWriteType(objectType, literalType(key));
  }

  private elementTargetType(expression: TreeNode, compound: boolean): Type {
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const indexNode = expression.childForFieldName('index') as TreeNode;
    const objectType = this.c.members.targetReceiverType(expression, objectNode);
    const indexType = this.c.members.indexTypeOf(indexNode);
    const readonlyKey = typeMembers(indexType)
      .filter(isPropertyKeyLiteral)
      .find((key) => this.isReadonlyProperty(expression, objectType, String(key.value)));
    if (readonlyKey) {
      this.c.error(
        indexNode,
        `${printedPropertyName(String(readonlyKey.value), readonlyKey)} は読み取り専用のプロパティなので、代入できません。`
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
    const writeType = this.c.members.indexedType(expression, objectNode, indexNode, objectType, indexType, {
      readsField: compound,
      write: true,
    });
    if (writeType === errorType) return writeType;
    if (this.c.members.isReadonlyMappedWrite(objectType, indexType))
      return this.reportReadonlyIndex(expression, objectType);
    const flow = compound ? this.referenceFlow(expression) : undefined;
    return flow?.writeType ?? flow?.type ?? writeType;
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

  private referenceFlow(reference: TreeNode): FlowEntry | undefined {
    const key = this.c.flow.referenceKey(reference);
    return key === undefined ? undefined : this.c.flow.entry(key);
  }

  private namedWriteType(type: Type, key: LiteralType): Type {
    if (isAnyLike(type)) return type;
    const property = this.c.propertyOf(type, String(key.value));
    if (property) return propertyAccessType(property, 'write');
    const apparent = this.c.apparentType(type);
    if (isAnyLike(apparent)) return apparent;
    return applicableIndex(this.c, this.c.structureOf(type), key)?.type ?? errorType;
  }

  private reportReadonlyIndex(expression: TreeNode, objectType: Type): Type {
    this.c.error(expression, `型 '${this.c.print(objectType)}' のインデックスは読み取り専用です。`);
    return errorType;
  }
}

function isAssignmentPattern(node: TreeNode): boolean {
  return ['array', 'object', 'array_pattern', 'object_pattern'].includes(node.type);
}
