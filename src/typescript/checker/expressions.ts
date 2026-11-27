import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { assertedExpression } from '../erasedSyntax';
import { unsupportedMessage } from '../unsupported';
// code-gauge-allow-file fileNcss -- Resolves expressions, lexical references, closure captures, and contextual assignment diagnostics; memoization is separate.
import { awaitableContextualType, awaitedType, checkAwaitPlace } from './awaited';
import { Calls } from './calls';
import type { Checker } from './checker';
import { DeferredContexts } from './deferredContexts';
import { arrayTargets, Elaboration, targetElementType } from './elaboration';
import { isConstEnum } from './enums';
import { Expandos, laterRunningTypes } from './expandos';
import { ExpressionTypeCache } from './expressionTypeCache';
import type { FlowEntry } from './flow';
import { namedPropertyIndex } from './indexInfos';
import { nonNullableType } from './nullishConstraints';
import type { Sym } from './scopes';
import { nameSuggestionHint } from './spelling';
import {
  assignmentKind,
  hasToken,
  isClassConstructor,
  isDirectEmptyArray,
  isFunctionWithOwnThis,
  isImmediatelyInvoked,
  isTaggedTemplateArgument,
  named,
  numberValue,
  skipParentheses,
  stringValue,
  templateFragmentText,
  withoutAssertions,
} from './syntax';
import {
  isTemplateLiteralContext,
  isTemplateLiteralContextualType,
  templatePlaceholderConstraint,
} from './templateContexts';
import { checkTypeQuery, queryVariableEntry } from './typeQueries';
import {
  anyType,
  errorType,
  freshLiteralType,
  isAnyLike,
  isIntrinsic,
  nonPrimitiveType,
  nullType,
  numberType,
  type ObjectType,
  type Property,
  propertyAccessType,
  regularOf,
  stringType,
  symbolType,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';
import { UniqueSymbols } from './uniqueSymbols';

interface ExcessPropertyOptions {
  report: boolean;
  writtenWithin?: TreeNode;
}

const reportExcessProperties: ExcessPropertyOptions = { report: true };

/** The nodes that end the search for the function `new.target` belongs to: those with their own `this`. */
const newTargetBoundaries = new Set([
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'class_static_block',
  'field_definition',
  'program',
]);

export type CheckExpression = (node: TreeNode, contextual?: Type) => Type;

/** The kinds of names a use before their declaration reads before they are initialized, as tsc reports. */
const usedBeforeDeclarationKinds = new Set(['let', 'const', 'class', 'enum', 'parameter']);

/** Checks expressions, computing their types and narrowing the references their conditions test. */
export class ExpressionChecker {
  private observedTypes?: Map<number, Type | undefined>;
  readonly calls: Calls;
  readonly expandos: Expandos;
  readonly elaboration: Elaboration;
  private readonly silentTypes: ExpressionTypeCache;
  readonly uniqueSymbols: UniqueSymbols;
  /** Types of variables computed from their declarations, by symbol. */
  private readonly variableTypes = new Map<number, Type>();

  /** The type of each kind of expression; the others check their children and are `any`. */
  private readonly checkers = new Map<
    string,
    (node: TreeNode, contextual?: Type, retainFreshBoolean?: boolean) => Type
  >([
    ['number', (node) => freshLiteralType(numberValue(node.text))],
    ['string', (node) => freshLiteralType(stringValue(node))],
    ['template_string', (node, contextual) => this.templateString(node, contextual)],
    ['regex', () => this.c.globalType('RegExp')],
    ['true', () => freshLiteralType(true)],
    ['false', () => freshLiteralType(false)],
    ['null', () => nullType],
    ['undefined', () => undefinedType],
    ['identifier', (node, contextual) => this.identifier(node, contextual)],
    ['this', (node) => this.thisExpression(node)],
    [
      'parenthesized_expression',
      (node, contextual, retainFreshBoolean) =>
        this.checkWrapped(node, contextual, (operand, context) => this.check(operand, context, retainFreshBoolean)),
    ],
    ['array', (node, contextual) => this.c.literals.arrayLiteral(node, contextual)],
    ['object', (node, contextual) => this.c.literals.objectLiteral(node, contextual)],
    ['function_expression', (node, contextual) => this.c.functions.functionExpression(node, contextual)],
    ['generator_function', (node, contextual) => this.c.functions.functionExpression(node, contextual)],
    ['arrow_function', (node, contextual) => this.c.functions.functionExpression(node, contextual)],
    ['class', (node) => this.c.classes.classExpression(node)],
    ['member_expression', (node) => this.c.members.checkAccess(node).type],
    ['subscript_expression', (node) => this.c.members.checkAccess(node).type],
    [
      'call_expression',
      (node, contextual) =>
        this.c.members.chainLink(node, () =>
          this.c.members.rejectLibraryBuffer(
            node,
            this.uniqueSymbols.typeOfCall(node, this.calls.call(node, contextual))
          )
        ),
    ],
    ['new_expression', (node, contextual) => this.calls.newExpression(node, contextual)],
    ['assignment_expression', (node) => this.c.assignments.assignment(node)],
    ['augmented_assignment_expression', (node) => this.c.assignments.compoundAssignment(node)],
    ['update_expression', (node) => this.c.assignments.update(node)],
    ['unary_expression', (node) => this.c.operators.unary(node)],
    [
      'binary_expression',
      (node, contextual, retainFreshBoolean) => this.c.operators.binary(node, contextual, retainFreshBoolean),
    ],
    [
      'ternary_expression',
      (node, contextual, retainFreshBoolean) => this.c.operators.ternary(node, contextual, retainFreshBoolean),
    ],
    ['as_expression', (node, contextual) => this.checkWrapped(node, contextual)],
    ['type_assertion', (node, contextual) => this.checkWrapped(node, contextual)],
    ['satisfies_expression', (node) => this.satisfiesExpression(node)],
    ['meta_property', (node) => this.newTarget(node)],
    ['sequence_expression', (node, contextual) => this.sequenceExpression(node, contextual)],
    ['yield_expression', (node, contextual) => this.c.functions.yieldExpression(node, contextual)],
    ['await_expression', (node, contextual) => this.awaitExpression(node, contextual)],
    ['instantiation_expression', (node) => this.calls.instantiationExpression(node)],
    ['non_null_expression', (node, contextual) => this.checkWrapped(node, contextual)],
    ['spread_element', (node) => this.check(named(node)[0])],
  ]);

  readonly deferredContexts: DeferredContexts;

  constructor(private readonly c: Checker) {
    this.deferredContexts = new DeferredContexts(c);
    this.calls = new Calls(c);
    this.expandos = new Expandos(c);
    this.elaboration = new Elaboration(c);
    this.silentTypes = new ExpressionTypeCache(c);
    this.uniqueSymbols = new UniqueSymbols(c);
  }

  // Entry points -------------------------------------------------------------------------------------------------

  checkAssignedValue(node: TreeNode, contextual?: Type): Type {
    return this.check(node, contextual, true);
  }

  check(node: TreeNode, contextual?: Type, retainFreshBoolean = false): Type {
    this.c.budget.spend();
    return this.c.withTypeDemand(node, () => {
      if (this.c.silent > 0)
        return this.silentTypes.check(node, contextual, retainFreshBoolean, () =>
          this.compute(node, contextual, retainFreshBoolean)
        );
      const type = this.compute(node, contextual, retainFreshBoolean);
      if (!this.c.flow.probing && this.observedTypes?.has(node.id)) this.observedTypes.set(node.id, type);
      return type;
    });
  }

  checkMemberCallee(callee: TreeNode, reference: TreeNode): { type: Type; receiver?: Type } {
    if (callee.id === reference.id) return this.c.members.checkAccess(callee);
    let receiver: Type | undefined;
    const check: CheckExpression = (node, contextual) => {
      this.c.budget.spend();
      return this.c.withTypeDemand(node, () => {
        if (node.id !== reference.id) return this.checkWrapped(node, contextual, check);
        const access = this.c.members.checkAccess(node);
        receiver = access.receiver;
        return access.type;
      });
    };
    const type = check(callee);
    return { type, receiver };
  }

  private checkWrapped(
    node: TreeNode,
    contextual: Type | undefined,
    check: CheckExpression = (operand, context) => this.check(operand, context)
  ): Type {
    const operand = assertedExpression(node) as TreeNode;
    if (node.type === 'as_expression' || node.type === 'type_assertion')
      return this.c.operators.assertion(node, operand, contextual, check);
    if (node.type !== 'non_null_expression') return check(operand, contextual);
    const members = this.c.members;
    return members.chainLink(node, () => {
      const type = check(operand, contextual);
      const continued = members.continuedObjectType(operand, type);
      const asserted = nonNullableType(this.c, continued ?? type);
      return continued ? members.chainResult(node, asserted, asserted) : asserted;
    });
  }

  /** `await value`, which gives what a promise fulfills with, only in an async function. */
  private awaitExpression(node: TreeNode, contextual: Type | undefined): Type {
    checkAwaitPlace(this.c, node, false);
    const operand = named(node).find((child) => child.type !== 'comment');
    return operand
      ? awaitedType(this.c, this.check(operand, awaitableContextualType(this.c, contextual)), { node, kind: 'await' })
      : anyType;
  }

  /**
   * `a, b, c`, which TypeScript parses as `(a, b), c`: each comma whose left side has no side effects is an error, at
   * the start of that side, unless it is the `(0, o.f)()` idiom of an indirect call.
   */
  private sequenceExpression(node: TreeNode, contextual: Type | undefined): Type {
    const elements = named(node).filter((child) => child.type !== 'comment');
    let leftIsFree = true;
    for (const [index, element] of elements.entries()) {
      if (index === elements.length - 1) {
        const result = this.check(element, contextual);
        this.applySequenceCallFlow(element, result);
        return result;
      }
      const elementType = this.check(element);
      this.applySequenceCallFlow(element, elementType);
      leftIsFree &&= isSideEffectFree(element);
      if (leftIsFree && !(elements.length === 2 && isIndirectCall(node, element, elements[1])))
        this.c.error(elements[0], 'コンマ演算子の左側は使われず、副作用もありません。');
    }
    return anyType;
  }

  private applySequenceCallFlow(element: TreeNode, type: Type): void {
    const call = skipParentheses(element);
    if (call.type !== 'call_expression') return;
    if (this.calls.endsFlow(call, type)) this.c.flow.current = undefined;
    else this.c.conditions.applyAssertion(call, false);
  }

  /**
   * `new.target`: the class in a constructor, or the function in a function declaration or expression, as TypeScript's
   * `getNewTargetContainer` finds through arrow functions; elsewhere it is an error.
   */
  private newTarget(node: TreeNode): Type {
    let child = node;
    let container = node.parent;
    while (container && !isNewTargetBoundary(container, child)) {
      child = container;
      container = container.parent;
    }
    if (
      container &&
      isClassConstructor(container) &&
      !hasToken(container, 'static') &&
      !hasToken(container, 'get') &&
      !hasToken(container, 'set')
    ) {
      const classNode = container.parent?.parent;
      if (classNode) return this.c.classes.valueTypeOf(this.c.classes.classInfoOfNode(classNode));
    }
    if (
      container &&
      isFunctionWithOwnThis(container) &&
      container.type !== 'method_definition' &&
      container.type !== 'class_static_block'
    ) {
      const name = container.childForFieldName('name');
      return name && container.type.endsWith('function_declaration')
        ? this.checkReferenceSilently(name)
        : this.c.globalType('Function');
    }
    this.c.error(
      node,
      "メタプロパティ 'new.target' は、関数宣言・関数式・コンストラクターの本体の中でしか使えません。"
    );
    return errorType;
  }

  /**
   * `expression satisfies T`: the expression is checked against `T` as its contextual type and must be assignable to
   * it, yet keeps its own type.
   */
  private satisfiesExpression(node: TreeNode): Type {
    const [operand, typeNode] = named(node);
    const target = this.c.typeNodes.typeFromNode(typeNode);
    const type = this.check(operand, target);
    if (target === errorType) return type;
    if (this.c.relations.isAssignable(type, target)) this.checkExcessProperties(operand, type, target);
    else if (!this.elaboration.report(operand, type, target))
      this.c.error(operand, this.elaboration.typeRelationMessage(type, target, 'satisfies'));
    return type;
  }

  observeTypes<T>(types: Map<number, Type | undefined>, run: () => T): T {
    if (types.size === 0) return run();
    const outer = this.observedTypes;
    this.observedTypes = types;
    try {
      return run();
    } finally {
      this.observedTypes = outer;
    }
  }

  private compute(node: TreeNode, contextual: Type | undefined, retainFreshBoolean: boolean): Type {
    const checkKind = this.checkers.get(node.type);
    if (checkKind) {
      const type = checkKind(node, contextual, retainFreshBoolean);
      if (retainFreshBoolean && type.kind === 'literal' && typeof type.value === 'boolean') return type;
      return contextual ? this.c.literals.preserveContextualLiterals(type, contextual) : type;
    }
    for (const child of named(node)) this.check(child);
    return anyType;
  }

  /**
   * Reports a function or a class turned into text: Node.js shows the source tsx's esbuild printed for it, which this
   * interpreter does not reproduce.
   */
  checkFunctionText(node: TreeNode, type: Type): void {
    if (this.mayBeFunction(type)) this.c.error(node, unsupportedMessage('関数やクラスの文字列への変換'));
  }

  private mayBeFunction(type: Type): boolean {
    const pending = [type];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const current = pending.pop() as Type;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      this.c.budget.spend();
      const apparent =
        current.kind === 'typeParameter' || current.kind === 'indexedAccess' || current.kind === 'conditional'
          ? this.c.apparentType(current)
          : current;
      if (apparent.kind === 'union' || apparent.kind === 'intersection') {
        pending.push(...apparent.types);
      } else if (
        apparent.kind === 'object' &&
        (this.c.isLibraryType(apparent, 'Function') ||
          this.c.signaturesOf(apparent, 'call').length > 0 ||
          this.c.signaturesOf(apparent, 'construct').length > 0)
      )
        return true;
    }
    return false;
  }

  isSymbolLike(type: Type): boolean {
    return !isAnyLike(type) && !isIntrinsic(type, 'never') && this.c.relations.isAssignable(type, symbolType);
  }

  mayBeSymbol(type: Type): boolean {
    const constraint = this.c.baseConstraint(type);
    return (constraint.kind === 'union' ? constraint.types : [constraint]).some((member) => this.isSymbolLike(member));
  }

  private templateString(node: TreeNode, contextual: Type | undefined): Type {
    if (isTaggedTemplateArgument(node)) return this.c.globalType('TemplateStringsArray');
    const { texts, types } = this.readTemplateParts(node);
    // A template without substitutions is a string literal, as TypeScript's `NoSubstitutionTemplateLiteral` is.
    if (types.length === 0) return freshLiteralType(texts[0]);
    const spellsType =
      this.c.literals.isConstContext(node) ||
      isTemplateLiteralContext(node) ||
      (contextual !== undefined && isTemplateLiteralContextualType(this.c, contextual));
    if (!spellsType) return stringType;
    // A substitution that is not a template placeholder type, such as an object, spells some `string`.
    const placeholders = types.map((type) =>
      this.c.relations.isAssignable(type, templatePlaceholderConstraint) ? regularOf(type) : stringType
    );
    const spelled = this.c.typeOperators.templateLiteral(texts, placeholders);
    return spelled.kind === 'literal' ? freshLiteralType(spelled.value as string) : spelled;
  }

  private readTemplateParts(node: TreeNode): { texts: string[]; types: Type[] } {
    const texts = [''];
    const types: Type[] = [];
    for (const child of named(node)) {
      if (child.type === 'template_substitution') {
        types.push(this.templateSubstitution(named(child)[0]));
        texts.push('');
      } else if (child.type === 'string_fragment' || child.type === 'escape_sequence') {
        texts[texts.length - 1] += templateFragmentText(child);
      }
    }
    return { texts, types };
  }

  /** The type of a template's substitution, which a function or a symbol cannot stand in as text. */
  private templateSubstitution(expression: TreeNode): Type {
    const type = this.check(expression);
    this.checkFunctionText(expression, type);
    if (this.mayBeSymbol(type)) {
      this.c.error(
        expression,
        "symbol を文字列に暗黙に変換すると、実行時にエラーになります。'String(...)' で囲んでください。"
      );
    }
    return type;
  }

  /** Checks the expression of a computed property name, whose type must be a string, number, symbol, or `any`. */
  checkComputedPropertyName(name: TreeNode, type = this.check(named(name)[0] ?? name)): Type {
    if (!isAnyLike(type) && !this.c.relations.isAssignable(type, unionOf([stringType, numberType, symbolType])))
      this.c.error(
        name,
        "計算されたプロパティ名は、'string'、'number'、'symbol'、'any' のいずれかの型でなければいけません。"
      );
    return type;
  }

  /** The type of an expression as a mutable location holds it, with its literals widened. */
  checkWidened(node: TreeNode, contextual?: Type): Type {
    return this.c.widen(this.check(node, contextual));
  }

  /** The type of a reference without reporting errors, for narrowing it. */
  checkReferenceSilently(node: TreeNode): Type {
    const expression = skipParentheses(node);
    return this.c.silently(() =>
      expression.type === 'shorthand_property_identifier_pattern' || expression.type === 'shorthand_property_identifier'
        ? this.identifier(expression)
        : this.check(node)
    );
  }

  /** The type of a parameter's default value, widened, in the context of the function. */
  widenedTypeOfInitializer(node: TreeNode): Type {
    return this.c.silently(() => this.c.literals.widenDeclared(this.check(node), false));
  }

  /** The type of a parameter that has neither an annotation nor a contextual type: an implicit `any`. */
  implicitParameterType(parameter: TreeNode, pattern: TreeNode, rest: boolean): Type {
    if (pattern.type === 'identifier') {
      this.c.error(parameter, `引数 ${pattern.text} の型が暗黙に any になります。型を書いてください。`);
      return anyType;
    }
    const binding = rest ? (named(pattern)[0] ?? pattern) : pattern;
    if (rest && binding.type === 'identifier') {
      const name = binding.text;
      this.c.error(parameter, `残余引数 ${name} の型が暗黙に any[] になります。型を書いてください。`);
      return this.c.arrayType(anyType);
    }
    return this.c.patterns.inferredParameterType(binding);
  }

  typeOfQuery(node: TreeNode): Type {
    return checkTypeQuery(
      this.c,
      node,
      (name) => this.queryIdentifier(name),
      (expression) => this.check(expression)
    );
  }

  private queryIdentifier(node: TreeNode): Type {
    const symbol = this.c.scopeOf(node).lookupValue(node.text);
    if (!symbol) return this.implicitArgumentsType(node) ?? this.reportUnknownValue(node, node.text);
    const enumSymbol = this.c.enums.resolvedEnumSymbol(symbol);
    if (enumSymbol) this.c.enums.checkConstEnumUse(node, enumSymbol);
    return this.reportUnavailableValue(node, symbol)
      ? errorType
      : this.variableReferenceType(node, symbol, undefined, true);
  }

  // Identifiers --------------------------------------------------------------------------------------------------

  identifier(node: TreeNode, contextual?: Type): Type {
    const name = node.text;
    const symbol = this.c.scopeOf(node).lookupValue(name);
    if (!symbol) return this.implicitArgumentsType(node) ?? this.reportUnknownValue(node, name);
    if (this.reportUnavailableValue(node, symbol)) return errorType;
    if (symbol.importTarget?.typeOnly) {
      this.c.error(node, `'import type' を使用してインポートされたため、'${name}' は値として使用できません。`);
      return errorType;
    }
    if (symbol === this.c.libraryBinder.moduleScope.lookupValue('require') && !isDirectOrWrappedRequireCallee(node))
      return this.reportRequireValue(node);
    this.checkUsedBeforeDeclaration(node, symbol);
    const enumSymbol = this.c.enums.resolvedEnumSymbol(symbol);
    if (enumSymbol) this.c.enums.checkConstEnumUse(node, enumSymbol);
    if (symbol.valueKind === 'namespace' && !this.c.namespaces.checkValueUse(node, symbol)) return errorType;
    const aliased = symbol.valueKind === 'importAlias' ? this.c.namespaces.imported(symbol, 'value') : undefined;
    if (aliased?.valueKind === 'namespace' && !this.c.namespaces.checkValueUse(node, aliased, name)) return errorType;
    return this.variableReferenceType(node, symbol, contextual);
  }

  /**
   * Node.js's `require` other than called by name, which the checker accepts only for a module this interpreter
   * provides: as a value, or through a member such as `require.resolve` or `require.call`, it could load any module.
   */
  private reportRequireValue(node: TreeNode): Type {
    const parent = node.parent;
    const property = parent?.type === 'member_expression' ? parent.childForFieldName('property') : undefined;
    this.c.error(node, unsupportedMessage(property ? `require.${property.text}` : '呼び出し以外での require'));
    return errorType;
  }

  private implicitArgumentsType(node: TreeNode): Type | undefined {
    return node.text === 'arguments' && this.hasArguments(node) ? this.c.globalType('IArguments') : undefined;
  }

  private variableReferenceType(node: TreeNode, symbol: Sym, contextual?: Type, typeQuery = false): Type {
    if (symbol.valueKind === 'parameter') {
      this.c.signatures.checkReadOfInferringParameter(symbol.valueDeclaration, symbol.name);
      this.c.patterns.checkParameterDefaultRead(node, symbol);
    }
    const declared = this.valueTypeOf(symbol);
    const key = `s${symbol.id}`;
    this.c.flow.declaredTypes.set(key, declared);
    const entry =
      typeQuery && !this.isEvolvingArrayDeclaration(symbol)
        ? queryVariableEntry(this.c, node, symbol, key)
        : this.c.flow.entry(key);
    if (this.isOuterVariable(node, symbol)) {
      // A nested function checks the assignment of a variable of an enclosing one only when nothing ever assigns it.
      if (this.isNeverInitialized(symbol))
        return this.flowVariableType(
          node,
          symbol,
          entry ?? { type: declared, assigned: false },
          declared,
          contextual,
          typeQuery
        );
      return entry?.type ?? this.closureVariableType(node, symbol, declared, typeQuery);
    }
    return entry ? this.flowVariableType(node, symbol, entry, declared, contextual, typeQuery) : declared;
  }

  /** Whether a reference reads a variable that {@link isNeverInitialized} holds for. */
  readsNeverInitialized(node: TreeNode): boolean {
    const symbol = node.type === 'identifier' ? this.c.scopeOf(node).lookupValue(node.text) : undefined;
    return symbol !== undefined && this.isNeverInitialized(symbol);
  }

  /** Whether a `let` of a function or block is declared without a value or `!` and never definitely assigned. */
  private isNeverInitialized(symbol: Sym): boolean {
    const declaration = symbol.valueDeclaration;
    return (
      symbol.valueKind === 'let' &&
      symbol.scope !== this.c.binder.moduleScope &&
      !symbol.isDefinitelyAssigned &&
      declaration?.type === 'variable_declarator' &&
      declaration.childForFieldName('name')?.type === 'identifier' &&
      !declaration.childForFieldName('value') &&
      !hasToken(declaration, '!') &&
      // A namespace's exported variable is read as a property of its object, which tsc does not check.
      declaration.parent?.parent?.type !== 'export_statement'
    );
  }

  private reportUnavailableValue(node: TreeNode, symbol: Sym): boolean {
    if (!symbol.unsupported || (symbol.unsupportedCallOnly && !isCallee(node))) return false;
    this.c.error(node, unsupportedMessage(symbol.unsupported));
    return true;
  }

  /** Whether `arguments` names the arguments of an enclosing function, which an arrow function shares. */
  private hasArguments(node: TreeNode): boolean {
    for (let current = node.parent; current; current = current.parent) {
      if (isFunctionWithOwnThis(current) && current.type !== 'class_static_block') return true;
      if (current.type === 'class_body' || current.type === 'field_definition') return false;
    }
    return false;
  }

  /** The type of a variable of the running function where its flow is followed, checking it was assigned first. */
  private flowVariableType(
    node: TreeNode,
    symbol: Sym,
    entry: FlowEntry,
    declared: Type,
    contextual: Type | undefined,
    typeQuery: boolean
  ): Type {
    if (
      !typeQuery &&
      !entry.assigned &&
      this.needsDefiniteAssignment(symbol, declared) &&
      assignmentKind(node) !== 'definite' &&
      node.parent?.type !== 'non_null_expression'
    ) {
      this.c.error(node, `変数 ${symbol.name} は値を代入する前に使われています。`);
    }
    // As TypeScript's `getNarrowableTypeForReference`, the narrowed constraint stands for the value where only its
    // constraint matters: where its members are read, or where a type without type parameters is expected.
    if (
      entry.constraint &&
      (this.isConstraintPosition(node) || (contextual && !this.c.relations.isGeneric(contextual)))
    )
      return entry.constraint;
    // As TypeScript does, `x!` where the flow leaves `x` only `null` or `undefined` takes the declared type, as after a
    // callback assigned it.
    if (
      node.parent?.type === 'non_null_expression' &&
      !isIntrinsic(entry.type, 'never') &&
      isIntrinsic(this.c.relations.removeNullish(entry.type), 'never')
    )
      return declared;
    if (!entry.evolving || this.isEvolvingUse(node)) return entry.type;
    // An array nothing has added to in this flow has no type here.
    if (this.isNeverEvolved(entry.type)) return this.reportUndeterminedType(node, symbol);
    return this.finishEvolving(entry.type);
  }

  private reportUnknownValue(node: TreeNode, name: string): Type {
    const typeSymbol = this.c.scopeOf(node).lookupType(name);
    if (typeSymbol && typeSymbol.typeKind !== 'class') {
      this.c.error(node, `${name} は型であり、値としては使えません。`);
    } else {
      const hint = nodeGlobalHint(name) || nameSuggestionHint(this.c.scopeOf(node), name, 'value', this.c.budget);
      this.c.error(node, `名前 ${name} が見つかりません。${hint}`);
    }
    return errorType;
  }

  /** Whether a reference is the object of a member access or the callee of a call, where a type parameter's narrowed constraint stands for it. */
  private isConstraintPosition(node: TreeNode): boolean {
    const parent = node.parent;
    if (parent?.type === 'member_expression' || parent?.type === 'subscript_expression')
      return parent.childForFieldName('object')?.id === node.id;
    return parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id;
  }

  private isEvolvingUse(node: TreeNode): boolean {
    const parent = node.parent;
    if (parent?.type === 'member_expression' && parent.childForFieldName('object')?.id === node.id) {
      const property = parent.childForFieldName('property')?.text;
      return property === 'length' || property === 'push' || property === 'unshift';
    }
    return (
      parent?.type === 'subscript_expression' &&
      parent.childForFieldName('object')?.id === node.id &&
      this.c.assignments.isElementWrite(parent)
    );
  }

  private finishEvolving(type: Type): Type {
    if (type.kind === 'object' && this.c.isArrayType(type) && isIntrinsic(this.c.elementTypeOf(type), 'never')) {
      return this.c.arrayType(anyType);
    }
    return type;
  }

  isAssignmentTarget(node: TreeNode): boolean {
    const parent = node.parent;
    return parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === node.id;
  }

  /** Whether reading a variable before assigning it is an error: its type lacks `undefined`. */
  private needsDefiniteAssignment(symbol: Sym, declared: Type): boolean {
    if (symbol.valueKind !== 'let' && symbol.valueKind !== 'var') return false;
    if (isAnyLike(declared) || isIntrinsic(declared, 'unknown')) return false;
    return !this.c.relations.isNullable(declared) || !this.c.relations.isAssignable(undefinedType, declared);
  }

  /** Whether a reference reads a variable of an enclosing function, which flow analysis does not follow into it. */
  private isOuterVariable(node: TreeNode, symbol: Sym): boolean {
    if (symbol.scope.kind === 'global') return false;
    const owner = this.c.functions.flowOwner();
    if (!owner) return false;
    for (let current: TreeNode | null | undefined = symbol.valueDeclaration; current; current = current.parent) {
      if (current.id === owner.id) return false;
    }
    return true;
  }

  /**
   * The type a nested function sees for a variable of an enclosing one: narrowed as when the function was created if
   * nothing assigns the variable after that, as TypeScript 5.4 keeps it.
   */
  private closureVariableType(node: TreeNode, symbol: Sym, declared: Type, typeQuery: boolean): Type {
    const closure = this.c.functions.contexts.at(-1)?.node;
    const evolving = this.isEvolvingArrayDeclaration(symbol);
    if (evolving || this.c.assignments.isAutoTyped(symbol)) symbol.usedInClosure = true;
    if (evolving && this.isEvolvingUse(node)) return declared;
    const assignedLater = closure !== undefined && symbol.lastAssignment >= closure.startIndex;
    const deferred =
      closure?.type === 'function_declaration' ||
      closure?.type === 'generator_function_declaration' ||
      (closure?.type === 'method_definition' &&
        closure.parent?.type === 'class_body' &&
        closure.parent.parent?.type !== 'class');
    if (
      !typeQuery &&
      !evolving &&
      !deferred &&
      (symbol.valueKind === 'const' || (symbol.scope !== this.c.binder.moduleScope && !assignedLater))
    ) {
      const captured = this.c.functions.capturedTypes.at(-1)?.get(`s${symbol.id}`);
      if (captured) return captured;
    }
    if (evolving || this.c.assignments.isAutoTyped(symbol)) return this.reportUndeterminedType(node, symbol);
    return declared;
  }

  /** Whether a variable is declared as `[]` without a type, whose type the pushes to it decide. */
  private isEvolvingArrayDeclaration(symbol: Sym): boolean {
    const declaration = symbol.valueDeclaration;
    return (
      declaration?.type === 'variable_declarator' &&
      !declaration.childForFieldName('type') &&
      isDirectEmptyArray(declaration.childForFieldName('value'))
    );
  }

  private isNeverEvolved(type: Type): boolean {
    return type.kind === 'object' && this.c.isArrayType(type) && isIntrinsic(this.c.elementTypeOf(type), 'never');
  }

  /** Reports a variable whose type follows its assignments where they cannot be followed, at the use and the declaration. */
  private reportUndeterminedType(node: TreeNode, symbol: Sym): Type {
    const typeName = this.isEvolvingArrayDeclaration(symbol) ? 'any[]' : 'any';
    const declaration = symbol.valueDeclaration?.childForFieldName('name');
    if (declaration) {
      this.c.error(
        declaration,
        `変数 ${symbol.name} は、型を決められない場所があるため、型が暗黙に ${typeName} になります。`
      );
    }
    this.c.error(node, `変数 ${symbol.name} の型が暗黙に ${typeName} になります。`);
    return typeName === 'any' ? anyType : this.c.arrayType(anyType);
  }

  // code-gauge-allow functionCognitiveComplexity -- Follows TypeScript's rules for uses before a declaration, which depend on when the use runs.
  checkUsedBeforeDeclaration(node: TreeNode, symbol: Sym): void {
    if (symbol.valueKind === 'function') {
      this.checkParameterUseOfBodyFunction(node, symbol);
      return;
    }
    if (!usedBeforeDeclarationKinds.has(symbol.valueKind ?? '')) return;
    const declaration = symbol.valueDeclaration;
    if (!declaration || this.c.isLibrary(declaration)) return;
    if (!this.beforeBindingInitialized(node, symbol, declaration)) return;
    // A use inside a function that runs later is fine, but not in a member's decorator, which runs with the class.
    for (let child = node, current = node.parent; current; child = current, current = current.parent) {
      if (current.id === declaration.id) break;
      if (child.type === 'decorator') continue;
      if (
        laterRunningTypes.has(current.type) &&
        !(current.startIndex <= declaration.startIndex && declaration.endIndex <= current.endIndex) &&
        !isImmediatelyInvoked(current)
      ) {
        return;
      }
      if (current.type === 'field_definition' && !hasToken(current, 'static')) return;
    }
    if (symbol.valueKind === 'enum' && isConstEnum(symbol)) return;
    const kind = symbol.valueKind === 'class' ? 'クラス' : symbol.valueKind === 'enum' ? '列挙型' : '変数';
    this.c.error(node, `${kind} ${symbol.name} は宣言より前で使われています。`);
  }

  /**
   * Reports a parameter's initializer using, other than in a function it declares, a function its function's body
   * declares, which tsc rejects as declared after the parameter.
   */
  private checkParameterUseOfBodyFunction(node: TreeNode, symbol: Sym): void {
    const declaration = symbol.valueDeclaration;
    let current: TreeNode | null = node;
    while (current && current.parent?.type !== 'formal_parameters') {
      if (laterRunningTypes.has(current.type)) return;
      current = current.parent;
    }
    const body = current?.parent?.parent?.childForFieldName('body');
    if (!current || !body || declaration?.parent?.id !== body.id) return;
    const parameter = current.childForFieldName('pattern')?.text ?? current.text;
    this.c.error(node, `引数 ${parameter} は、後で宣言される ${symbol.name} を参照できません。`);
  }

  private beforeBindingInitialized(node: TreeNode, symbol: Sym, declaration: TreeNode): boolean {
    const name = symbol.valueEntries[0]?.name ?? declaration;
    if (node.startIndex < name.startIndex) return true;
    // A member's decorator runs while the class is being defined, before its name is bound.
    if (symbol.valueKind === 'class') return isWithinDecorator(node, declaration);
    if (node.startIndex >= declaration.endIndex) return false;
    const value = declaration.childForFieldName('value');
    if (value && value.startIndex <= node.startIndex && node.endIndex <= value.endIndex) return true;
    for (let current = name.parent; current && current.id !== declaration.id; current = current.parent) {
      if (current.type !== 'assignment_pattern' && current.type !== 'object_assignment_pattern') continue;
      const initializer = current.childForFieldName('right');
      if (initializer && initializer.startIndex <= node.startIndex && node.endIndex <= initializer.endIndex)
        return true;
    }
    return false;
  }

  /** The type of a value a symbol declares. */
  valueTypeOf(symbol: Sym): Type {
    const type = this.declaredValueTypeOf(symbol);
    return symbol.namespaceExports ? this.c.namespaces.withExports(symbol, type) : type;
  }

  private declaredValueTypeOf(symbol: Sym): Type {
    if (symbol.valueType) return symbol.valueType;
    const declared = this.typeOfDeclaredKind(symbol);
    if (declared) return declared;
    const parameterType = this.c.functions.parameterTypes.get(symbol.id);
    if (parameterType) return parameterType;
    const variableType = this.variableTypes.get(symbol.id);
    if (variableType) return variableType;
    if (symbol.resolving) {
      const declaration = symbol.valueDeclaration;
      if (declaration && !this.c.isLibrary(declaration))
        this.c.error(
          declaration.childForFieldName('name') ?? declaration,
          `${symbol.name} の型が、自分自身を参照しているため暗黙に any になります。`
        );
      return anyType;
    }
    symbol.resolving = true;
    try {
      const type = this.computeValueType(symbol);
      if (symbol.valueKind === 'function' || symbol.valueKind === 'declared' || symbol.valueKind === 'catch')
        symbol.valueType = type;
      else this.variableTypes.set(symbol.id, type);
      return type;
    } finally {
      symbol.resolving = false;
    }
  }

  /** The type of a class, an enum, a namespace, an enum member, or an import alias, which their declarations give. */
  private typeOfDeclaredKind(symbol: Sym): Type | undefined {
    switch (symbol.valueKind) {
      case 'class': {
        return (symbol.valueType = this.c.classes.valueTypeOf(this.c.classes.classInfoOf(symbol)));
      }
      case 'enum': {
        return (symbol.valueType = this.c.enums.objectType(symbol));
      }
      case 'namespace': {
        return (symbol.valueType = this.c.namespaces.objectType(symbol));
      }
      case 'enumMember': {
        return symbol.valueDeclaration && this.c.enums.memberType(symbol.valueDeclaration);
      }
      case 'importAlias':
      case 'import': {
        const target = this.c.namespaces.imported(symbol, 'value');
        return target ? this.valueTypeOf(target) : errorType;
      }
      default: {
        return undefined;
      }
    }
  }

  setVariableType(symbol: Sym, type: Type): void {
    this.variableTypes.set(symbol.id, type);
  }

  private computeValueType(symbol: Sym): Type {
    const declaration = symbol.valueDeclaration;
    if (!declaration) return anyType;
    switch (symbol.valueKind) {
      case 'function': {
        return this.functionSymbolType(symbol);
      }
      case 'catch': {
        const annotation = this.c.typeNodes.annotationType(declaration.childForFieldName('type'));
        const parameter = declaration.childForFieldName('parameter');
        const type = annotation ?? unknownType;
        if (parameter && parameter.type !== 'identifier')
          return this.c.silently(() => this.c.patterns.patternType(parameter, type, symbol));
        return type;
      }
      case 'parameter': {
        const pattern = declaration.childForFieldName('pattern') ?? declaration;
        const annotation = this.c.typeNodes.annotationType(declaration.childForFieldName('type'));
        if (annotation) {
          if (pattern.type === 'identifier' || pattern.type === 'rest_pattern') return annotation;
          return this.c.silently(() => this.c.patterns.patternType(pattern, annotation, symbol, { annotated: true }));
        }
        const value = declaration.childForFieldName('value');
        if (value) return this.widenedTypeOfInitializer(value);
        return pattern.type === 'rest_pattern' ? this.c.arrayType(anyType) : anyType;
      }
      case 'declared': {
        return this.c.typeNodes.annotationType(declaration.childForFieldName('type')) ?? anyType;
      }
      default: {
        return this.declaredVariableValueType(symbol, declaration);
      }
    }
  }

  private declaredVariableValueType(symbol: Sym, declaration: TreeNode): Type {
    const type = this.c.silently(() => this.c.statements.declaredVariableType(symbol, declaration));
    return symbol.valueKind === 'const' ? this.expandos.constType(declaration, symbol, type) : type;
  }

  private functionSymbolType(symbol: Sym): Type {
    const expression = symbol.valueDeclaration;
    if (expression?.type === 'function_expression' || expression?.type === 'generator_function')
      return this.c.silently(() => this.check(expression));
    const signatures = symbol.valueDeclarations.filter((node) => node.type === 'function_signature');
    const implementation = symbol.valueDeclarations.find(
      (node) => node.type === 'function_declaration' || node.type === 'generator_function_declaration'
    );
    const ownSignatures = signatures.filter((signature) => !this.c.isLibrary(signature));
    const librarySignatures = signatures.filter((signature) => this.c.isLibrary(signature));
    const declared =
      ownSignatures.length > 0
        ? [...ownSignatures, ...librarySignatures]
        : implementation
          ? [implementation, ...librarySignatures]
          : librarySignatures;
    const callSignatures = declared.map((node) => this.c.signatures.signatureOf(node));
    return this.expandos.withExpandos(
      callSignatures,
      this.c.overloadedFunction(callSignatures),
      implementation?.parent,
      symbol
    );
  }

  // this ---------------------------------------------------------------------------------------------------------

  private thisExpression(node: TreeNode): Type {
    const type = this.c.classes.thisTypeOfExpression(node);
    const key = this.c.flow.referenceKey(node);
    const entry = key ? this.c.flow.entry(key) : undefined;
    return entry?.type ?? type;
  }

  /** Checks a returned value against the function's declared return type. */
  checkReturnValue(node: TreeNode, type: Type, declared: Type): void {
    if (!this.c.relations.isAssignable(type, declared)) {
      this.reportNotAssignable(node, type, declared);
      return;
    }
    this.checkExcessProperties(node, type, declared);
  }

  // Assignability errors -----------------------------------------------------------------------------------------

  /**
   * Reports that a source is not assignable to a target: at the members of the object literals, array literals, and
   * arrow functions that `expression` (or else `node`) spells which do not fit, as TypeScript elaborates, or at `node`.
   */
  reportNotAssignable(node: TreeNode, source: Type, target: Type, expression?: TreeNode): void {
    if (this.elaboration.report(expression ?? node, source, target)) return;
    this.c.error(node, this.elaboration.typeRelationMessage(source, target));
  }

  /** Reports the properties of a fresh object literal that its target does not declare. */
  checkExcessProperties(
    node: TreeNode,
    source: Type,
    target: Type,
    options: ExcessPropertyOptions = reportExcessProperties
  ): boolean {
    // Each object literal a union or an array literal holds is checked against where it goes.
    if (source.kind === 'union') {
      let fits = true;
      for (const member of source.types) fits = this.checkExcessProperties(node, member, target, options) && fits;
      return fits;
    }
    if (source.kind === 'object' && this.c.literals.isArrayOrTupleLiteral(source))
      return this.checkExcessElements(node, source, target, options);
    if (
      source.kind !== 'object' ||
      !(source.fresh || (options.writtenWithin && this.c.literals.isObjectLiteralWithin(source, options.writtenWithin)))
    )
      return true;
    return this.checkExcessObjectProperties(node, source, target, options);
  }

  private checkExcessObjectProperties(
    node: TreeNode,
    source: ObjectType,
    target: Type,
    options: ExcessPropertyOptions
  ): boolean {
    const targets = this.discriminatedTargets(source, objectTargets(target));
    if (targets.length === 0 || this.acceptsAnyProperty(targets)) return true;
    // A discriminated union checks the members its discriminant selects; an index signature takes any key it covers,
    // whose value is still checked against it.
    let fits = true;
    for (const property of source.resolve().properties.values()) {
      if (!this.c.literals.isWrittenMember(source, property)) continue;
      if (!this.checkWrittenProperty(node, property, targets, target, options.report)) return false;
      fits = this.checkExcessPropertyValue(property, target, options) && fits;
    }
    return this.checkExcessIndexValues(node, source, targets, options) && fits;
  }

  /** Checks a written property of a fresh object literal against the targets, returning whether it fits them. */
  private checkWrittenProperty(
    node: TreeNode,
    property: Property,
    targets: Type[],
    target: Type,
    report: boolean
  ): boolean {
    if (!this.isKnownProperty(targets, property)) {
      if (report) this.reportUnknownLiteralProperty(property.declaration ?? node, property.name, target);
      return false;
    }
    return target.kind !== 'union' || this.fitsUnionProperty(node, property, targets, target, report);
  }

  reportUnknownLiteralProperty(declaration: TreeNode, name: string, target: Type): void {
    this.c.error(
      declaration.childForFieldName('key') ?? declaration.childForFieldName('name') ?? declaration,
      `オブジェクトリテラルには既知のプロパティしか書けません。'${name}' は型 '${this.c.print(target)}' にありません。`
    );
  }

  private acceptsAnyProperty(targets: Type[]): boolean {
    return targets.some(
      (member) =>
        member === nonPrimitiveType ||
        (member.kind === 'object' &&
          (this.c.relations.isEmptyObjectType(member) ||
            (member.objectKind === 'mapped' && this.c.relations.isGeneric(member))))
    );
  }

  private isKnownProperty(targets: Type[], property: Property): boolean {
    const { name } = property;
    const key = this.c.typeOperators.propertyKeyType(property);
    return targets.some((member) => {
      const structure = this.c.structureOf(member);
      return (
        (this.c.propertyOf(member, name) !== undefined && !this.isObjectPrototypeProperty(member, name)) ||
        structure.stringIndex !== undefined ||
        namedPropertyIndex(this.c, structure, name, key) !== undefined
      );
    });
  }

  /**
   * Reports a written property of a literal assigned to a union whose value does not fit the property's type in the
   * selected members, `undefined` where a member lacks it: a union member without the property may accept the literal
   * as a whole, yet TypeScript rejects the value.
   */
  private fitsUnionProperty(
    node: TreeNode,
    property: Property,
    targets: Type[],
    target: Type,
    report: boolean
  ): boolean {
    const key = this.c.typeOperators.propertyKeyType(property);
    const declared = unionOf(targets.map((member) => this.typeOfPropertyIn(member, property.name, key)));
    if (this.c.relations.isAssignable(property.type(), declared)) return true;
    if (report) {
      const { declaration } = property;
      const value = declaration?.type === 'pair' ? declaration.childForFieldName('value') : undefined;
      this.reportNotAssignable(
        declaration?.childForFieldName('key') ?? declaration ?? node,
        property.type(),
        this.c.literals.contextualPropertyType(target, property.name, key) ?? declared,
        value ?? undefined
      );
    }
    return false;
  }

  /** The type a member of a union gives a property, as its own or by an index signature, or `undefined`. */
  private typeOfPropertyIn(member: Type, name: string, key: Type): Type {
    const property = this.c.propertyOf(member, name);
    if (property) return propertyAccessType(property);
    return namedPropertyIndex(this.c, this.c.structureOf(member), name, key)?.type ?? undefinedType;
  }

  /** Checks the object literal a written property's value spells against the target's type of the property. */
  private checkExcessPropertyValue(property: Property, target: Type, options: ExcessPropertyOptions): boolean {
    const value = property.declaration?.type === 'pair' ? property.declaration.childForFieldName('value') : undefined;
    const targetType = this.contextOfWrittenProperty(target, property);
    return !value || !targetType || this.checkExcessProperties(value, property.type(), targetType, options);
  }

  private contextOfWrittenProperty(target: Type, property: Property): Type | undefined {
    return this.c.literals.contextualPropertyType(
      target,
      property.name,
      this.c.typeOperators.propertyKeyType(property)
    );
  }

  /** Checks the object literals that computed keys give a literal's string index against the targets' string index. */
  private checkExcessIndexValues(
    node: TreeNode,
    source: ObjectType,
    targets: Type[],
    options: ExcessPropertyOptions
  ): boolean {
    const sourceIndex = source.resolve().stringIndex;
    const targetIndexes = targets.flatMap((member) => this.c.structureOf(member).stringIndex?.type ?? []);
    return (
      !sourceIndex ||
      targetIndexes.length === 0 ||
      this.checkExcessProperties(node, sourceIndex.type, unionOf(targetIndexes), options)
    );
  }

  /**
   * Reports the excess properties of the object literals in a type assertion's array literals: TypeScript makes the
   * asserted object literal and those in its properties regular, but not the elements of its array literals.
   */
  checkAssertedArrayLiterals(node: TreeNode, source: Type, target: Type): void {
    if (source.kind === 'union') {
      for (const member of source.types) this.checkAssertedArrayLiterals(node, member, target);
      return;
    }
    if (source.kind !== 'object') return;
    if (this.c.isArrayOrTuple(source)) {
      this.checkExcessElements(node, source, target);
      return;
    }
    if (!source.fresh) return;
    for (const property of source.resolve().properties.values()) {
      if (!this.c.literals.isWrittenMember(source, property)) continue;
      const value = property.declaration?.type === 'pair' ? property.declaration.childForFieldName('value') : undefined;
      const targetType = this.contextOfWrittenProperty(target, property);
      if (value && targetType) this.checkAssertedArrayLiterals(value, property.type(), targetType);
    }
  }

  /** Checks the object literals among an array's or a tuple's elements against the target's elements. */
  private checkExcessElements(
    node: TreeNode,
    source: ObjectType,
    target: Type,
    options?: ExcessPropertyOptions
  ): boolean {
    const targets = arrayTargets(this.c, target);
    if (targets.length === 0) return true;
    const sourceElements = source.tuple?.elements;
    const elementCount = sourceElements?.length ?? 1;
    let fits = true;
    for (let index = 0; index < elementCount; index++) {
      const element = sourceElements ? sourceElements[index].type : this.c.elementTypeOf(source);
      fits = this.checkExcessProperties(node, element, targetElementType(this.c, target, index), options) && fits;
    }
    return fits;
  }

  /** The members of a target union that an object literal's discriminant properties select, or all of them. */
  private discriminatedTargets(source: ObjectType, targets: Type[]): Type[] {
    if (targets.length < 2) return targets;
    const union = unionOf(targets);
    let selected = targets;
    for (const [name, property] of source.resolve().properties) {
      const value = regularOf(property.type());
      if (value.kind !== 'literal' || !this.c.flow.isDiscriminant(union, name)) continue;
      const matching = selected.filter((member) => {
        const memberProperty = this.c.propertyOf(member, name);
        return !memberProperty || this.c.relations.isAssignable(value, memberProperty.type());
      });
      if (matching.length > 0) selected = matching;
    }
    return selected;
  }

  private isObjectPrototypeProperty(member: Type, name: string): boolean {
    return (
      !this.c.structureOf(member).properties.has(name) && this.c.globalType('Object').resolve().properties.has(name)
    );
  }

  /** Checks that `type` can be assigned to `target`, reporting at `node`. */
  checkAssignable(node: TreeNode, type: Type, target: Type, expression?: TreeNode): boolean {
    if (!this.c.relations.isAssignable(type, target)) {
      this.reportNotAssignable(node, type, target, expression);
      return false;
    }
    this.checkExcessProperties(node, type, target);
    return true;
  }
}

