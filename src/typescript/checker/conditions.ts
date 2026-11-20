// code-gauge-allow-file fileNcss 445 -- Builds and checks conditional flow for each expression form.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { State } from './flow';
import { InlinedConditions } from './inlinedConditions';
import type { Sym } from './scopes';
import {
  arrayPatternElements,
  chainObject,
  isOptionalChain,
  named,
  numberValue,
  patternIdentifiers,
  skipParentheses,
  stringValue,
  withoutAssertions,
} from './syntax';
import {
  anyType,
  booleanType,
  filterType,
  isAnyLike,
  isIntrinsic,
  isPropertyKeyLiteral,
  neverType,
  nullType,
  regularOf,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';

/** The flow states where a condition is true and where it is false, with the condition's type. */
export interface Condition {
  whenTrue: State;
  whenFalse: State;
  type: Type;
}

const parenthesizedConditionStatements = new Set(['if_statement', 'while_statement', 'do_statement']);

/** The kinds of expressions that are objects, which are always truthy. */
const alwaysTruthyTypes = new Set(['array', 'arrow_function', 'class', 'function_expression', 'object', 'regex']);

/** Checks conditions, computing the flow states where they are true and false. */
export class ConditionChecker {
  private readonly inlined: InlinedConditions;
  private readonly logicalRightTypes = new Map<number, Type>();
  private readonly propertyDeclarations = new Map<number, number>();

  constructor(private readonly c: Checker) {
    this.inlined = new InlinedConditions(c);
  }

  /** Checks a condition, returning the flow states where it is true and where it is false. */
  checkCondition(node: TreeNode, body?: TreeNode): { whenTrue: State; whenFalse: State } {
    // Tree-sitter includes the statement's required parentheses, while tsc's condition starts inside them.
    const expression =
      node.type === 'parenthesized_expression' && parenthesizedConditionStatements.has(node.parent?.type ?? '')
        ? named(node)[0]
        : node;
    const { type, whenTrue, whenFalse } = this.condition(expression);
    if (body) this.checkUncalledFunction(expression, type, body);
    return { whenTrue, whenFalse };
  }

  condition(node: TreeNode, testsTruthiness = true): Condition {
    const result = this.conditionOf(node);
    if (node.type === 'true') result.whenFalse = undefined;
    if (node.type === 'false') result.whenTrue = undefined;
    if (testsTruthiness) this.checkTruthiness(node, result.type);
    return result;
  }

  // code-gauge-allow functionNcss 31 -- Computes branch states for each kind of narrowing expression.
  private conditionOf(node: TreeNode): Condition {
    const expression = skipParentheses(node);
    switch (expression.type) {
      case 'unary_expression': {
        if (expression.childForFieldName('operator')?.text !== '!') break;
        const argument = expression.childForFieldName('argument') as TreeNode;
        // The binder folds Boolean literal condition nodes, without folding a literal inside unary negation.
        const inner = this.conditionOf(argument);
        this.checkTruthiness(argument, inner.type);
        return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue, type: booleanType };
      }
      case 'binary_expression': {
        const result = this.binaryCondition(expression);
        if (result) return result;
        break;
      }
      case 'call_expression': {
        return this.c.members.chainCondition(expression, () => this.callCondition(expression));
      }
      case 'identifier': {
        const aliased = this.inlined.aliasedCondition(expression);
        if (aliased) return aliased;
        break;
      }
      case 'assignment_expression': {
        const type = this.c.expressions.check(expression);
        const left = skipParentheses(expression.childForFieldName('left') as TreeNode);
        return {
          ...this.narrowed(left, (current, assumeTrue) => this.c.flow.narrowByTruthiness(current, assumeTrue)),
          type,
        };
      }
      default: {
        break;
      }
    }
    return this.c.members.chainCondition(expression, () => {
      const type = this.c.expressions.check(expression);
      return { ...this.truthiness(expression), type };
    });
  }

  /** The condition a binary expression is, if its operator narrows. */
  private binaryCondition(expression: TreeNode): Condition | undefined {
    const operator = expression.childForFieldName('operator')?.text ?? '';
    const left = expression.childForFieldName('left') as TreeNode;
    const right = expression.childForFieldName('right') as TreeNode;
    if (operator === '&&' || operator === '||') return this.logicalCondition(operator, left, right);
    if (!['===', '!==', '==', '!=', 'instanceof', 'in'].includes(operator)) return undefined;
    const { type, leftType, rightType } = this.c.operators.checkBinaryOperands(expression, operator, left, right);
    if (operator === 'instanceof') {
      const instance = this.instanceTypeOfConstructor(rightType);
      const { whenTrue, whenFalse } = this.narrowed(left, (current, assumeTrue) =>
        this.c.flow.narrowByInstanceof(current, instance, assumeTrue)
      );
      return { whenTrue: this.chainEvaluated(whenTrue, left), whenFalse, type };
    }
    if (operator === 'in') return { ...this.inCondition(expression, left, right, leftType), type };
    return { ...this.narrowEquality(left, right, operator, leftType, rightType), type };
  }

  private inCondition(expression: TreeNode, left: TreeNode, right: TreeNode, key: Type): Omit<Condition, 'type'> {
    if (left.type === 'private_property_identifier') {
      const brand = this.c.classes.privateNameBrand(left);
      if (brand)
        return this.narrowed(right, (current, assumeTrue) =>
          this.c.flow.narrowByPrivateBrand(current, brand, assumeTrue)
        );
    }
    return isPropertyKeyLiteral(key)
      ? this.narrowed(right, (current, assumeTrue) => this.c.flow.narrowByIn(current, key, assumeTrue))
      : this.truthiness(expression);
  }

  private logicalCondition(operator: '&&' | '||', left: TreeNode, right: TreeNode): Condition {
    const leftResult = this.condition(left);
    const rightState = operator === '&&' ? leftResult.whenTrue : leftResult.whenFalse;
    let rightResult: Condition = { whenTrue: undefined, whenFalse: undefined, type: neverType };
    this.c.flow.from(rightState, () => {
      rightResult = this.condition(right, false);
    });
    this.checkLogicalOperands(left, leftResult.type, right, rightResult.type);
    const merged =
      operator === '&&'
        ? {
            whenTrue: rightResult.whenTrue,
            whenFalse: this.c.flow.merge([leftResult.whenFalse, rightResult.whenFalse]),
          }
        : {
            whenTrue: this.c.flow.merge([leftResult.whenTrue, rightResult.whenTrue]),
            whenFalse: rightResult.whenFalse,
          };
    this.c.flow.current = this.c.flow.merge([merged.whenTrue, merged.whenFalse]);
    const truthy = this.c.flow.narrowByTruthiness(leftResult.type, operator === '||');
    return {
      ...merged,
      type: unionOf([
        operator === '&&' ? this.c.flow.narrowByTruthiness(leftResult.type, false) : truthy,
        rightResult.type,
      ]),
    };
  }

  /** Whether every variable an expression refers to is a constant, or a parameter or variable never reassigned. */
  private narrowsOnlyConstantReferences(expression: TreeNode): boolean {
    if (['arrow_function', 'function_expression', 'class'].includes(expression.type)) return false;
    if (expression.type === 'identifier') {
      const symbol = this.c.scopeOf(expression).lookupValue(expression.text);
      return !symbol?.valueKind || symbol.valueKind === 'const' || !symbol.isReassigned;
    }
    return named(expression).every((child) => this.narrowsOnlyConstantReferences(child));
  }

  /** The condition a call is, narrowing what its signature's type predicate tests. */
  private callCondition(expression: TreeNode): Condition {
    const cached = this.c.flow.narrowingScope?.reuseCallPredicates
      ? this.c.expressions.calls.predicateOf(expression)
      : undefined;
    const type = cached ? booleanType : this.c.expressions.check(expression);
    const predicate = cached ?? this.c.expressions.calls.predicateOf(expression);
    if (!predicate) return { ...this.truthiness(expression), type };
    const { target, type: predicateType } = predicate;
    const { whenTrue, whenFalse } = this.narrowed(target, (current, assumeTrue) =>
      assumeTrue
        ? this.c.flow.narrowByPredicate(current, predicateType)
        : filterType(current, (member) => !this.c.relations.isAssignable(member, predicateType))
    );
    const excludesUndefined = !this.c.relations.isAssignable(undefinedType, predicateType);
    return { whenTrue: excludesUndefined ? this.chainEvaluated(whenTrue, target) : whenTrue, whenFalse, type };
  }

  /** Reports a tested expression that is `void`, or that is always truthy or always falsy by its syntax. */
  checkTruthiness(node: TreeNode, type: Type): void {
    if (isIntrinsic(type, 'void')) {
      this.c.error(node, "'void' 型の式は、真偽の判定に使えません。");
      return;
    }
    const semantics = this.syntacticTruthiness(node);
    if (semantics === 'always') this.c.error(node, 'この種類の式は、常に真になります。');
    else if (semantics === 'never') this.c.error(node, 'この種類の式は、常に偽になります。');
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of expression whose syntax decides its truthiness.
  private syntacticTruthiness(node: TreeNode): 'always' | 'never' | 'sometimes' {
    const expression = withoutAssertions(node);
    if (alwaysTruthyTypes.has(expression.type)) return 'always';
    switch (expression.type) {
      case 'number': {
        const value = numberValue(expression.text);
        return value === 0 || value === 1 ? 'sometimes' : 'always';
      }
      case 'null': {
        return 'never';
      }
      case 'unary_expression': {
        return expression.childForFieldName('operator')?.text === 'void' ? 'never' : 'sometimes';
      }
      case 'string': {
        return stringValue(expression) ? 'always' : 'never';
      }
      case 'template_string': {
        if (named(expression).some((child) => child.type === 'template_substitution')) return 'sometimes';
        return named(expression).some((child) => child.text !== '') ? 'always' : 'never';
      }
      case 'ternary_expression': {
        const a = this.syntacticTruthiness(expression.childForFieldName('consequence') as TreeNode);
        const b = this.syntacticTruthiness(expression.childForFieldName('alternative') as TreeNode);
        return a === b ? a : 'sometimes';
      }
      case 'identifier':
      case 'undefined': {
        return this.c.isGlobalUndefined(expression) ? 'never' : 'sometimes';
      }
      default: {
        return 'sometimes';
      }
    }
  }

  checkLogicalOperands(left: TreeNode, leftType: Type, right: TreeNode, rightType: Type): void {
    if (this.c.silent) return;
    this.logicalRightTypes.set(right.id, rightType);
    let outer = left.parent?.parent;
    while (outer && (outer.type === 'parenthesized_expression' || logicalOperator(outer))) {
      this.c.budget.spend();
      outer = outer.parent;
    }
    const body = outer?.type === 'if_statement' ? outer.childForFieldName('consequence') : undefined;
    if (logicalOperator(left.parent) === '&&' || body) this.checkUncalledFunction(left, leftType, body);
  }

  recordPropertyDeclaration(node: TreeNode, declaration: TreeNode | undefined): void {
    if (this.c.silent || node.type !== 'member_expression') return;
    if (declaration) this.propertyDeclarations.set(node.id, declaration.id);
    else this.propertyDeclarations.delete(node.id);
  }

  checkUncalledFunction(condition: TreeNode, type: Type, body?: TreeNode | null): void {
    if (this.c.silent) return;
    const pending = [skipParentheses(condition)];
    while (pending.length > 0) {
      this.c.budget.spend();
      const tested = pending.pop() as TreeNode;
      const operator = logicalOperator(tested);
      if (!operator) {
        this.reportUncalledFunction(tested, type, body);
        continue;
      }
      const right = tested.childForFieldName('right') as TreeNode;
      const rightExpression = skipParentheses(right);
      if (operator !== '&&') pending.push(skipParentheses(tested.childForFieldName('left') as TreeNode));
      if (logicalOperator(rightExpression)) pending.push(rightExpression);
      else this.reportUncalledFunction(rightExpression, this.logicalRightTypes.get(right.id) ?? type, body, tested);
    }
  }

  private reportUncalledFunction(
    tested: TreeNode,
    type: Type,
    body: TreeNode | null | undefined,
    chainNode: TreeNode = tested
  ): void {
    if (!this.isAlwaysDefinedFunction(tested, type)) return;
    if (this.usedInConjunction(chainNode, tested) || (body && this.refersTo(named(body), tested))) return;
    this.c.error(tested, 'この関数は常に定義されているので、この条件は常に真になります。呼び出すつもりでしたか？');
  }

  private usedInConjunction(node: TreeNode, reference: TreeNode): boolean {
    const propertyDeclaration = this.propertyDeclarations.get(reference.id);
    let chain = node.parent;
    while (chain && logicalOperator(chain) === '&&') {
      this.c.budget.spend();
      const right = chain.childForFieldName('right') as TreeNode;
      if (
        (reference.type === 'member_expression' && this.isSameReference(right, reference)) ||
        this.refersTo(reference.type === 'member_expression' ? [right] : named(right), reference, propertyDeclaration)
      )
        return true;
      chain = chain.parent;
    }
    return false;
  }

  private refersTo(pending: TreeNode[], reference: TreeNode, propertyDeclaration?: number): boolean {
    while (pending.length > 0) {
      this.c.budget.spend();
      const node = pending.pop() as TreeNode;
      if (
        node.id !== reference.id &&
        (this.isSameReference(node, reference) ||
          (propertyDeclaration !== undefined && this.propertyDeclarations.get(node.id) === propertyDeclaration))
      )
        return true;
      for (const child of named(node)) pending.push(child);
    }
    return false;
  }

  private isSameReference(a: TreeNode, b: TreeNode): boolean {
    if (a.type !== b.type) return false;
    if (a.type === 'this') return true;
    if (a.type === 'identifier') {
      const symbol = this.c.scopeOf(a).lookupValue(a.text);
      return symbol !== undefined && symbol === this.c.scopeOf(b).lookupValue(b.text);
    }
    if (a.type !== 'member_expression') return false;
    return (
      a.childForFieldName('property')?.text === b.childForFieldName('property')?.text &&
      this.isSameReference(
        skipParentheses(a.childForFieldName('object') as TreeNode),
        skipParentheses(b.childForFieldName('object') as TreeNode)
      )
    );
  }

  private isAlwaysDefinedFunction(expression: TreeNode, type: Type): boolean {
    if (expression.type === 'identifier') {
      if (!this.c.scopeOf(expression).lookupValue(expression.text)) return false;
    } else if (expression.type === 'member_expression') {
      const receiver = skipParentheses(expression.childForFieldName('object') as TreeNode);
      if (receiver.type === 'as_expression' || receiver.type === 'type_assertion') return false;
    } else return false;
    return (
      !isAnyLike(type) && !this.c.relations.isNullable(type) && this.c.expressions.calls.hasCallableSignatures(type)
    );
  }

  /** The instance type a constructor creates, for `instanceof`. */
  instanceTypeOfConstructor(type: Type): Type {
    if (isAnyLike(type)) return anyType;
    const signatures = this.c.signaturesOf(type, 'construct');
    if (signatures.length > 0) {
      // A generic class's instance type takes `any` for its type arguments, which the narrowed members then supply.
      const [signature] = signatures;
      const returned =
        signature.typeParameters.length > 0
          ? this.c
              .instantiateSignature(
                { ...signature, typeParameters: [] },
                new Map(signature.typeParameters.map((parameter) => [parameter.id, anyType]))
              )
              .returnType()
          : signature.returnType();
      if (returned.kind === 'object' && returned.objectKind === 'reference' && returned.target?.typeParameters) {
        return this.c.reference(
          returned.target,
          returned.target.typeParameters.map(() => anyType)
        );
      }
      return returned;
    }
    const prototype = this.c.propertyOf(type, 'prototype');
    return prototype ? prototype.type() : anyType;
  }

  /** The states where a reference is neither `null` nor `undefined` and where it is, as `??` and `??=` test it. */
  presence(reference: TreeNode): { whenTrue: State; whenFalse: State } {
    return this.narrowed(skipParentheses(reference), (current, assumeTrue) =>
      this.c.flow.narrowByEquality(current, nullType, !assumeTrue, true)
    );
  }

  truthiness(expression: TreeNode): { whenTrue: State; whenFalse: State } {
    const { whenTrue, whenFalse } = this.narrowed(expression, (current, assumeTrue) =>
      this.c.flow.narrowByTruthiness(current, assumeTrue)
    );
    return { whenTrue: this.chainEvaluated(whenTrue, expression), whenFalse };
  }

  /** A state where an optional chain was evaluated to its end, so `a` and `a.b` are not nullish for `a?.b?.c`. */
  private chainEvaluated(state: State, chain: TreeNode): State {
    const bases: TreeNode[] = [];
    for (let current = skipParentheses(chain); isOptionalChain(current);) {
      current = skipParentheses(chainObject(current) as TreeNode);
      bases.push(current);
    }
    if (bases.length === 0) return state;
    return this.c.flow.from(state, () => {
      for (const base of bases.toReversed())
        this.c.flow.narrowReference(base, (type) => this.c.relations.removeNullish(type));
    });
  }

  /** The states where a reference is narrowed for a true and a false condition. */
  private narrowed(
    reference: TreeNode,
    narrow: (type: Type, assumeTrue: boolean) => Type
  ): { whenTrue: State; whenFalse: State } {
    const base = this.c.flow.current;
    const key = this.c.flow.referenceKey(reference);
    if (!key || !base) return { whenTrue: base?.clone(), whenFalse: base?.clone() };
    const whenTrue = this.c.flow.from(base, () => this.c.flow.narrowReference(reference, (type) => narrow(type, true)));
    const whenFalse = this.c.flow.from(base, () =>
      this.c.flow.narrowReference(reference, (type) => narrow(type, false))
    );
    this.narrowDiscriminantParent(reference, narrow, whenTrue, whenFalse);
    return { whenTrue, whenFalse };
  }

  /** Narrows `x` too when a condition tests its discriminant property `x.kind`. */
  private narrowDiscriminantParent(
    reference: TreeNode,
    narrow: (type: Type, assumeTrue: boolean) => Type,
    whenTrue: State,
    whenFalse: State
  ): void {
    const expression = skipParentheses(reference);
    const source = this.destructuredFrom(expression);
    const access = this.aliasedDiscriminantAccess(expression) ?? expression;
    const { object, name } = this.discriminantReference(access) ?? source ?? {};
    if (name === undefined || (!object && !source?.type)) return;
    if (!source && object && !this.c.flow.referenceKey(object)) return;
    const objectType = source?.type ?? this.c.flow.probe(() => this.c.expressions.checkReferenceSilently(object!));
    const nonNull = this.c.relations.removeNullish(this.c.baseConstraint(objectType));
    // As in TypeScript, the declared type decides whether the property is a discriminant, so testing the last
    // remaining member of a union still narrows it.
    const declared = source
      ? nonNull
      : this.c.relations.removeNullish(this.c.baseConstraint(this.unnarrowedType(object!)));
    const discriminantSource = declared.kind === 'union' ? declared : nonNull;
    if (!this.c.flow.isDiscriminant(discriminantSource, name)) return;
    const apply = (state: State, assumeTrue: boolean): void => {
      if (!state) return;
      const outer = this.c.flow.current;
      this.c.flow.current = state;
      try {
        const narrowed = this.c.flow.narrowByDiscriminant(nonNull, name, (propertyType) =>
          narrow(propertyType, assumeTrue)
        );
        if (object && (!source || this.narrowsOnlyConstantReferences(object)))
          this.c.flow.narrowReference(object, (type) =>
            this.c.flow.narrowByDiscriminant(type, name, (propertyType) => narrow(propertyType, assumeTrue))
          );
        this.narrowDestructuredSiblings(expression, narrowed);
      } finally {
        this.c.flow.current = outer;
      }
    };
    apply(whenTrue, true);
    apply(whenFalse, false);
  }

  private aliasedDiscriminantAccess(node: TreeNode): TreeNode | undefined {
    if (node.type !== 'identifier') return undefined;
    const symbol = this.c.scopeOf(node).lookupValue(node.text);
    const declaration = symbol?.valueDeclaration;
    if (
      symbol?.valueKind !== 'const' ||
      declaration?.type !== 'variable_declarator' ||
      declaration.childForFieldName('name')?.type !== 'identifier' ||
      declaration.childForFieldName('type')
    )
      return undefined;
    const value = declaration.childForFieldName('value');
    return value ? skipParentheses(value) : undefined;
  }

  private discriminantReference(expression: TreeNode): { object: TreeNode; name: string } | undefined {
    const object = expression.childForFieldName('object');
    if (!object) return undefined;
    const index = expression.type === 'subscript_expression' ? expression.childForFieldName('index') : undefined;
    const name =
      expression.type === 'member_expression'
        ? expression.childForFieldName('property')?.text
        : index
          ? this.c.flow.constantIndexName(index)
          : undefined;
    return name === undefined ? undefined : { object, name };
  }

  /** The type of a reference without its own narrowing in the current flow. */
  private unnarrowedType(reference: TreeNode): Type {
    const key = this.c.flow.referenceKey(reference);
    return this.c.flow.probe(() => {
      if (key) this.c.flow.current?.entries.delete(key);
      return this.c.expressions.checkReferenceSilently(reference);
    });
  }

  private narrowDestructuredSiblings(reference: TreeNode, objectType: Type): void {
    if (reference.type !== 'identifier') return;
    const symbol = this.c.scopeOf(reference).lookupValue(reference.text);
    const pattern = symbol && destructuringPattern(symbol);
    if (!pattern) return;
    for (const identifier of patternIdentifiers(pattern)) {
      const source = this.destructuredFrom(identifier);
      if (!source) continue;
      const propertyType = this.c.silently(() =>
        this.c.patterns.destructuredProperty(identifier, objectType, source.name)
      );
      this.c.flow.narrowReference(identifier, (type) => this.c.flow.narrowByEquality(type, propertyType, true, false));
    }
  }

  /**
   * Where a constant or a parameter is destructured from an object or a tuple directly, the value it is destructured
   * from and the property or the position it takes.
   */
  private destructuredFrom(identifier: TreeNode): { object?: TreeNode; name: string; type: Type } | undefined {
    if (!['identifier', 'shorthand_property_identifier_pattern'].includes(identifier.type)) return undefined;
    const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
    const declarator = symbol?.valueDeclaration;
    const pattern = symbol?.valueEntries[0]?.name;
    if (!symbol || !declarator || !pattern) return undefined;
    const pair = pattern.parent?.type === 'pair_pattern' ? pattern.parent : undefined;
    const container = pair?.parent ?? pattern.parent;
    if (!container || container.id !== destructuringPattern(symbol)?.id) return undefined;
    const object = declarator.childForFieldName('value') ?? undefined;
    const type = this.c.patterns.correlatedSources.get(container.id);
    if (!type) return undefined;
    if (container.type === 'array_pattern') {
      const position = arrayPatternElements(container).find(({ element }) => element.id === pattern.id)?.index;
      return position === undefined ? undefined : { object, name: String(position), type };
    }
    if (pattern.type === 'shorthand_property_identifier_pattern') return { object, name: pattern.text, type };
    const key = pair?.childForFieldName('key');
    const names = key ? this.c.silently(() => this.c.patterns.propertyNames(key)) : undefined;
    if (names?.length === 1) return { object, name: names[0], type };
    return undefined;
  }

  private narrowEquality(
    left: TreeNode,
    right: TreeNode,
    operator: string,
    leftType: Type,
    rightType: Type
  ): { whenTrue: State; whenFalse: State } {
    const equal = operator === '===' || operator === '==';
    const loose = operator === '==' || operator === '!=';
    const leftOperand = this.comparisonOperand(left, leftType);
    const rightOperand = this.comparisonOperand(right, rightType);
    const leftExpression = leftOperand.reference;
    const rightExpression = rightOperand.reference;
    // `typeof x === "string"`
    for (const [typeofSide, other] of [
      [leftExpression, rightOperand],
      [rightExpression, leftOperand],
    ] as const) {
      const name = typeofTag(other.reference, other.type);
      if (
        typeofSide.type === 'unary_expression' &&
        typeofSide.childForFieldName('operator')?.text === 'typeof' &&
        name !== undefined
      ) {
        const target = typeofSide.childForFieldName('argument') as TreeNode;
        const { whenTrue, whenFalse } = this.narrowed(target, (current, assumeTrue) =>
          this.c.flow.narrowByTypeof(current, name, assumeTrue === equal)
        );
        // A chain that `typeof` finds other than `"undefined"` was evaluated.
        return equal === (name !== 'undefined')
          ? { whenTrue: this.chainEvaluated(whenTrue, target), whenFalse }
          : { whenTrue, whenFalse: this.chainEvaluated(whenFalse, target) };
      }
    }
    const base = this.c.flow.current;
    let { whenTrue, whenFalse } = this.inlined.booleanComparison(
      skipParentheses(left),
      skipParentheses(right),
      equal
    ) ?? {
      whenTrue: base?.clone(),
      whenFalse: base?.clone(),
    };
    for (const [reference, otherType] of [
      [leftExpression, rightOperand.type],
      [rightExpression, leftOperand.type],
    ] as const) {
      if (!this.c.flow.referenceKey(reference)) continue;
      const narrow = (current: Type, assumeTrue: boolean): Type =>
        this.c.flow.narrowByEquality(current, regularOf(otherType), assumeTrue === equal, loose);
      whenTrue = this.c.flow.from(whenTrue, () => this.c.flow.narrowReference(reference, (type) => narrow(type, true)));
      whenFalse = this.c.flow.from(whenFalse, () =>
        this.c.flow.narrowReference(reference, (type) => narrow(type, false))
      );
      this.narrowDiscriminantParent(reference, narrow, whenTrue, whenFalse);
    }
    const states = this.chainCompared({ whenTrue, whenFalse }, leftExpression, rightOperand.type, equal, loose);
    return this.chainCompared(states, rightExpression, leftOperand.type, equal, loose);
  }

  private comparisonOperand(node: TreeNode, evaluated: Type): { reference: TreeNode; type: Type } {
    const expression = skipParentheses(node);
    const reference = comparisonReference(expression);
    if (reference.id === expression.id) return { reference, type: evaluated };
    return {
      reference,
      type: this.c.flow.referenceKey(reference) ? this.unnarrowedType(reference) : unknownType,
    };
  }

  /**
   * The states after comparing an optional chain with a value of `otherType`, where the chain was evaluated as
   * TypeScript's `narrowTypeByOptionalChainContainment` decides: `a?.b !== undefined` and `a?.b === 1` mean it was,
   * but `a?.b === x` does not where `x` may be `undefined` (or `null`, for `==`).
   */
  private chainCompared(
    states: { whenTrue: State; whenFalse: State },
    chain: TreeNode,
    otherType: Type,
    equal: boolean,
    loose: boolean
  ): { whenTrue: State; whenFalse: State } {
    const isNullable = (type: Type): boolean => isIntrinsic(type, 'undefined') || (loose && isIntrinsic(type, 'null'));
    const others = otherType.kind === 'union' ? otherType.types : [otherType];
    const allNullable = others.every((type) => isNullable(type));
    const noneNullable = others.every((type) => !isNullable(type) && !isAnyLike(type) && !isIntrinsic(type, 'unknown'));
    return {
      whenTrue: (equal ? noneNullable : allNullable) ? this.chainEvaluated(states.whenTrue, chain) : states.whenTrue,
      whenFalse: (equal ? allNullable : noneNullable) ? this.chainEvaluated(states.whenFalse, chain) : states.whenFalse,
    };
  }

  /** The state entering a `case` of a `switch` on `discriminant` (or the `default`, excluding the cases). */
  narrowSwitchCase(discriminant: TreeNode, entry: State, caseTypes: Type[], isCase: boolean): State {
    const outer = this.c.flow.current;
    this.c.flow.current = entry?.clone();
    try {
      const expression = skipParentheses(discriminant);
      if (expression.type === 'unary_expression' && expression.childForFieldName('operator')?.text === 'typeof') {
        const target = expression.childForFieldName('argument') as TreeNode;
        const names = caseTypes
          .filter((type) => type.kind === 'literal' && typeof type.value === 'string')
          .map((type) => String((type as { value: unknown }).value));
        const result = this.narrowed(target, (current) => {
          if (isCase) return unionOf(names.map((name) => this.c.flow.narrowByTypeof(current, name, true)));
          let remaining = current;
          for (const name of names) remaining = this.c.flow.narrowByTypeof(remaining, name, false);
          return remaining;
        });
        return result.whenTrue;
      }
      if (!this.c.flow.referenceKey(expression)) return this.c.flow.current;
      const result = this.narrowed(expression, (current) => {
        if (isCase)
          return unionOf(caseTypes.map((caseType) => this.c.flow.narrowByEquality(current, caseType, true, false)));
        let remaining = current;
        for (const caseType of caseTypes) remaining = this.c.flow.narrowByEquality(remaining, caseType, false, false);
        return remaining;
      });
      return result.whenTrue;
    } finally {
      this.c.flow.current = outer;
    }
  }
}

function logicalOperator(node: TreeNode | null | undefined): '&&' | '||' | '??' | undefined {
  const operator = node?.type === 'binary_expression' ? node.childForFieldName('operator')?.text : undefined;
  return operator === '&&' || operator === '||' || operator === '??' ? operator : undefined;
}

function comparisonReference(node: TreeNode): TreeNode {
  let reference = node;
  while (
    reference.type === 'assignment_expression' ||
    (reference.type === 'augmented_assignment_expression' &&
      ['&&=', '||=', '??='].includes(reference.childForFieldName('operator')?.text ?? ''))
  )
    reference = skipParentheses(reference.childForFieldName('left') as TreeNode);
  return reference;
}

/** The object or array pattern that a constant or a parameter destructures its value with directly. */
function destructuringPattern(symbol: Sym): TreeNode | undefined {
  if (!['const', 'parameter'].includes(symbol.valueKind ?? '')) return undefined;
  const declared = symbol.valueDeclaration?.childForFieldName(symbol.valueKind === 'parameter' ? 'pattern' : 'name');
  // A rest parameter destructures the tuple of the arguments it takes, as `...[kind, value]` does.
  const pattern = declared?.type === 'rest_pattern' ? named(declared)[0] : declared;
  return pattern?.type === 'object_pattern' || pattern?.type === 'array_pattern' ? pattern : undefined;
}

function typeofTag(node: TreeNode, type: Type): string | undefined {
  if (node.type === 'string') return stringValue(node);
  if (node.type !== 'template_string' || named(node).some((child) => child.type === 'template_substitution'))
    return undefined;
  return type.kind === 'literal' && typeof type.value === 'string' ? type.value : undefined;
}
