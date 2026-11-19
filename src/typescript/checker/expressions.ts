// code-gauge-allow-file fileNcss 516 -- Resolves expressions, lexical references, closure captures, and contextual assignment diagnostics; memoization is separate.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { unsupportedMessage } from '../unsupported';
import { Calls } from './calls';
import type { Checker } from './checker';
import { DeferredContexts } from './deferredContexts';
import { arrayTargets, Elaboration, targetElementType } from './elaboration';
import { Expandos, laterRunningTypes } from './expandos';
import { ExpressionTypeCache } from './expressionTypeCache';
import type { FlowEntry } from './flow';
import { applicableIndex, applicablePatternIndexes } from './indexInfos';
import { nonNullableType } from './nullishConstraints';
import type { Sym } from './scopes';
import { nameSuggestionHint } from './spelling';
import {
  arrayLiteralLength,
  assignmentKind,
  hasToken,
  isImmediatelyInvoked,
  isNumericName,
  named,
  numberValue,
  patternIdentifiers,
  stringValue,
  templateFragmentText,
} from './syntax';
import {
  isTemplateLiteralContext,
  isTemplateLiteralContextualType,
  templatePlaceholderConstraint,
} from './templateContexts';
import {
  anyType,
  errorType,
  freshLiteralType,
  isAnyLike,
  isIntrinsic,
  isSymbolName,
  literalType,
  nullType,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  stringType,
  symbolType,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
} from './types';
import { UniqueSymbols } from './uniqueSymbols';

/** Checks expressions, computing their types and narrowing the references their conditions test. */
export class ExpressionChecker {
  readonly calls: Calls;
  readonly expandos: Expandos;
  readonly elaboration: Elaboration;
  private readonly silentTypes: ExpressionTypeCache;
  private readonly uniqueSymbols: UniqueSymbols;
  /** Types of variables computed from their declarations, by symbol. */
  private readonly variableTypes = new Map<number, Type>();