const sideEffectFreeTypes = new Set([
  'identifier',
  'undefined',
  'string',
  'regex',
  'template_string',
  'number',
  'true',
  'false',
  'null',
  'function_expression',
  'arrow_function',
  'class',
  'array',
  'object',
  'non_null_expression',
]);

/** Whether evaluating an expression has no effect, as TypeScript's `isSideEffectFree` decides for the comma operator. */
function isSideEffectFree(node: TreeNode): boolean {
  const expression = skipParentheses(node);
  if (sideEffectFreeTypes.has(expression.type)) return true;
  switch (expression.type) {
    case 'call_expression': {
      return expression.childForFieldName('arguments')?.type === 'template_string';
    }
    case 'ternary_expression': {
      return ['consequence', 'alternative'].every((field) =>
        isSideEffectFree(expression.childForFieldName(field) as TreeNode)
      );
    }
    case 'binary_expression': {
      return ['left', 'right'].every((field) => isSideEffectFree(expression.childForFieldName(field) as TreeNode));
    }
    case 'sequence_expression': {
      return named(expression).every((child) => isSideEffectFree(child));
    }
    case 'unary_expression': {
      // tsc takes these operators as free of side effects whatever their operand, though it may call a function.
      return ['typeof', '!', '+', '-', '~'].includes(expression.childForFieldName('operator')?.text ?? '');
    }
    default: {
      return false;
    }
  }
}

