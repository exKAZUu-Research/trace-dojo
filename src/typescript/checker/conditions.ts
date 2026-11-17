import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isConstantReference } from './constantReferences';
import type { State } from './flow';
import {
  chainObject,
  isOptionalChain,
  named,
  numberValue,
  patternIdentifiers,
  skipParentheses,
  stringValue,
} from './syntax';
import {
  anyType,
  booleanType,
  filterType,
  isAnyLike,
  isIntrinsic,
  neverType,
  nullType,
  regularOf,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** The flow states where a condition is true and where it is false, with the condition's type. */
interface Condition {
  whenTrue: State;
  whenFalse: State;
  type: Type;
}

/** The kinds of expressions that are objects, which are always truthy. */
const alwaysTruthyTypes = new Set(['array', 'arrow_function', 'class', 'function_expression', 'object', 'regex']);

/** The kinds of expressions that declare or assign when checked. */
const sideEffectTypes = new Set([
  'arrow_function',
  'assignment_expression',
  'augmented_assignment_expression',
  'class',
  'function_expression',
  'update_expression',
]);

/** Checks conditions, computing the flow states where they are true and false. */
export class ConditionChecker {
  /** How many aliased conditions are being inlined into each other. */
  private aliasDepth = 0;

  constructor(private readonly c: Checker) {}

  /** Checks a condition, returning the flow states where it is true and where it is false. */
  checkCondition(node: TreeNode): { whenTrue: State; whenFalse: State } {
    const { whenTrue, whenFalse } = this.condition(node);
    return { whenTrue, whenFalse };
  }

  condition(node: TreeNode, testsTruthiness = true): Condition {
    const result = this.conditionOf(node);
    if (testsTruthiness) this.checkTruthiness(node, result.type);
    return result;
  }

  private conditionOf(node: TreeNode): Condition {
    const expression = skipParentheses(node);
    switch (expression.type) {
      case 'unary_expression': {
        if (expression.childForFieldName('operator')?.text !== '!') break;
        const inner = this.condition(expression.childForFieldName('argument') as TreeNode);
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
        const aliased = this.aliasedCondition(expression);
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
    if (['===', '!==', '==', '!='].includes(operator)) {
      const type = this.c.expressions.check(expression);
      return { ...this.narrowEquality(left, right, operator), type };
    }
    if (operator === 'instanceof') {
      const type = this.c.expressions.check(expression);
      const instance = this.c.silently(() => this.instanceTypeOfConstructor(this.c.expressions.check(right)));
      const { whenTrue, whenFalse } = this.narrowed(left, (current, assumeTrue) =>
        this.c.flow.narrowByInstanceof(current, instance, assumeTrue)
      );
      return { whenTrue: this.chainEvaluated(whenTrue, left), whenFalse, type };
    }
    const key = operator === 'in' ? this.c.silently(() => this.c.expressions.check(left)) : undefined;
    if (key?.kind === 'literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
      const type = this.c.expressions.check(expression);
      const name = String(key.value);
      return {
        ...this.narrowed(right, (current, assumeTrue) => this.c.flow.narrowByIn(current, name, assumeTrue)),
        type,
      };
    }
    return undefined;
  }

  private logicalCondition(operator: '&&' | '||', left: TreeNode, right: TreeNode): Condition {
    const leftResult = this.condition(left);
    const rightState = operator === '&&' ? leftResult.whenTrue : leftResult.whenFalse;
    let rightResult: Condition = { whenTrue: undefined, whenFalse: undefined, type: neverType };
    this.c.flow.from(rightState, () => {
      rightResult = this.condition(right, false);
    });
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

  /**
   * The condition a constant stands for, as `const isText = typeof x === "string"` narrows `x` where `isText` is
   * tested. As in TypeScript, it narrows only references that cannot change after it, through up to five constants.
   */
  private aliasedCondition(identifier: TreeNode): Condition | undefined {
    const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
    const declarator = symbol?.valueDeclaration;
    if (symbol?.valueKind !== 'const' || declarator?.type !== 'variable_declarator') return undefined;
    const value = declarator.childForFieldName('value');
    if (declarator.childForFieldName('name')?.type !== 'identifier' || declarator.childForFieldName('type')) {
      return undefined;
    }
    const outerScope = this.c.flow.narrowingScope;
    if (!value || this.aliasDepth >= 5 || hasSideEffects(value)) return undefined;
    const type = this.c.expressions.check(identifier);
    const base = this.c.flow.current;
    const keys = new Set<string>();
    this.c.flow.narrowingScope = { accepts: (node) => isConstantReference(this.c, node), keys };
    this.aliasDepth++;
    let aliased: Condition;
    try {
      aliased = this.c.silently(() => this.condition(value, false));
    } finally {
      this.aliasDepth--;
      this.c.flow.narrowingScope = outerScope;
      this.c.flow.current = base;
    }
    for (const key of keys) outerScope?.keys.add(key);
    return {
      whenTrue: this.aliasNarrowed(base, aliased.whenTrue, keys, identifier, true),
      whenFalse: this.aliasNarrowed(base, aliased.whenFalse, keys, identifier, false),
      type,
    };
  }

  /**
   * `base` with the narrowing of `keys` in `aliased` and of the constant `identifier` by its truthiness, apart from
   * what else checking the aliased condition again changed.
   */
  private aliasNarrowed(
    base: State,
    aliased: State,
    keys: Set<string>,
    identifier: TreeNode,
    assumeTrue: boolean
  ): State {
    const result = aliased && base?.clone();
    for (const key of keys) {
      const entry = aliased?.entries.get(key);
      if (entry) result?.entries.set(key, entry);
    }
    return this.c.flow.from(result, () =>
      this.c.flow.narrowReference(identifier, (current) => this.c.flow.narrowByTruthiness(current, assumeTrue))
    );
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
    const type = this.c.expressions.check(expression);
    const predicate = this.c.expressions.calls.predicateOf(expression);
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
      case 'null':
      case 'undefined': {
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
      case 'identifier': {
        return expression.text === 'undefined' && !this.c.scopeOf(expression).lookupValue('undefined')?.valueDeclaration
          ? 'never'
          : 'sometimes';
      }
      default: {
        return 'sometimes';
      }
    }
  }

  /** Reports `if (obj.method)` where the method is always defined and the body never calls it. */
  checkUncalledFunction(condition: TreeNode, body: TreeNode | null): void {
    const tested = skipParentheses(condition);
    const candidates =
      tested.type === 'binary_expression' && tested.childForFieldName('operator')?.text === '&&'
        ? [tested.childForFieldName('left') as TreeNode, tested.childForFieldName('right') as TreeNode]
        : [tested];
    for (const candidate of candidates) {
      const expression = skipParentheses(candidate);
      if (!this.isAlwaysDefinedFunction(expression)) continue;
      // A function the body or the rest of the condition uses was tested on purpose, as `if (p.run) queue.push(p.run)`.
      const usedElsewhere = [body, tested].some((scope) => scope && this.refersTo(scope, expression));
      if (usedElsewhere) continue;
      this.c.error(
        expression,
        'この関数は常に定義されているので、この条件は常に真になります。呼び出すつもりでしたか？'
      );
    }
  }

  /** Whether a node contains a reference, other than `reference` itself, to what `reference` refers to. */
  private refersTo(scope: TreeNode, reference: TreeNode): boolean {
    if (scope.id !== reference.id && this.isSameReference(scope, reference)) return true;
    return named(scope).some((child) => this.refersTo(child, reference));
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

  /** Whether a reference is a function that is always defined: neither nullable nor an optional property. */
  private isAlwaysDefinedFunction(expression: TreeNode): boolean {
    if (expression.type !== 'identifier' && expression.type !== 'member_expression') return false;
    const type = this.c.expressions.checkReferenceSilently(expression);
    if (isAnyLike(type) || this.c.relations.isNullable(type) || type.kind !== 'object') return false;
    if (this.c.signaturesOf(type, 'call').length === 0) return false;
    if (expression.type !== 'member_expression') return true;
    const objectType = this.c.expressions.checkReferenceSilently(expression.childForFieldName('object') as TreeNode);
    const property = this.c.propertyOf(
      this.c.relations.removeNullish(objectType),
      expression.childForFieldName('property')?.text ?? ''
    );
    return property !== undefined && !property.optional;
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
    const { object, name } =
      expression.type === 'member_expression'
        ? {
            object: expression.childForFieldName('object') as TreeNode,
            name: expression.childForFieldName('property')?.text ?? '',
          }
        : (source ?? {});
    if (name === undefined || (!object && !source?.type)) return;
    const objectType = source?.type ?? this.c.expressions.checkReferenceSilently(object!);
    const nonNull = this.c.relations.removeNullish(objectType);
    // As in TypeScript, the declared type decides whether the property is a discriminant, so testing the last
    // remaining member of a union still narrows it.
    const declared = source ? nonNull : this.c.relations.removeNullish(this.unnarrowedType(object!));
    const discriminantSource = declared.kind === 'union' || nonNull.kind === 'union' ? declared : nonNull;
    if (!this.c.flow.isDiscriminant(discriminantSource, name) && !this.c.relations.isNullable(objectType)) return;
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

  /** The type of a reference without its own narrowing in the current flow. */
  private unnarrowedType(reference: TreeNode): Type {
    const key = this.c.flow.referenceKey(reference);
    const state = this.c.flow.current?.clone();
    if (!key || !state) return this.c.expressions.checkReferenceSilently(reference);
    state.entries.delete(key);
    let type: Type = anyType;
    this.c.flow.from(state, () => {
      type = this.c.expressions.checkReferenceSilently(reference);
    });
    return type;
  }

  private narrowDestructuredSiblings(reference: TreeNode, objectType: Type): void {
    if (reference.type !== 'identifier') return;
    const symbol = this.c.scopeOf(reference).lookupValue(reference.text);
    const declaration = symbol?.valueDeclaration;
    const pattern = declaration?.childForFieldName(symbol?.valueKind === 'parameter' ? 'pattern' : 'name');
    if (pattern?.type !== 'object_pattern') return;
    for (const identifier of patternIdentifiers(pattern)) {
      const source = this.destructuredFrom(identifier);
      if (!source) continue;
      const propertyType = this.c.silently(() =>
        this.c.patterns.destructuredProperty(identifier, objectType, source.name)
      );
      this.c.flow.narrowReference(identifier, (type) => this.c.flow.narrowByEquality(type, propertyType, true, false));
    }
  }

  private destructuredFrom(identifier: TreeNode): { object?: TreeNode; name: string; type: Type } | undefined {
    if (!['identifier', 'shorthand_property_identifier_pattern'].includes(identifier.type)) return undefined;
    const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
    const declarator = symbol?.valueDeclaration;
    const pattern = symbol?.valueEntries[0]?.name;
    if (!symbol || !declarator || !pattern || !['const', 'parameter'].includes(symbol.valueKind ?? ''))
      return undefined;
    const pair = pattern.parent?.type === 'pair_pattern' ? pattern.parent : undefined;
    const container = pair?.parent ?? pattern.parent;
    const field = symbol.valueKind === 'parameter' ? 'pattern' : 'name';
    if (container?.id !== declarator.childForFieldName(field)?.id || container?.type !== 'object_pattern') {
      return undefined;
    }
    const object = declarator.childForFieldName('value') ?? undefined;
    const type = this.c.patterns.correlatedSources.get(container.id);
    if (!type) return undefined;
    if (pattern.type === 'shorthand_property_identifier_pattern') return { object, name: pattern.text, type };
    const key = pair?.childForFieldName('key');
    const names = key ? this.c.silently(() => this.c.patterns.propertyNames(key)) : undefined;
    if (names?.length === 1) return { object, name: names[0], type };
    return undefined;
  }

  private narrowEquality(left: TreeNode, right: TreeNode, operator: string): { whenTrue: State; whenFalse: State } {
    const equal = operator === '===' || operator === '==';
    const loose = operator === '==' || operator === '!=';
    const leftExpression = skipParentheses(left);
    const rightExpression = skipParentheses(right);
    // `typeof x === "string"`
    for (const [typeofSide, other] of [
      [leftExpression, rightExpression],
      [rightExpression, leftExpression],
    ] as const) {
      if (
        typeofSide.type === 'unary_expression' &&
        typeofSide.childForFieldName('operator')?.text === 'typeof' &&
        other.type === 'string'
      ) {
        const target = typeofSide.childForFieldName('argument') as TreeNode;
        const name = stringValue(other);
        const { whenTrue, whenFalse } = this.narrowed(target, (current, assumeTrue) =>
          this.c.flow.narrowByTypeof(current, name, assumeTrue === equal)
        );
        // A chain that `typeof` finds other than `"undefined"` was evaluated.
        return equal === (name !== 'undefined')
          ? { whenTrue: this.chainEvaluated(whenTrue, target), whenFalse }
          : { whenTrue, whenFalse: this.chainEvaluated(whenFalse, target) };
      }
    }
    const leftType = this.c.expressions.checkReferenceSilently(left);
    const rightType = this.c.expressions.checkReferenceSilently(right);
    const base = this.c.flow.current;
    let whenTrue = base?.clone();
    let whenFalse = base?.clone();
    // Each side that is a reference narrows by the other's type.
    for (const [side, otherType] of [
      [leftExpression, rightType],
      [rightExpression, leftType],
    ] as const) {
      // `(m = re.exec(s)) !== null` narrows what it assigned.
      const reference =
        side.type === 'assignment_expression' ? skipParentheses(side.childForFieldName('left') as TreeNode) : side;
      if (!this.c.flow.referenceKey(reference)) continue;
      const narrow = (current: Type, assumeTrue: boolean): Type =>
        this.c.flow.narrowByEquality(current, regularOf(otherType), assumeTrue === equal, loose);
      whenTrue = this.c.flow.from(whenTrue, () => this.c.flow.narrowReference(reference, (type) => narrow(type, true)));
      whenFalse = this.c.flow.from(whenFalse, () =>
        this.c.flow.narrowReference(reference, (type) => narrow(type, false))
      );
      this.narrowDiscriminantParent(reference, narrow, whenTrue, whenFalse);
    }
    const states = this.chainCompared({ whenTrue, whenFalse }, leftExpression, rightType, equal, loose);
    return this.chainCompared(states, rightExpression, leftType, equal, loose);
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

/** An expression without the type assertions and parentheses around it, which do not change its value. */
function withoutAssertions(node: TreeNode): TreeNode {
  let expression = node;
  for (;;) {
    expression = skipParentheses(expression);
    if (['as_expression', 'satisfies_expression', 'non_null_expression'].includes(expression.type))
      expression = named(expression)[0];
    else if (expression.type === 'type_assertion') expression = named(expression).at(-1) as TreeNode;
    else return expression;
  }
}

/** Whether checking an expression again would declare or assign something, which an aliased condition must not. */
function hasSideEffects(expression: TreeNode): boolean {
  return sideEffectTypes.has(expression.type) || named(expression).some((child) => hasSideEffects(child));
}