  /** The type of each kind of expression; the others check their children and are `any`. */
  private readonly checkers = new Map<string, (node: TreeNode, contextual?: Type) => Type>([
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
    ['parenthesized_expression', (node, contextual) => this.check(named(node)[0], contextual)],
    ['array', (node, contextual) => this.c.literals.arrayLiteral(node, contextual)],
    ['object', (node, contextual) => this.c.literals.objectLiteral(node, contextual)],
    ['function_expression', (node, contextual) => this.c.functions.functionExpression(node, contextual)],
    ['arrow_function', (node, contextual) => this.c.functions.functionExpression(node, contextual)],
    ['class', (node) => this.c.classes.classExpression(node)],
    ['member_expression', (node) => this.c.members.chainLink(node, () => this.c.members.memberAccess(node))],
    ['subscript_expression', (node) => this.c.members.chainLink(node, () => this.c.members.elementAccess(node))],
    [
      'call_expression',
      (node, contextual) =>
        this.c.members.chainLink(node, () => this.uniqueSymbols.typeOfCall(node, this.calls.call(node, contextual))),
    ],
    ['new_expression', (node, contextual) => this.calls.newExpression(node, contextual)],
    ['assignment_expression', (node) => this.c.assignments.assignment(node)],
    ['augmented_assignment_expression', (node) => this.c.assignments.compoundAssignment(node)],
    ['update_expression', (node) => this.c.assignments.update(node)],
    ['unary_expression', (node) => this.c.operators.unary(node)],
    ['binary_expression', (node, contextual) => this.c.operators.binary(node, contextual)],
    ['ternary_expression', (node, contextual) => this.c.operators.ternary(node, contextual)],
    ['as_expression', (node, contextual) => this.c.operators.assertion(node, contextual)],
    ['type_assertion', (node, contextual) => this.c.operators.assertion(node, contextual)],
    ['satisfies_expression', (node, contextual) => this.check(named(node)[0], contextual)],
    ['non_null_expression', (node, contextual) => nonNullableType(this.c, this.check(named(node)[0], contextual))],
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

  check(node: TreeNode, contextual?: Type): Type {
    this.c.budget.spend();
    if (this.c.silent === 0) return this.compute(node, contextual);
    return this.silentTypes.check(node, contextual, () => this.compute(node, contextual));
  }

  private compute(node: TreeNode, contextual?: Type): Type {
    const checkKind = this.checkers.get(node.type);
    if (checkKind) return checkKind(node, contextual);
    for (const child of named(node)) this.check(child);
    return anyType;
  }

  /**
   * Reports a function or a class turned into text: Node.js shows the source tsx's esbuild printed for it, which this
   * interpreter does not reproduce.
   */
  checkFunctionText(node: TreeNode, type: Type): void {
    if (isAnyLike(type)) return;
    const isFunction = (member: Type): boolean =>
      member.kind === 'object' &&
      (this.c.isLibraryType(member, 'Function') ||
        this.c.signaturesOf(member, 'call').length > 0 ||
        this.c.signaturesOf(member, 'construct').length > 0);
    if ((type.kind === 'union' ? type.types : [type]).some(isFunction)) {
      this.c.error(node, unsupportedMessage('関数やクラスの文字列への変換'));
    }
  }

  isSymbolLike(type: Type): boolean {
    return !isAnyLike(type) && !isIntrinsic(type, 'never') && this.c.relations.isAssignable(type, symbolType);
  }

  mayBeSymbol(type: Type): boolean {
    const constraint = this.c.baseConstraint(type);
    return (constraint.kind === 'union' ? constraint.types : [constraint]).some((member) => this.isSymbolLike(member));
  }

  private templateString(node: TreeNode, contextual: Type | undefined): Type {
    const texts = [''];
    const types: Type[] = [];
    for (const child of named(node)) {
      if (child.type !== 'template_substitution') {
        if (child.type === 'string_fragment' || child.type === 'escape_sequence')
          texts[texts.length - 1] += templateFragmentText(child);
        continue;
      }
      types.push(this.templateSubstitution(named(child)[0]));
      texts.push('');
    }
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
  checkComputedPropertyName(name: TreeNode): Type {
    const type = this.check(named(name)[0] ?? name);
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
    return this.c.silently(() => this.check(node));
  }

  /** The type of a parameter's default value, widened, in the context of the function. */
  widenedTypeOfInitializer(node: TreeNode): Type {
    return this.c.silently(() => this.c.literals.widenDeclared(this.check(node), false));
  }

  /** The type of a parameter that has neither an annotation nor a contextual type: an implicit `any`. */
  implicitParameterType(parameter: TreeNode, pattern: TreeNode, rest: boolean): Type {
    if (!this.c.isLibrary(parameter)) {
      if (pattern.type === 'identifier') {
        this.c.error(parameter, `引数 ${pattern.text} の型が暗黙に any になります。型を書いてください。`);
      } else if (rest) {
        const name = named(pattern)[0]?.text ?? '';
        this.c.error(parameter, `残余引数 ${name} の型が暗黙に any[] になります。型を書いてください。`);
      } else {
        for (const identifier of patternIdentifiers(pattern))
          this.c.error(
            identifier,
            `分割代入の要素 ${identifier.text} の型が暗黙に any になります。型を書いてください。`
          );
      }
    }
    return rest ? this.c.arrayType(anyType) : anyType;
  }

  /** The type of a `typeof x` type query. */
  typeOfQuery(node: TreeNode): Type {
    if (node.type === 'identifier') {
      const symbol = this.c.scopeOf(node).lookupValue(node.text);
      if (!symbol) return this.implicitArgumentsType(node) ?? this.reportUnknownValue(node, node.text);
      return this.reportUnavailableValue(node, symbol)
        ? errorType
        : this.variableReferenceType(node, symbol, undefined, true);
    }
    if (node.type === 'member_expression') {
      const object = node.childForFieldName('object') as TreeNode;
      const property = node.childForFieldName('property') as TreeNode;
      const type = this.c.members.propertyAccess(node, object, property, this.typeOfQuery(object), property.text);
      const key = this.c.flow.referenceKey(node);
      return key ? (this.c.flow.entry(key)?.type ?? type) : type;
    }
    return this.check(node);
  }

  // Identifiers --------------------------------------------------------------------------------------------------

  identifier(node: TreeNode, contextual?: Type): Type {
    const name = node.text;
    const symbol = this.c.scopeOf(node).lookupValue(name);
    if (!symbol) {
      if (name === 'undefined') return undefinedType;
      return this.implicitArgumentsType(node) ?? this.reportUnknownValue(node, name);
    }
    if (this.reportUnavailableValue(node, symbol)) return errorType;
    this.checkUsedBeforeDeclaration(node, symbol);
    return this.variableReferenceType(node, symbol, contextual);
  }

  private implicitArgumentsType(node: TreeNode): Type | undefined {
    return node.text === 'arguments' && this.hasArguments(node) ? this.c.globalType('IArguments') : undefined;
  }

  private variableReferenceType(node: TreeNode, symbol: Sym, contextual?: Type, typeQuery = false): Type {
    const declared = this.valueTypeOf(symbol);
    const key = `s${symbol.id}`;
    this.c.flow.declaredTypes.set(key, declared);
    const entry = this.c.flow.entry(key);
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
      return entry?.type ?? this.closureVariableType(node, symbol, declared);
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
      !hasToken(declaration, '!')
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
      if (['function_declaration', 'function_expression', 'method_definition'].includes(current.type)) return true;
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
    const unassignedAuto =
      !entry.assigned && this.c.assignments.isAutoTyped(symbol) && isIntrinsic(entry.type, 'undefined');
    if (
      !typeQuery &&
      !entry.assigned &&
      (unassignedAuto || this.needsDefiniteAssignment(symbol, declared)) &&
      assignmentKind(node) !== 'definite' &&
      node.parent?.type !== 'non_null_expression'
    ) {
      this.c.error(node, `変数 ${symbol.name} は値を代入する前に使われています。`);
      if (unassignedAuto) return errorType;
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
  private closureVariableType(node: TreeNode, symbol: Sym, declared: Type): Type {
    const closure = this.c.functions.contexts.at(-1)?.node;
    const evolving = this.isEvolvingArrayDeclaration(symbol);
    if (evolving || this.c.assignments.isAutoTyped(symbol)) symbol.usedInClosure = true;
    if (evolving && this.isEvolvingUse(node)) return declared;
    const assignedLater =
      closure !== undefined && symbol.assignmentOffsets.some((offset) => offset > closure.startIndex);
    const deferred =
      closure?.type === 'function_declaration' ||
      closure?.type === 'generator_function_declaration' ||
      (closure?.type === 'method_definition' && closure.parent?.type === 'class_body');
    if (
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
    const value = declaration?.type === 'variable_declarator' ? declaration.childForFieldName('value') : undefined;
    return (
      declaration?.type === 'variable_declarator' &&
      !declaration.childForFieldName('type') &&
      value?.type === 'array' &&
      arrayLiteralLength(value) === 0
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

  // code-gauge-allow functionCognitiveComplexity 22 -- Follows TypeScript's rules for uses before a declaration, which depend on when the use runs.
  checkUsedBeforeDeclaration(node: TreeNode, symbol: Sym): void {
    if (symbol.valueKind === 'function') {
      this.checkParameterUseOfBodyFunction(node, symbol);
      return;
    }
    if (
      symbol.valueKind !== 'let' &&
      symbol.valueKind !== 'const' &&
      symbol.valueKind !== 'class' &&
      symbol.valueKind !== 'parameter'
    )
      return;
    const declaration = symbol.valueDeclaration;
    if (!declaration || this.c.isLibrary(declaration)) return;
    if (!this.beforeBindingInitialized(node, symbol, declaration)) return;
    // A use inside a function that runs later is fine.
    for (let current: TreeNode | null = node.parent; current; current = current.parent) {
      if (current.id === declaration.id) break;
      if (
        laterRunningTypes.has(current.type) &&
        !(current.startIndex <= declaration.startIndex && declaration.endIndex <= current.endIndex) &&
        !isImmediatelyInvoked(current)
      ) {
        return;
      }
      if (current.type === 'field_definition' && !hasToken(current, 'static')) return;
    }
    const kind = symbol.valueKind === 'class' ? 'クラス' : '変数';
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
    if (symbol.valueKind === 'class' || node.startIndex >= declaration.endIndex) return false;
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
    if (symbol.valueType) return symbol.valueType;
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
      if (
        symbol.valueKind === 'function' ||
        symbol.valueKind === 'class' ||
        symbol.valueKind === 'declared' ||
        symbol.valueKind === 'catch'
      )
        symbol.valueType = type;
      else this.variableTypes.set(symbol.id, type);
      return type;
    } finally {
      symbol.resolving = false;
    }
  }

  setVariableType(symbol: Sym, type: Type): void {
    this.variableTypes.set(symbol.id, type);
  }

  // code-gauge-allow functionNcss 31 -- Keeps declaration-kind dispatch together; function overload resolution has its own helper.
  private computeValueType(symbol: Sym): Type {
    const declaration = symbol.valueDeclaration;
    if (!declaration) return anyType;
    switch (symbol.valueKind) {
      case 'function': {
        return this.functionSymbolType(symbol);
      }
      case 'class': {
        return this.c.classes.classInfoOf(symbol).staticType;
      }
      case 'catch': {
        const annotation = this.c.typeNodes.annotationType(declaration.childForFieldName('type'));
        const parameter = declaration.childForFieldName('parameter');
        const type = annotation ?? unknownType;
        if (parameter && parameter.type !== 'identifier')
          return this.c.silently(() => this.c.patterns.patternType(parameter, type, symbol.name));
        return type;
      }
      case 'parameter': {
        const pattern = declaration.childForFieldName('pattern') ?? declaration;
        const annotation = this.c.typeNodes.annotationType(declaration.childForFieldName('type'));
        if (annotation) {
          if (pattern.type === 'identifier' || pattern.type === 'rest_pattern') return annotation;
          return this.c.silently(() => this.c.patterns.patternType(pattern, annotation, symbol.name));
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
    if (expression?.type === 'function_expression') return this.c.silently(() => this.check(expression));
    const signatures = symbol.valueDeclarations.filter((node) => node.type === 'function_signature');
    const implementation = symbol.valueDeclarations.find((node) => node.type === 'function_declaration');
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
  checkExcessProperties(node: TreeNode, source: Type, target: Type): void {
    // Each object literal a union or an array literal holds is checked against where it goes.
    if (source.kind === 'union') {
      for (const member of source.types) this.checkExcessProperties(node, member, target);
      return;
    }
    if (source.kind === 'object' && this.c.literals.isArrayOrTupleLiteral(source)) {
      this.checkExcessElements(node, source, target);
      return;
    }
    if (source.kind !== 'object' || !source.fresh) return;
    const targets = this.discriminatedTargets(source, objectTargets(target));
    if (targets.length === 0 || this.acceptsAnyProperty(targets)) return;
    // A discriminated union checks the members its discriminant selects; an index signature takes any key it covers,
    // whose value is still checked against it.
    for (const property of source.resolve().properties.values()) {
      if (
        this.c.literals.isWrittenMember(source, property) &&
        !this.checkWrittenProperty(node, property, targets, target)
      )
        return;
    }
    this.checkExcessIndexValues(node, source, targets);
  }

  /** Checks a written property of a fresh object literal against the targets, returning whether it fits them. */
  private checkWrittenProperty(node: TreeNode, property: Property, targets: Type[], target: Type): boolean {
    if (!this.isKnownProperty(targets, property.name)) {
      this.c.error(
        property.declaration?.childForFieldName('key') ?? property.declaration ?? node,
        `オブジェクトリテラルには既知のプロパティしか書けません。'${property.name}' は型 '${this.c.print(target)}' にありません。`
      );
      return false;
    }
    if (target.kind === 'union' && !this.fitsUnionProperty(node, property, targets, target)) return false;
    this.checkExcessPropertyValue(property, target);
    return true;
  }

  private acceptsAnyProperty(targets: Type[]): boolean {
    return targets.some(
      (member) =>
        member.kind === 'object' &&
        (this.c.relations.isEmptyObjectType(member) ||
          (member.objectKind === 'mapped' && this.c.relations.isGeneric(member)))
    );
  }

  private isKnownProperty(targets: Type[], name: string): boolean {
    return targets.some(
      (member) =>
        (this.c.propertyOf(member, name) !== undefined && !this.isObjectPrototypeProperty(member, name)) ||
        this.c.structureOf(member).stringIndex !== undefined ||
        (isNumericName(name) && this.c.structureOf(member).numberIndex !== undefined) ||
        (isSymbolName(name)
          ? this.c.structureOf(member).symbolIndex !== undefined
          : applicablePatternIndexes(this.c, this.c.structureOf(member), literalType(name)).length > 0)
    );
  }

  /**
   * Reports a written property of a literal assigned to a union whose value does not fit the property's type in the
   * selected members, `undefined` where a member lacks it: a union member without the property may accept the literal
   * as a whole, yet TypeScript rejects the value.
   */
  private fitsUnionProperty(node: TreeNode, property: Property, targets: Type[], target: Type): boolean {
    const declared = unionOf(targets.map((member) => this.typeOfPropertyIn(member, property.name)));
    if (this.c.relations.isAssignable(property.type(), declared)) return true;
    const { declaration } = property;
    const value = declaration?.type === 'pair' ? declaration.childForFieldName('value') : undefined;
    this.reportNotAssignable(
      declaration?.childForFieldName('key') ?? declaration ?? node,
      property.type(),
      this.c.literals.contextualPropertyType(target, property.name) ?? declared,
      value ?? undefined
    );
    return false;
  }

  /** The type a member of a union gives a property, as its own or by an index signature, or `undefined`. */
  private typeOfPropertyIn(member: Type, name: string): Type {
    const property = this.c.propertyOf(member, name);
    if (property) return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
    const structure = this.c.structureOf(member);
    const index = isSymbolName(name) ? structure.symbolIndex : applicableIndex(this.c, structure, literalType(name));
    return index?.type ?? undefinedType;
  }

  /** Checks the object literal a written property's value spells against the target's type of the property. */
  private checkExcessPropertyValue(property: Property, target: Type): void {
    const value = property.declaration?.type === 'pair' ? property.declaration.childForFieldName('value') : undefined;
    const targetType = this.c.literals.contextualPropertyType(target, property.name);
    if (value && targetType) this.checkExcessProperties(value, property.type(), targetType);
  }

  /** Checks the object literals that computed keys give a literal's string index against the targets' string index. */
  private checkExcessIndexValues(node: TreeNode, source: ObjectType, targets: Type[]): void {
    const sourceIndex = source.resolve().stringIndex;
    const targetIndexes = targets.flatMap((member) => this.c.structureOf(member).stringIndex?.type ?? []);
    if (sourceIndex && targetIndexes.length > 0)
      this.checkExcessProperties(node, sourceIndex.type, unionOf(targetIndexes));
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
    for (const [name, property] of source.resolve().properties) {
      if (!this.c.literals.isWrittenMember(source, property)) continue;
      const value = property.declaration?.type === 'pair' ? property.declaration.childForFieldName('value') : undefined;
      const targetType = this.c.literals.contextualPropertyType(target, name);
      if (value && targetType) this.checkAssertedArrayLiterals(value, property.type(), targetType);
    }
  }

  /** Checks the object literals among an array's or a tuple's elements against the target's elements. */
  private checkExcessElements(node: TreeNode, source: ObjectType, target: Type): void {
    const targets = arrayTargets(this.c, target);
    if (targets.length === 0) return;
    const sourceElements = source.tuple?.elements;
    const elementCount = sourceElements?.length ?? 1;
    for (let index = 0; index < elementCount; index++) {
      const element = sourceElements ? sourceElements[index].type : this.c.elementTypeOf(source);
      this.checkExcessProperties(node, element, targetElementType(this.c, target, index));
    }
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

/** Node.js names that need its type definitions, which the reference `tsc` does not have. */
function nodeGlobalHint(name: string): string {
  return ['process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer'].includes(name)
    ? 'Node.js の機能は、この採点環境では使えません。'
    : '';
}

/** The members of a target that an object literal's excess properties are checked against. */
function objectTargets(target: Type): Type[] {
  return (target.kind === 'union' ? target.types : [target]).filter(
    (member) => member.kind === 'object' || member.kind === 'intersection'
  );
}

/** Whether an expression, through parentheses, is what a call or `new` calls. */
function isCallee(node: TreeNode): boolean {
  let expression = node;
  while (expression.parent?.type === 'parenthesized_expression') expression = expression.parent;
  const { parent } = expression;
  const callee = parent?.childForFieldName(parent.type === 'new_expression' ? 'constructor' : 'function');
  return (parent?.type === 'call_expression' || parent?.type === 'new_expression') && callee?.id === expression.id;
}