/** `(0, o.f)()` or `(0, eval)()`, which calls a function without passing its object as `this`. */
function isIndirectCall(sequence: TreeNode, left: TreeNode, right: TreeNode): boolean {
  const parenthesized = sequence.parent;
  const call = parenthesized?.parent;
  return (
    parenthesized?.type === 'parenthesized_expression' &&
    left.type === 'number' &&
    left.text === '0' &&
    call?.type === 'call_expression' &&
    call.childForFieldName('function')?.id === parenthesized.id &&
    (right.type === 'member_expression' ||
      right.type === 'subscript_expression' ||
      (right.type === 'identifier' && right.text === 'eval'))
  );
}

/** Node.js names that need its type definitions, which the reference `tsc` does not have. */
function nodeGlobalHint(name: string): string {
  return ['module', 'exports', '__dirname', '__filename'].includes(name)
    ? 'Node.js の機能は、この採点環境では使えません。'
    : '';
}

/** The members of a target that an object literal's excess properties are checked against. */
function objectTargets(target: Type): Type[] {
  return (target.kind === 'union' ? target.types : [target]).filter(
    (member) => member === nonPrimitiveType || member.kind === 'object' || member.kind === 'intersection'
  );
}

/** Whether an expression, through parentheses, is what a call or `new` calls. */
function isDirectOrWrappedRequireCallee(node: TreeNode): boolean {
  let current = node;
  while (
    current.parent &&
    [
      'parenthesized_expression',
      'as_expression',
      'satisfies_expression',
      'non_null_expression',
      'type_assertion',
    ].includes(current.parent.type)
  ) {
    current = current.parent;
  }
  const call = current.parent;
  return (
    call?.type === 'call_expression' &&
    call.childForFieldName('function')?.id === current.id &&
    call.childForFieldName('arguments')?.type !== 'template_string' &&
    withoutAssertions(current).id === node.id
  );
}

function isCallee(node: TreeNode): boolean {
  let expression = node;
  while (expression.parent?.type === 'parenthesized_expression') expression = expression.parent;
  const { parent } = expression;
  const callee = parent?.childForFieldName(parent.type === 'new_expression' ? 'constructor' : 'function');
  return (parent?.type === 'call_expression' || parent?.type === 'new_expression') && callee?.id === expression.id;
}

/** Whether a node is in a decorator inside a declaration, such as one of a class's members. */
function isWithinDecorator(node: TreeNode, declaration: TreeNode): boolean {
  if (node.startIndex < declaration.startIndex || node.endIndex > declaration.endIndex) return false;
  for (let current = node.parent; current && current.id !== declaration.id; current = current.parent)
    if (current.type === 'decorator') return true;
  return false;
}

function isNewTargetBoundary(container: TreeNode, child: TreeNode): boolean {
  if (!newTargetBoundaries.has(container.type)) return false;
  if (child.type === 'decorator') return false;
  return container.childForFieldName('name')?.id !== child.id;
}
