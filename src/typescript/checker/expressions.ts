import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { unsupportedMessage } from '../unsupported';
import { Calls } from './calls';
import type { Checker } from './checker';
import { type FlowState, isUnit, type State } from './flow';
import type { Sym } from './scopes';
import {
  hasToken,
  named,
  numberValue,
  patternIdentifiers,
  propertyNameText,
  skipParentheses,
  stringValue,
} from './syntax';
import {
  anonymousObject,
  anyType,
  bigintType,
  booleanType,
  emptyStructure,
  errorType,
  falseType,
  filterType,
  freshLiteralType,
  functionType,
  intersectionOf,
  isAnyLike,
  isIntrinsic,
  literalType,
  mapType,
  neverType,
  nullType,
  numberType,
  type ObjectType,
  type Property,
  regularOf,
  type Signature,
  stringType,
  type Structure,
  trueType,
  type Type,
  undefinedType,
  unionOf,
  unknownType,
  voidType,
} from './types';

/** What checking a function's body found about how it returns. */
export interface FunctionContext {
  node: TreeNode;
  returnTypes: Type[];
  /** Whether the end of the body is reachable, where the function returns `undefined`. */
  endReachable: boolean;
  declaredReturn?: Type;
  /** Whether returned literals keep their types, as when the declared or contextual return type has literals. */
  keepsLiterals: boolean;
  isConstructor: boolean;
  hasReturnWithValue: boolean;
  /** Whether the body has a `return` statement, with or without a value. */
  hasReturn: boolean;
  /** The flow states at its `return` statements. */
  returnStates: State[];
  contextualReturn?: Type;
}

const typeofResult = unionOf(
  ['string', 'number', 'bigint', 'boolean', 'symbol', 'undefined', 'object', 'function'].map((name) =>
    literalType(name)
  )
);

/** Checks expressions, computing their types and narrowing the references their conditions test. */
export class ExpressionChecker {
  readonly calls: Calls;
  /** The functions whose bodies are being checked, innermost last. */
  readonly functions: FunctionContext[] = [];
  private readonly inferring = new Set<number>();
  private readonly inferredReturns = new Map<number, Type>();
  /** Parameter types of functions checked with a contextual signature, by symbol. */
  readonly parameterTypes = new Map<number, Type>();
  /** Types of variables computed from their declarations, by symbol. */
  private readonly variableTypes = new Map<number, Type>();

  constructor(private readonly c: Checker) {
    this.calls = new Calls(c);
  }

  // Entry points -------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 80 -- One case per kind of expression.
  check(node: TreeNode, contextual?: Type): Type {
    switch (node.type) {
      case 'number': {
        return freshLiteralType(numberValue(node.text));
      }
      case 'string': {
        return freshLiteralType(stringValue(node));
      }
      case 'template_string': {
        for (const child of named(node)) {
          if (child.type === 'template_substitution') this.check(named(child)[0]);
        }
        return contextual &&
          this.hasLiteralConstituent(contextual, 'string') &&
          named(node).every((child) => child.type !== 'template_substitution')
          ? freshLiteralType(
              named(node)
                .filter((child) => child.type === 'string_fragment')
                .map((child) => child.text)
                .join('')
            )
          : stringType;
      }
      case 'regex': {
        return this.c.globalType('RegExp');
      }
      case 'true': {
        return freshLiteralType(true);
      }
      case 'false': {
        return freshLiteralType(false);
      }
      case 'null': {
        return nullType;
      }
      case 'undefined': {
        return undefinedType;
      }
      case 'identifier': {
        return this.identifier(node);
      }
      case 'this': {
        return this.thisExpression(node);
      }
      case 'parenthesized_expression': {
        return this.check(named(node)[0], contextual);
      }
      case 'array': {
        return this.arrayLiteral(node, contextual);
      }
      case 'object': {
        return this.objectLiteral(node, contextual);
      }
      case 'function_expression':
      case 'arrow_function': {
        return this.functionExpression(node, contextual);
      }
      case 'class': {
        return this.c.classes.classExpression(node);
      }
      case 'member_expression': {
        return this.memberAccess(node);
      }
      case 'subscript_expression': {
        return this.elementAccess(node);
      }
      case 'call_expression': {
        return this.calls.call(node, contextual);
      }
      case 'new_expression': {
        return this.calls.newExpression(node, contextual);
      }
      case 'assignment_expression': {
        return this.assignment(node);
      }
      case 'augmented_assignment_expression': {
        return this.compoundAssignment(node);
      }
      case 'update_expression': {
        return this.update(node);
      }
      case 'unary_expression': {
        return this.unary(node);
      }
      case 'binary_expression': {
        return this.binary(node, contextual);
      }
      case 'ternary_expression': {
        return this.ternary(node, contextual);
      }
      case 'as_expression':
      case 'type_assertion': {
        return this.assertion(node);
      }
      case 'satisfies_expression': {
        return this.check(named(node)[0], contextual);
      }
      case 'non_null_expression': {
        return this.c.relations.removeNullish(this.check(named(node)[0], contextual));
      }
      case 'spread_element': {
        return this.check(named(node)[0]);
      }
      default: {
        for (const child of named(node)) this.check(child);
        return anyType;
      }
    }
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
    return this.c.silently(() => this.widenDeclared(this.check(node), false));
  }

  /** The type of a parameter that has neither an annotation nor a contextual type: an implicit `any`. */
  implicitParameterType(parameter: TreeNode, pattern: TreeNode, rest: boolean): Type {
    if (!this.c.isLibrary(parameter) && this.reportsImplicitAny(parameter)) {
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

  /** Whether a parameter's implicit `any` is an error: not in a type-only declaration, which reports it elsewhere. */
  private reportsImplicitAny(parameter: TreeNode): boolean {
    const owner = parameter.parent?.parent;
    if (!owner) return true;
    return true;
  }

  /** The type of a `typeof x` type query. */
  typeOfQuery(node: TreeNode): Type {
    return this.c.silently(() => {
      if (node.type === 'identifier') {
        const symbol = this.c.scopeOf(node).lookupValue(node.text);
        if (!symbol) return anyType;
        return this.valueTypeOf(symbol);
      }
      return this.check(node);
    });
  }

  // Identifiers --------------------------------------------------------------------------------------------------

  private identifier(node: TreeNode): Type {
    const name = node.text;
    const symbol = this.c.scopeOf(node).lookupValue(name);
    if (!symbol) {
      if (name === 'undefined') return undefinedType;
      const typeSymbol = this.c.scopeOf(node).lookupType(name);
      if (typeSymbol && typeSymbol.typeKind !== 'class') {
        this.c.error(node, `${name} は型であり、値としては使えません。`);
      } else {
        this.c.error(node, `名前 ${name} が見つかりません。${nodeGlobalHint(name)}`);
      }
      return errorType;
    }
    if (symbol.unsupported) {
      this.c.error(node, unsupportedMessage(symbol.unsupported));
      return errorType;
    }
    this.checkUsedBeforeDeclaration(node, symbol);
    const declared = this.valueTypeOf(symbol);
    const key = `s${symbol.id}`;
    this.c.flow.declaredTypes.set(key, declared);
    const entry = this.c.flow.entry(key);
    if (this.isOuterVariable(node, symbol)) return this.outerVariableType(symbol, declared);
    if (entry) {
      const unassignedAuto = !entry.assigned && this.isAutoTyped(symbol) && isIntrinsic(entry.type, 'undefined');
      if (
        !entry.assigned &&
        (unassignedAuto || this.needsDefiniteAssignment(symbol, declared)) &&
        !this.isAssignmentTarget(node)
      ) {
        this.c.error(node, `変数 ${name} は値を代入する前に使われています。`);
        if (unassignedAuto) return errorType;
      }
      if (entry.evolving && !this.isEvolvingUse(node)) return this.finishEvolving(entry.type);
      return entry.type;
    }
    return declared;
  }

  private isEvolvingUse(node: TreeNode): boolean {
    const parent = node.parent;
    if (parent?.type === 'member_expression' && parent.childForFieldName('object')?.id === node.id) {
      const property = parent.childForFieldName('property')?.text;
      return property === 'push' || property === 'unshift';
    }
    if (parent?.type === 'subscript_expression' && parent.childForFieldName('object')?.id === node.id) {
      return (
        parent.parent?.type === 'assignment_expression' && parent.parent.childForFieldName('left')?.id === parent.id
      );
    }
    return false;
  }

  private finishEvolving(type: Type): Type {
    if (type.kind === 'object' && this.c.isArrayType(type) && isIntrinsic(this.c.elementTypeOf(type), 'never')) {
      return this.c.arrayType(anyType);
    }
    return type;
  }

  private isAssignmentTarget(node: TreeNode): boolean {
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
    const owner = this.functions.at(-1)?.node;
    if (!owner) return false;
    for (let current: TreeNode | null | undefined = symbol.valueDeclaration; current; current = current.parent) {
      if (current.id === owner.id) return false;
    }
    return true;
  }

  /** The type a nested function sees for a variable of an enclosing one: narrowed if nothing reassigns it. */
  private outerVariableType(symbol: Sym, declared: Type): Type {
    if (symbol.valueKind === 'const' || !symbol.isReassigned) {
      const captured = this.capturedTypes.at(-1)?.get(`s${symbol.id}`);
      if (captured) return captured;
    }
    return declared;
  }

  /** The narrowed types of variables when each function being checked was created. */
  readonly capturedTypes: Map<string, Type>[] = [];

  private checkUsedBeforeDeclaration(node: TreeNode, symbol: Sym): void {
    if (symbol.valueKind !== 'let' && symbol.valueKind !== 'const' && symbol.valueKind !== 'class') return;
    const declaration = symbol.valueDeclaration;
    if (!declaration || this.c.isLibrary(declaration)) return;
    if (node.startIndex >= declaration.startIndex) {
      // Inside its own initializer, a variable is still uninitialized.
      if (symbol.valueKind === 'class' || node.startIndex >= declaration.endIndex) return;
      const value = declaration.childForFieldName('value');
      if (!value || node.startIndex < value.startIndex) return;
    }
    // A use inside a function that runs later is fine.
    for (let current: TreeNode | null = node.parent; current; current = current.parent) {
      if (current.id === declaration.id) break;
      if (
        laterRunningTypes.has(current.type) &&
        !(current.startIndex <= declaration.startIndex && declaration.endIndex <= current.endIndex)
      ) {
        return;
      }
      if (current.type === 'public_field_definition' && !hasToken(current, 'static')) return;
    }
    const kind = symbol.valueKind === 'class' ? 'クラス' : '変数';
    this.c.error(node, `${kind} ${symbol.name} は宣言より前で使われています。`);
  }

  /** The type of a value a symbol declares. */
  valueTypeOf(symbol: Sym): Type {
    if (symbol.valueType) return symbol.valueType;
    const parameterType = this.parameterTypes.get(symbol.id);
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

  hasVariableType(symbol: Sym): boolean {
    return this.variableTypes.has(symbol.id);
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of declaration.
  private computeValueType(symbol: Sym): Type {
    const declaration = symbol.valueDeclaration;
    if (!declaration) return anyType;
    switch (symbol.valueKind) {
      case 'function': {
        const signatures = symbol.valueDeclarations.filter((node) => node.type === 'function_signature');
        const implementation = symbol.valueDeclarations.find((node) => node.type === 'function_declaration');
        const declared = signatures.length > 0 ? signatures : implementation ? [implementation] : [];
        const callSignatures = declared.map((node) => this.c.signatureOf(node));
        const expandos = implementation ? this.expandoAssignments(implementation, symbol.name) : [];
        if (expandos.length === 0) return this.c.overloadedFunction(callSignatures);
        return anonymousObject(
          () => {
            const structure = { ...emptyStructure(), callSignatures };
            for (const [name, value] of expandos) {
              structure.properties.set(
                name,
                this.literalProperty(
                  name,
                  this.c.silently(() => this.c.widen(this.check(value))),
                  false,
                  value
                )
              );
            }
            return structure;
          },
          { isFunction: false }
        );
      }
      case 'class': {
        return this.c.classes.classInfoOf(symbol).staticType;
      }
      case 'catch': {
        const annotation = this.c.annotationType(declaration.childForFieldName('type'));
        const parameter = declaration.childForFieldName('parameter');
        const type = annotation ?? unknownType;
        if (parameter && parameter.type !== 'identifier')
          return this.c.silently(() => this.patternType(parameter, type, symbol.name));
        return type;
      }
      case 'parameter': {
        const pattern = declaration.childForFieldName('pattern') ?? declaration;
        const annotation = this.c.annotationType(declaration.childForFieldName('type'));
        if (annotation) {
          if (pattern.type === 'identifier' || pattern.type === 'rest_pattern') return annotation;
          return this.c.silently(() => this.patternType(pattern, annotation, symbol.name));
        }
        const value = declaration.childForFieldName('value');
        if (value) return this.widenedTypeOfInitializer(value);
        return pattern.type === 'rest_pattern' ? this.c.arrayType(anyType) : anyType;
      }
      case 'declared': {
        return this.c.annotationType(declaration.childForFieldName('type')) ?? anyType;
      }
      default: {
        return this.c.silently(() => this.c.statements.declaredVariableType(symbol, declaration));
      }
    }
  }

  /** The properties a program adds to a function it declares, as `f.description = "..."` in the same block. */
  private expandoAssignments(declaration: TreeNode, name: string): [string, TreeNode][] {
    const block = declaration.parent;
    if (!block) return [];
    const assignments: [string, TreeNode][] = [];
    for (const statement of named(block)) {
      if (statement.type !== 'expression_statement') continue;
      const expression = named(statement)[0];
      if (expression?.type !== 'assignment_expression') continue;
      const left = expression.childForFieldName('left');
      const right = expression.childForFieldName('right');
      if (left?.type !== 'member_expression' || !right) continue;
      if (left.childForFieldName('object')?.text !== name) continue;
      const property = left.childForFieldName('property');
      if (property?.type === 'property_identifier') assignments.push([property.text, right]);
    }
    return assignments;
  }

  /** The type a binding pattern gives the name `name` when it destructures a value of `type`. */
  patternType(pattern: TreeNode, type: Type, name: string): Type {
    let result: Type = anyType;
    this.bindPattern(pattern, type, (identifier, identifierType) => {
      if (identifier.text === name) result = identifierType;
    });
    return result;
  }

  /** Destructures a value of `type` with a binding pattern, calling `bind` with each name and its type. */
  bindPattern(pattern: TreeNode, type: Type, bind: (identifier: TreeNode, type: Type) => void): void {
    switch (pattern.type) {
      case 'identifier':
      case 'shorthand_property_identifier_pattern': {
        bind(pattern, type);
        return;
      }
      case 'assignment_pattern':
      case 'object_assignment_pattern': {
        const left = pattern.childForFieldName('left') as TreeNode;
        const right = pattern.childForFieldName('right') as TreeNode;
        const defaultType = this.check(right, type);
        const withoutUndefined = this.c.relations.removeUndefined(type);
        this.bindPattern(left, this.c.widen(unionOf([withoutUndefined, regularOf(defaultType)])), bind);
        return;
      }
      case 'object_pattern': {
        this.bindObjectPattern(pattern, type, bind);
        return;
      }
      case 'array_pattern': {
        this.bindArrayPattern(pattern, type, bind);
        return;
      }
      default: {
        return;
      }
    }
  }

  private bindObjectPattern(pattern: TreeNode, type: Type, bind: (identifier: TreeNode, type: Type) => void): void {
    const used: string[] = [];
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier_pattern': {
          used.push(element.text);
          bind(element, this.destructuredProperty(element, type, element.text));
          break;
        }
        case 'object_assignment_pattern': {
          const left = element.childForFieldName('left') as TreeNode;
          used.push(left.text);
          const propertyType = this.destructuredProperty(left, type, left.text, true);
          this.bindPattern(element, propertyType, bind);
          break;
        }
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          const name = propertyNameText(key);
          if (name === undefined) {
            this.check(named(key)[0] ?? key);
            this.bindPattern(value, anyType, bind);
            break;
          }
          used.push(name);
          const optional = value.type === 'assignment_pattern';
          this.bindPattern(value, this.destructuredProperty(key, type, name, optional), bind);
          break;
        }
        case 'rest_pattern': {
          const target = named(element)[0];
          if (target) bind(target, this.restObject(type, used));
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private restObject(type: Type, omitted: string[]): Type {
    return anonymousObject(
      () => {
        const structure = emptyStructure();
        for (const [name, property] of this.c.structureOf(type).properties) {
          if (!omitted.includes(name) && !property.isMethod) structure.properties.set(name, property);
        }
        return structure;
      },
      { isLiteral: true }
    );
  }

  private destructuredProperty(node: TreeNode, type: Type, name: string, hasDefault = false): Type {
    if (isAnyLike(type)) return anyType;
    const property = this.c.propertyOf(type, name);
    if (!property) {
      const structure = this.c.structureOf(type);
      if (structure.stringIndex) return structure.stringIndex.type;
      this.c.error(node, `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。`);
      return errorType;
    }
    const propertyType = property.type();
    return property.optional && !hasDefault ? unionOf([propertyType, undefinedType]) : propertyType;
  }

  private bindArrayPattern(pattern: TreeNode, type: Type, bind: (identifier: TreeNode, type: Type) => void): void {
    let index = 0;
    for (const element of named(pattern)) {
      if (element.type === 'rest_pattern') {
        const target = named(element)[0];
        if (target) this.bindPattern(target, this.restOfIterable(type, index), bind);
        break;
      }
      this.bindPattern(element, this.elementAt(element, type, index), bind);
      index++;
    }
  }

  private elementAt(node: TreeNode, type: Type, index: number): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'object' && type.objectKind === 'tuple') {
      const elements = type.tuple?.elements ?? [];
      const element = elements[index];
      if (!element) {
        const rest = elements.find((member) => member.rest);
        if (rest) return unionOf([this.c.restElementType(rest.type), undefinedType]);
        this.c.error(
          node,
          `長さ ${elements.length} のタプル型 '${this.c.print(type)}' には、インデックス ${index} の要素がありません。`
        );
        return errorType;
      }
      if (element.rest) return this.c.restElementType(element.type);
      return element.optional ? unionOf([element.type, undefinedType]) : element.type;
    }
    return this.iteratedType(node, type);
  }

  private restOfIterable(type: Type, from: number): Type {
    if (type.kind === 'object' && type.objectKind === 'tuple') {
      return this.c.tupleType((type.tuple?.elements ?? []).slice(from));
    }
    return this.c.arrayType(this.c.silently(() => this.iteratedType(undefined, type)));
  }

  /** The type of the elements a `for...of` loop or a spread takes from a value. */
  iteratedType(node: TreeNode | undefined, type: Type): Type {
    if (isAnyLike(type)) return anyType;
    if (type.kind === 'union') return unionOf(type.types.map((member) => this.iteratedType(node, member)));
    if (type.kind === 'object' && this.c.isArrayOrTuple(type)) return this.c.elementTypeOf(type);
    if (
      isIntrinsic(type, 'string') ||
      (type.kind === 'literal' && typeof type.value === 'string') ||
      type.kind === 'templateLiteral'
    )
      return stringType;
    const iterator = this.c.propertyOf(type, '__@iterator');
    if (iterator) {
      const signature = this.c.signaturesOf(iterator.type(), 'call')[0];
      const iteratorType = signature?.returnType();
      if (iteratorType?.kind === 'object' && iteratorType.typeArguments?.[0]) return iteratorType.typeArguments[0];
    }
    if (type.kind === 'typeParameter') {
      const constraint = this.c.constraintOf(type);
      if (constraint) return this.iteratedType(node, constraint);
    }
    if (node)
      this.c.error(node, `型 '${this.c.print(type)}' には、反復処理に使う [Symbol.iterator]() メソッドがありません。`);
    return errorType;
  }

  // this ---------------------------------------------------------------------------------------------------------

  private thisExpression(node: TreeNode): Type {
    const type = this.c.classes.thisTypeOfExpression(node);
    const key = this.c.flow.referenceKey(node);
    const entry = key ? this.c.flow.entry(key) : undefined;
    return entry?.type ?? type;
  }

  // Literals -----------------------------------------------------------------------------------------------------

  private hasLiteralConstituent(type: Type, primitive: 'string' | 'number' | 'boolean'): boolean {
    const members = type.kind === 'union' ? type.types : [type];
    return members.some(
      (member) =>
        (member.kind === 'literal' && typeof member.value === primitive) ||
        member.kind === 'templateLiteral' ||
        (member.kind === 'typeParameter' && primitive === 'string')
    );
  }

  private arrayLiteral(node: TreeNode, contextual?: Type): Type {
    const elements = named(node);
    const tupleContext = contextual ? this.tupleContext(contextual) : undefined;
    const isConstContext = this.isConstContext(node);
    const elementContext = contextual ? this.elementContext(contextual) : undefined;
    const types: { type: Type; spread: boolean }[] = elements.map((element, index) => {
      if (element.type === 'spread_element') {
        const spread = this.check(named(element)[0]);
        return { type: spread, spread: true };
      }
      const context = tupleContext ? (this.tupleElementContext(tupleContext, index) ?? elementContext) : elementContext;
      const type = this.check(element, context);
      return { type: isConstContext ? type : this.widenForMutableLocation(type, context), spread: false };
    });
    if (tupleContext || isConstContext) {
      const tupleElements = types.flatMap(({ type, spread }, index) => {
        if (!spread) return [{ type: isConstContext ? regularOf(type) : type, optional: false, rest: false }];
        if (type.kind === 'object' && type.objectKind === 'tuple') return type.tuple?.elements ?? [];
        return [
          {
            type: this.c.arrayType(this.c.silently(() => this.iteratedType(elements[index], type))),
            optional: false,
            rest: true,
          },
        ];
      });
      return this.c.tupleType(tupleElements, isConstContext);
    }
    const elementTypes = types.map(({ type, spread }, index) =>
      spread ? this.iteratedType(named(elements[index])[0], type) : type
    );
    if (elementTypes.length === 0) return this.c.arrayType(neverType);
    return this.c.arrayType(unionOf(elementTypes, true));
  }

  private tupleContext(contextual: Type): ObjectType | undefined {
    const members = contextual.kind === 'union' ? contextual.types : [contextual];
    return members.find((member): member is ObjectType => member.kind === 'object' && member.objectKind === 'tuple');
  }

  private tupleElementContext(tuple: ObjectType, index: number): Type | undefined {
    const elements = tuple.tuple?.elements ?? [];
    const element = elements[index];
    if (element && !element.rest) return element.type;
    const rest = elements.find((member) => member.rest);
    return rest ? this.c.restElementType(rest.type) : undefined;
  }

  private elementContext(contextual: Type): Type | undefined {
    const members = (contextual.kind === 'union' ? contextual.types : [contextual]).filter(
      (member) => member.kind === 'object' && this.c.isArrayOrTuple(member)
    );
    if (members.length === 0) {
      if (contextual.kind === 'typeParameter') return undefined;
      return undefined;
    }
    return unionOf(members.map((member) => this.c.elementTypeOf(member as ObjectType)));
  }

  /** Whether an expression is in a `const` context, inside `as const`. */
  private isConstContext(node: TreeNode): boolean {
    let current: TreeNode | null = node.parent;
    let child: TreeNode = node;
    while (current) {
      if (current.type === 'as_expression')
        return current.children.some((part) => part?.type === 'const') && named(current)[0]?.id === child.id;
      if (current.type === 'type_assertion') return named(current)[0]?.text === 'const';
      if (
        !['parenthesized_expression', 'array', 'object', 'pair', 'spread_element', 'ternary_expression'].includes(
          current.type
        )
      )
        return false;
      child = current;
      current = current.parent;
    }
    return false;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of object literal member.
  private objectLiteral(node: TreeNode, contextual?: Type): Type {
    const isConstContext = this.isConstContext(node);
    const properties = new Map<string, Property>();
    let stringIndex: Type | undefined;
    const genericSpreads: Type[] = [];
    const contextFor = (name: string): Type | undefined => {
      if (!contextual) return undefined;
      return this.contextualPropertyType(contextual, name);
    };
    const object: ObjectType = anonymousObject(
      () => ({ ...emptyStructure(), properties, stringIndex: stringIndex && { type: stringIndex, readonly: false } }),
      {
        isLiteral: true,
      }
    );
    const seenKeys = new Set<string>();
    const checkDuplicate = (keyNode: TreeNode, name: string): void => {
      if (seenKeys.has(name))
        this.c.error(keyNode, `オブジェクトリテラルには、同じ名前のプロパティを2つ以上書けません。`);
      seenKeys.add(name);
    };
    for (const member of named(node)) {
      switch (member.type) {
        case 'pair': {
          const key = member.childForFieldName('key') as TreeNode;
          const value = member.childForFieldName('value') as TreeNode;
          const name = propertyNameText(key);
          if (name === undefined) {
            const keyType = this.check(named(key)[0] ?? key);
            const valueType = this.checkWidened(value);
            if (
              keyType.kind === 'literal' &&
              (typeof keyType.value === 'string' || typeof keyType.value === 'number')
            ) {
              const literalName = String(keyType.value);
              properties.set(literalName, this.literalProperty(literalName, valueType, isConstContext, member));
            } else {
              stringIndex = unionOf([stringIndex ?? neverType, valueType]);
            }
            break;
          }
          checkDuplicate(key, name);
          const context = contextFor(name);
          const checked = this.check(value, context);
          const valueType = isConstContext ? checked : this.widenForMutableLocation(checked, context);
          properties.set(name, this.literalProperty(name, valueType, isConstContext, member));
          break;
        }
        case 'shorthand_property_identifier': {
          checkDuplicate(member, member.text);
          const valueType = isConstContext
            ? this.identifier(member)
            : this.widenForMutableLocation(this.identifier(member), contextFor(member.text));
          properties.set(member.text, this.literalProperty(member.text, valueType, isConstContext, member));
          break;
        }
        case 'method_definition': {
          const nameNode = member.childForFieldName('name') as TreeNode;
          const name = propertyNameText(nameNode) ?? '';
          const isGetter = hasToken(member, 'get');
          const isSetter = hasToken(member, 'set');
          checkDuplicate(nameNode, isGetter ? `get ${name}` : isSetter ? `set ${name}` : name);
          const methodType = this.c.classes.withObjectThis(object, () =>
            this.functionExpression(member, contextFor(name))
          );
          if (isGetter || isSetter) {
            const signature = this.c.signaturesOf(methodType, 'call')[0];
            const existing = properties.get(name);
            const accessorType = isGetter
              ? (signature?.returnType() ?? anyType)
              : (signature?.parameters[0]?.type ?? anyType);
            properties.set(name, {
              ...this.literalProperty(name, existing && !isGetter ? existing.type() : accessorType, false, member),
              readonly: isGetter && !existing,
              getterOnly: isGetter && !existing,
            });
            if (existing && isSetter) properties.set(name, { ...existing, readonly: false, getterOnly: false });
            break;
          }
          properties.set(name, { ...this.literalProperty(name, methodType, false, member), isMethod: true });
          break;
        }
        case 'spread_element': {
          const spread = this.check(named(member)[0]);
          if (spread.kind === 'typeParameter') {
            genericSpreads.push(spread);
            break;
          }
          for (const [name, property] of this.spreadProperties(spread)) properties.set(name, property);
          break;
        }
        default: {
          break;
        }
      }
    }
    const fresh: ObjectType = { ...object, id: object.id, fresh: true, regular: object };
    if (genericSpreads.length > 0) return intersectionOf([...genericSpreads, object]);
    return fresh;
  }

  /** A literal's type in an array element or a property, widened unless the contextual type expects literals. */
  widenForMutableLocation(type: Type, contextual: Type | undefined): Type {
    if (contextual && this.expectsLiteral(contextual, type)) return type;
    return this.c.widenLiteral(type);
  }

  private expectsLiteral(contextual: Type, type: Type): boolean {
    const members = contextual.kind === 'union' ? contextual.types : [contextual];
    const literals = (type.kind === 'union' ? type.types : [type]).filter((member) => member.kind === 'literal');
    return members.some(
      (member) =>
        member.kind === 'typeParameter' ||
        member.kind === 'templateLiteral' ||
        member.kind === 'stringMapping' ||
        member.kind === 'keyof' ||
        member.kind === 'indexedAccess' ||
        (member.kind === 'literal' &&
          literals.some((literal) => typeof (literal as { value: unknown }).value === typeof member.value))
    );
  }

  /** The union of types without those that another of them already includes, as TypeScript's subtype reduction. */
  subtypeReduced(types: Type[]): Type {
    const union = unionOf(types, true);
    if (union.kind !== 'union') return union;
    const kept = union.types.filter(
      (member, index) =>
        !union.types.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.kind === 'object' &&
            member.kind === 'object' &&
            this.c.relations.isAssignable(member, other) &&
            !(this.c.relations.isAssignable(other, member) && otherIndex > index)
        )
    );
    return unionOf(kept, true);
  }

  private literalProperty(name: string, type: Type, readonly: boolean, declaration: TreeNode): Property {
    return {
      name,
      type: () => type,
      optional: false,
      readonly,
      isMethod: false,
      visibility: 'public',
      declaration,
    };
  }

  private spreadProperties(type: Type): Map<string, Property> {
    const result = new Map<string, Property>();
    for (const member of type.kind === 'union' ? type.types : [type]) {
      if (member.kind !== 'object' && member.kind !== 'intersection') continue;
      for (const [name, property] of this.c.structureOf(member).properties) {
        if (property.isMethod && member.kind === 'object' && member.classInfo) continue;
        result.set(name, { ...property, readonly: false });
      }
    }
    return result;
  }

  /** The type the contextual type gives a property of an object literal. */
  contextualPropertyType(contextual: Type, name: string): Type | undefined {
    const members = (contextual.kind === 'union' ? contextual.types : [contextual]).filter(
      (member) => member.kind === 'object' || member.kind === 'intersection' || member.kind === 'typeParameter'
    );
    const types: Type[] = [];
    for (const member of members) {
      const apparent = member.kind === 'typeParameter' ? (this.c.constraintOf(member) ?? unknownType) : member;
      const property = this.c.propertyOf(apparent, name);
      if (property) {
        types.push(property.type());
        continue;
      }
      const structure = this.c.structureOf(apparent);
      if (structure.stringIndex) types.push(structure.stringIndex.type);
      else if (/^\d+$/.test(name) && structure.numberIndex) types.push(structure.numberIndex.type);
    }
    return types.length > 0 ? unionOf(types, true) : undefined;
  }

  // Functions ----------------------------------------------------------------------------------------------------

  /** The contextual signature a function expression gets from its contextual type. */
  contextualSignature(contextual: Type | undefined): Signature | undefined {
    if (!contextual) return undefined;
    const members = (contextual.kind === 'union' ? contextual.types : [contextual]).filter(
      (member) => !isIntrinsic(member, 'undefined') && !isIntrinsic(member, 'null')
    );
    const signatures = members.flatMap((member) =>
      member.kind === 'object' || member.kind === 'intersection' || member.kind === 'typeParameter'
        ? this.c.signaturesOf(member, 'call')
        : []
    );
    if (signatures.length !== 1) return undefined;
    return signatures[0];
  }

  functionExpression(node: TreeNode, contextual?: Type): Type {
    const contextualSignature = isAnyLike(contextual ?? unknownType)
      ? this.anySignature()
      : this.contextualSignature(contextual);
    const signature = this.c.signatureOf(node, contextualSignature);
    // Parameters take their types from the signature, which the body sees.
    this.bindParameters(node, signature);
    const contextualReturn = contextualSignature ? contextualSignature.returnType() : undefined;
    const declaredReturn = this.declaredReturnType(node);
    let returnType: Type | undefined;
    const typed: Signature = {
      ...signature,
      returnType: () => {
        returnType ??= declaredReturn ?? this.checkFunctionBody(node, signature, contextualReturn, true);
        return returnType;
      },
    };
    if (!this.c.silent) this.c.statements.deferFunctionBody(node, signature, contextualReturn);
    return functionType(typed);
  }

  private anySignature(): Signature {
    return {
      typeParameters: [],
      parameters: [{ name: 'args', type: this.c.arrayType(anyType), optional: false, rest: true }],
      returnType: () => anyType,
    };
  }

  declaredReturnType(node: TreeNode): Type | undefined {
    const returnNode = node.childForFieldName('return_type');
    return returnNode ? this.c.annotationType(returnNode) : undefined;
  }

  /** Records the types of a function's parameters for its body. */
  bindParameters(node: TreeNode, signature: Signature): void {
    const scope = this.c.ownScope(node);
    if (!scope) return;
    const parametersNode = node.childForFieldName('parameters');
    const parameterNodes = parametersNode
      ? named(parametersNode).filter(
          (parameter) => (parameter.childForFieldName('pattern') ?? parameter).type !== 'this'
        )
      : [];
    const single = node.childForFieldName('parameter');
    if (single) parameterNodes.push(single);
    for (const [index, parameterNode] of parameterNodes.entries()) {
      const parameter = signature.parameters[index];
      if (!parameter) continue;
      const pattern = parameterNode.childForFieldName('pattern') ?? parameterNode;
      const type =
        parameter.optional && !parameterNode.childForFieldName('value')
          ? unionOf([parameter.type, undefinedType])
          : parameter.type;
      if (pattern.type === 'identifier') {
        const symbol = scope.values.get(pattern.text);
        if (symbol) this.parameterTypes.set(symbol.id, type);
      } else if (pattern.type === 'rest_pattern') {
        const target = named(pattern)[0];
        const symbol = target ? scope.values.get(target.text) : undefined;
        if (symbol) this.parameterTypes.set(symbol.id, type);
      } else {
        this.c.silently(() =>
          this.bindPattern(pattern, type, (identifier, identifierType) => {
            const symbol = scope.values.get(identifier.text);
            if (symbol) this.parameterTypes.set(symbol.id, identifierType);
          })
        );
      }
    }
  }

  /** The return type of a function without an annotation, from checking its body silently. */
  inferredReturnType(node: TreeNode, signature: Signature): Type {
    const cached = this.inferredReturns.get(node.id);
    if (cached) return cached;
    if (this.inferring.has(node.id)) {
      const name = node.childForFieldName('name');
      this.c.error(
        name ?? node,
        `${name?.text ?? 'この関数'} は、戻り値の式で自分自身を参照しているため、戻り値の型が暗黙に any になります。`
      );
      return anyType;
    }
    this.inferring.add(node.id);
    try {
      this.bindParameters(node, signature);
      const type = this.c.silently(() => this.checkFunctionBody(node, signature, undefined, true));
      this.inferredReturns.set(node.id, type);
      return type;
    } finally {
      this.inferring.delete(node.id);
    }
  }

  /**
   * Checks a function's body from a fresh flow, returning the type it returns.
   *
   * @param isolated Whether to check without the enclosing flow, as when inferring the return type ahead.
   */
  checkFunctionBody(node: TreeNode, signature: Signature, contextualReturn: Type | undefined, isolated: boolean): Type {
    void isolated;
    const body = node.childForFieldName('body');
    const declaredReturn = this.declaredReturnType(node);
    const context: FunctionContext = {
      node,
      returnTypes: [],
      endReachable: true,
      declaredReturn,
      keepsLiterals:
        (declaredReturn ?? contextualReturn) !== undefined && this.hasLiterals(declaredReturn ?? contextualReturn),
      isConstructor: node.type === 'method_definition' && node.childForFieldName('name')?.text === 'constructor',
      hasReturnWithValue: false,
      hasReturn: false,
      returnStates: [],
      contextualReturn,
    };
    this.bindParameters(node, signature);
    this.functions.push(context);
    this.capturedTypes.push(this.capture());
    const outer = this.c.flow.current;
    this.c.flow.current = this.c.classes.initialFlow(node);
    try {
      if (!body) return anyType;
      if (body.type === 'statement_block') {
        this.c.statements.checkBlockStatements(named(body));
        context.endReachable = this.c.flow.isReachable;
      } else {
        const expressionType = this.check(body, declaredReturn ?? contextualReturn);
        if (declaredReturn) this.checkReturnValue(body, expressionType, declaredReturn);
        context.returnTypes.push(expressionType);
        context.endReachable = false;
        context.hasReturnWithValue = true;
      }
      if (declaredReturn) this.c.statements.checkMissingReturn(node, context, declaredReturn);
      if (context.isConstructor && node.parent?.parent) {
        this.c.classes.checkPropertyInitialization(node.parent.parent, node, this.c.flow.current, context.returnStates);
      }
      return this.returnTypeOf(context);
    } finally {
      this.c.flow.current = outer;
      this.functions.pop();
      this.capturedTypes.pop();
    }
  }

  /** The narrowed types of the variables visible now, which a function created here sees if nothing reassigns them. */
  private capture(): Map<string, Type> {
    const outer = this.capturedTypes.at(-1);
    const captured = outer ? new Map(outer) : new Map<string, Type>();
    for (const [key, entry] of this.c.flow.current?.entries ?? []) {
      if (key.startsWith('s') && !key.includes('.') && entry.assigned) captured.set(key, entry.type);
    }
    return captured;
  }

  private hasLiterals(type: Type | undefined): boolean {
    if (!type) return false;
    return (type.kind === 'union' ? type.types : [type]).some(
      (member) => member.kind === 'literal' || member.kind === 'typeParameter'
    );
  }

  private returnTypeOf(context: FunctionContext): Type {
    if (context.declaredReturn) return context.declaredReturn;
    const types = context.returnTypes.map((type) => (context.keepsLiterals ? type : this.c.widenLiteral(type)));
    if (types.length === 0) return voidType;
    if (context.endReachable && context.hasReturnWithValue) types.push(undefinedType);
    if (!context.hasReturnWithValue) return voidType;
    return unionOf(types.map((type) => this.widenObjectLiteral(type)));
  }

  private widenObjectLiteral(type: Type): Type {
    return this.widenDeclared(type, true);
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

  reportNotAssignable(node: TreeNode, source: Type, target: Type): void {
    this.c.error(
      node,
      `型 '${this.c.print(this.c.widenLiteralForMessage(source, target))}' を型 '${this.c.print(target)}' に代入することはできません。${this.elaborate(source, target)}`
    );
  }

  /** A hint about why a source is not assignable to a target, as TypeScript's second line gives it. */
  private elaborate(source: Type, target: Type): string {
    if (source.kind !== 'object' || target.kind !== 'object' || this.c.isArrayOrTuple(target)) return '';
    const sourceStructure = this.c.structureOf(source);
    const missing = [...target.resolve().properties.values()].filter(
      (property) =>
        !property.optional &&
        !sourceStructure.properties.has(property.name) &&
        !this.c.propertyOf(source, property.name)
    );
    if (missing.length === 1) return `プロパティ '${missing[0].name}' がありません。`;
    if (missing.length > 1)
      return `プロパティ ${missing
        .slice(0, 4)
        .map((property) => `'${property.name}'`)
        .join(', ')} がありません。`;
    return '';
  }

  /** Reports the properties of a fresh object literal that its target does not declare. */
  checkExcessProperties(node: TreeNode, source: Type, target: Type): void {
    if (source.kind !== 'object' || !source.fresh) return;
    const targets = (target.kind === 'union' ? target.types : [target]).filter(
      (member) => member.kind === 'object' || member.kind === 'intersection'
    );
    if (targets.length === 0) return;
    if (
      targets.some(
        (member) =>
          member.kind === 'object' && (this.c.relations.isEmptyObjectType(member) || member.objectKind === 'mapped')
      )
    )
      return;
    if (targets.some((member) => this.c.structureOf(member).stringIndex)) return;
    // A discriminated union checks the members its discriminant selects.
    const structure = source.resolve();
    for (const [name, property] of structure.properties) {
      const known = targets.some(
        (member) => this.c.propertyOf(member, name) !== undefined && !this.isObjectPrototypeProperty(member, name)
      );
      if (known) {
        const declaration = property.declaration;
        if (declaration?.type === 'pair') {
          const value = declaration.childForFieldName('value');
          const valueType = property.type();
          const targetType = this.contextualPropertyType(target, name);
          if (value && targetType && valueType.kind === 'object' && valueType.fresh)
            this.checkExcessProperties(value, valueType, targetType);
        }
        continue;
      }
      if (/^\d+$/.test(name) && targets.some((member) => this.c.structureOf(member).numberIndex)) continue;
      this.c.error(
        property.declaration?.childForFieldName('key') ?? property.declaration ?? node,
        `オブジェクトリテラルには既知のプロパティしか書けません。'${name}' は型 '${this.c.print(target)}' にありません。`
      );
      return;
    }
  }

  private isObjectPrototypeProperty(member: Type, name: string): boolean {
    return (
      !this.c.structureOf(member).properties.has(name) && this.c.globalType('Object').resolve().properties.has(name)
    );
  }

  /** Checks that `type` can be assigned to `target`, reporting at `node`. */
  checkAssignable(node: TreeNode, type: Type, target: Type): boolean {
    if (!this.c.relations.isAssignable(type, target)) {
      this.reportNotAssignable(node, type, target);
      return false;
    }
    this.checkExcessProperties(node, type, target);
    return true;
  }

  /** The type a variable declared with this initializer type gets. */
  widenDeclared(type: Type, isConst: boolean): Type {
    if (type.kind === 'literal') return isConst ? regularOf(type) : this.c.widenLiteral(type);
    if (type.kind === 'union') {
      const widened = isConst ? regularOf(type) : this.c.widenLiteral(type);
      return widened.kind === 'union'
        ? unionOf(widened.types.map((member) => this.widenDeclared(member, false)))
        : widened;
    }
    if (type.kind === 'object') {
      if (this.c.isArrayType(type)) {
        const element = this.c.elementTypeOf(type);
        const widened = this.widenDeclared(element, false);
        return widened === element ? type : this.c.arrayType(widened);
      }
      if (type.objectKind === 'anonymous' && type.isLiteral && !type.isFunction) {
        const source = type.regular ?? type;
        return anonymousObject(
          () => {
            const structure = source.resolve();
            const properties = new Map<string, Property>();
            for (const [name, property] of structure.properties) {
              properties.set(name, {
                ...property,
                type: () =>
                  property.readonly && !property.getterOnly
                    ? regularOf(property.type())
                    : this.widenDeclared(property.type(), false),
              });
            }
            return { ...structure, properties };
          },
          { isLiteral: true }
        );
      }
    }
    return regularOf(type);
  }

  // Member access ------------------------------------------------------------------------------------------------

  private memberAccess(node: TreeNode): Type {
    const objectNode = node.childForFieldName('object') as TreeNode;
    const propertyNode = node.childForFieldName('property') as TreeNode;
    const optional = node.childForFieldName('optional_chain') !== null;
    const name = propertyNode.text;
    if (objectNode.type === 'super') return this.c.classes.superProperty(node, propertyNode);
    let objectType = this.check(objectNode);
    const key = this.c.flow.referenceKey(node);
    if (optional) {
      if (isAnyLike(objectType)) return anyType;
      const nonNull = this.c.relations.removeNullish(objectType);
      const propertyType = this.propertyAccess(node, objectNode, propertyNode, nonNull, name);
      return this.c.relations.isNullable(objectType) || this.isInOptionalChain(objectNode)
        ? unionOf([propertyType, undefinedType])
        : propertyType;
    }
    objectType = this.checkNonNullable(objectNode, objectType);
    const propertyType = this.propertyAccess(node, objectNode, propertyNode, objectType, name);
    if (key) {
      const entry = this.c.flow.entry(key);
      if (entry && !this.isAssignmentTarget(node)) return entry.type;
    }
    return propertyType;
  }

  /** For `a?.b` called as `a?.b()`, the type of `b` itself, which the call reaches only when `a` is not nullish. */
  chainedCalleeType(callee: TreeNode): Type | undefined {
    if (callee.type !== 'member_expression' || !this.isInOptionalChain(callee)) return undefined;
    const objectNode = callee.childForFieldName('object') as TreeNode;
    const propertyNode = callee.childForFieldName('property') as TreeNode;
    const objectType = this.check(objectNode);
    if (isAnyLike(objectType)) return anyType;
    const nonNull =
      callee.childForFieldName('optional_chain') || this.isInOptionalChain(objectNode)
        ? this.c.relations.removeNullish(objectType)
        : this.checkNonNullable(objectNode, objectType);
    return this.propertyAccess(callee, objectNode, propertyNode, nonNull, propertyNode.text);
  }

  private isInOptionalChain(node: TreeNode): boolean {
    let current = skipParentheses(node);
    while (
      current.type === 'member_expression' ||
      current.type === 'call_expression' ||
      current.type === 'subscript_expression'
    ) {
      if (current.childForFieldName('optional_chain')) return true;
      current = current.childForFieldName(current.type === 'call_expression' ? 'function' : 'object') as TreeNode;
    }
    return false;
  }

  /** Reports an object that may be `null`, `undefined`, or `unknown` where a member is used, returning the rest. */
  checkNonNullable(node: TreeNode, type: Type): Type {
    if (isIntrinsic(type, 'unknown')) {
      this.c.error(
        node,
        this.isEntityName(node) ? `'${node.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
      return errorType;
    }
    if (isAnyLike(type)) return type;
    const members = type.kind === 'union' ? type.types : [type];
    const hasNull = members.some((member) => isIntrinsic(member, 'null'));
    const hasUndefined = members.some((member) => isIntrinsic(member, 'undefined') || isIntrinsic(member, 'void'));
    if (!hasNull && !hasUndefined) return type;
    const rest = this.c.relations.removeNullish(type);
    const literal = skipParentheses(node).type;
    if (isIntrinsic(rest, 'never') && (literal === 'null' || literal === 'undefined')) {
      this.c.error(node, `値 '${hasNull ? 'null' : 'undefined'}' はここでは使えません。`);
      return errorType;
    }
    const what = hasNull && hasUndefined ? "'null' か 'undefined'" : hasNull ? "'null'" : "'undefined'";
    this.c.error(
      node,
      this.isEntityName(node)
        ? `'${node.text}' は ${what} の可能性があります。`
        : `オブジェクトは ${what} の可能性があります。`
    );
    // Nothing is left to use when the value can only be `null` or `undefined`.
    return isIntrinsic(rest, 'never') ? errorType : rest;
  }

  private isEntityName(node: TreeNode): boolean {
    const expression = skipParentheses(node);
    if (expression.type === 'identifier' || expression.type === 'this') return true;
    if (expression.type === 'member_expression') {
      const object = expression.childForFieldName('object');
      return !!object && !expression.childForFieldName('optional_chain') && this.isEntityName(object);
    }
    return false;
  }

  /** The type of `object.name`, reporting a missing or inaccessible property. */
  propertyAccess(node: TreeNode, objectNode: TreeNode, propertyNode: TreeNode, objectType: Type, name: string): Type {
    if (isAnyLike(objectType)) return objectType;
    if (propertyNode.type === 'private_property_identifier')
      return this.c.classes.privateNameAccess(node, propertyNode, objectType);
    if (objectType.kind === 'union') {
      const types: Type[] = [];
      for (const member of objectType.types) {
        const property = this.c.propertyOf(member, name);
        if (!property) {
          const index = this.indexSignatureFor(member, name);
          if (index) {
            types.push(index);
            continue;
          }
          this.reportMissingProperty(propertyNode, name, objectType);
          return errorType;
        }
        types.push(property.optional ? unionOf([property.type(), undefinedType]) : property.type());
      }
      return unionOf(types, true);
    }
    const property = this.c.propertyOf(objectType, name);
    if (!property) {
      const index = this.indexSignatureFor(objectType, name);
      if (index) return index;
      this.reportMissingProperty(propertyNode, name, objectType);
      return errorType;
    }
    this.c.classes.checkPropertyAccessibility(node, propertyNode, objectNode, objectType, property);
    const unsupported = this.unsupportedMember(objectType, name) ?? this.unsupportedLibraryMember(property);
    if (unsupported) this.c.error(propertyNode, unsupportedMessage(unsupported));
    const type = property.type();
    return property.optional ? unionOf([type, undefinedType]) : type;
  }

  /** A library member of every error or regular expression that this interpreter does not provide. */
  private unsupportedLibraryMember(property: Property): string | undefined {
    const declaration = property.declaration;
    if (!declaration || !this.c.isLibrary(declaration)) return undefined;
    const owner = declaration.parent?.parent?.childForFieldName('name')?.text;
    // A stack trace names the files and lines of the host, which differ from the program's.
    if (owner === 'Error' && property.name === 'stack') return 'Error の stack';
    if (owner === 'RegExp' && property.name === 'compile') return 'RegExp の compile';
    return undefined;
  }

  private unsupportedMember(objectType: Type, name: string): string | undefined {
    if (objectType.kind !== 'object') return undefined;
    // The interpreter leaves out Math.random so that a program always draws the same board.
    if (objectType.name === 'Math' && name === 'random') return 'Math.random';
    // The well-known symbols replace the protocols of the language, which this interpreter does not support yet.
    if (objectType.name === 'SymbolConstructor' && wellKnownSymbols.has(name))
      return `Symbol.${name} などの well-known シンボル`;
    // Timers print how long they took, which differs on every run.
    if (objectType.name === 'Console' && ['time', 'timeEnd', 'timeLog', 'timeStamp'].includes(name))
      return `console.${name}`;
    return undefined;
  }

  private indexSignatureFor(type: Type, name: string): Type | undefined {
    const structure = this.c.structureOf(type);
    if (structure.stringIndex) return structure.stringIndex.type;
    if (/^\d+$/.test(name) && structure.numberIndex) return structure.numberIndex.type;
    return undefined;
  }

  private reportMissingProperty(node: TreeNode, name: string, type: Type): void {
    const apparent = this.c.apparentType(type);
    const classInfo = apparent.kind === 'object' ? (apparent.classInfo ?? apparent.target?.classInfo) : undefined;
    if (
      classInfo &&
      apparent.kind === 'object' &&
      !apparent.isClassStatic &&
      classInfo.staticType.resolve().properties.has(name)
    ) {
      this.c.error(
        node,
        `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。静的メンバー '${classInfo.name}.${name}' のことですか？`
      );
      return;
    }
    const suggestion = this.suggestProperty(type, name);
    this.c.error(
      node,
      `プロパティ '${name}' は型 '${this.c.print(type)}' にありません。${suggestion ? `'${suggestion}' のことですか？` : ''}`
    );
  }

  private suggestProperty(type: Type, name: string): string | undefined {
    const candidates = (type.kind === 'union' ? [] : [...this.c.structureOf(type).properties.keys()]).filter(
      (candidate) => !candidate.startsWith('__')
    );
    let best: string | undefined;
    let bestDistance = Math.max(2, Math.floor(name.length * 0.34));
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - name.length) > bestDistance) continue;
      const distance = editDistance(candidate.toLowerCase(), name.toLowerCase());
      if (candidate.toLowerCase() === name.toLowerCase() || distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  private elementAccess(node: TreeNode): Type {
    const objectNode = node.childForFieldName('object') as TreeNode;
    const indexNode = node.childForFieldName('index') as TreeNode;
    const optional = node.childForFieldName('optional_chain') !== null;
    let objectType = this.check(objectNode);
    const indexType = this.check(indexNode);
    objectType = optional ? this.c.relations.removeNullish(objectType) : this.checkNonNullable(objectNode, objectType);
    const key = this.c.flow.referenceKey(node);
    const entry = key ? this.c.flow.entry(key) : undefined;
    if (entry && !this.isAssignmentTarget(node)) return entry.type;
    const result = this.indexedType(node, objectNode, indexNode, objectType, indexType);
    return optional ? unionOf([result, undefinedType]) : result;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Follows TypeScript's rules for each kind of index.
  indexedType(node: TreeNode, objectNode: TreeNode, indexNode: TreeNode, objectType: Type, indexType: Type): Type {
    if (isAnyLike(objectType)) return anyType;
    const index = regularOf(indexType);
    if (index.kind === 'typeParameter' || index.kind === 'keyof' || objectType.kind === 'typeParameter') {
      return this.c.indexedAccess(objectType, index);
    }
    if (index.kind === 'literal' && (typeof index.value === 'string' || typeof index.value === 'number')) {
      const name = String(index.value);
      if (objectType.kind === 'object' && objectType.objectKind === 'tuple' && typeof index.value === 'number') {
        const elements = objectType.tuple?.elements ?? [];
        if (index.value >= elements.length && !elements.some((element) => element.rest)) {
          this.c.error(
            indexNode,
            `長さ ${elements.length} のタプル型 '${this.c.print(objectType)}' には、インデックス ${name} の要素がありません。`
          );
          return errorType;
        }
      }
      const property = objectType.kind === 'union' ? undefined : this.c.propertyOf(objectType, name);
      if (property) {
        this.c.classes.checkPropertyAccessibility(node, indexNode, objectNode, objectType, property);
        return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      }
      if (objectType.kind === 'union') {
        return unionOf(
          objectType.types.map((member) => this.indexedType(node, objectNode, indexNode, member, indexType))
        );
      }
    }
    if (isAnyLike(index)) {
      const structure = this.c.structureOf(objectType);
      if (structure.numberIndex) return structure.numberIndex.type;
      if (structure.stringIndex) return structure.stringIndex.type;
      return anyType;
    }
    const isNumeric = this.c.relations.isAssignable(index, numberType);
    const isStringy = this.c.relations.isAssignable(index, stringType);
    if (
      !isNumeric &&
      !isStringy &&
      !this.c.relations.isAssignable(index, this.c.globalType('Symbol')) &&
      !isIntrinsic(index, 'symbol')
    ) {
      this.c.error(indexNode, `型 '${this.c.print(index)}' はインデックスに使えません。`);
      return errorType;
    }
    if (objectType.kind === 'union') {
      return unionOf(
        objectType.types.map((member) => this.indexedType(node, objectNode, indexNode, member, indexType))
      );
    }
    const structure = this.c.structureOf(objectType);
    if (isNumeric && structure.numberIndex) return structure.numberIndex.type;
    if ((isNumeric || isStringy) && structure.stringIndex) return structure.stringIndex.type;
    if (index.kind === 'union' && index.types.every((member) => member.kind === 'literal')) {
      return unionOf(index.types.map((member) => this.indexedType(node, objectNode, indexNode, objectType, member)));
    }
    if (objectType.kind === 'indexedAccess') return this.c.indexedAccess(objectType, index);
    if (index.kind === 'literal') {
      this.c.error(
        node,
        `型 '${this.c.print(index)}' の式は型 '${this.c.print(objectType)}' のインデックスに使えないため、要素の型が暗黙に any になります。プロパティ '${String(index.value)}' は型 '${this.c.print(objectType)}' にありません。`
      );
      return errorType;
    }
    this.c.error(
      node,
      `型 '${this.c.print(index)}' の式は型 '${this.c.print(objectType)}' のインデックスに使えないため、要素の型が暗黙に any になります。`
    );
    return errorType;
  }

  // Assignments --------------------------------------------------------------------------------------------------

  /** The declared type of an assignment target, reporting a constant or a read-only property. */
  private targetType(target: TreeNode, compound: boolean): Type {
    const expression = skipParentheses(target);
    switch (expression.type) {
      case 'identifier': {
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
        if (compound) return this.identifier(expression);
        this.checkUsedBeforeDeclaration(expression, symbol);
        return this.valueTypeOf(symbol);
      }
      case 'member_expression': {
        const objectNode = expression.childForFieldName('object') as TreeNode;
        const propertyNode = expression.childForFieldName('property') as TreeNode;
        if (expression.childForFieldName('optional_chain')) {
          this.c.error(expression, 'オプショナルチェーン ?. を含む式には代入できません。');
          return errorType;
        }
        const objectType = this.checkNonNullable(objectNode, this.check(objectNode));
        const property =
          isAnyLike(objectType) || objectType.kind === 'union'
            ? undefined
            : this.c.propertyOf(objectType, propertyNode.text);
        if (property && this.c.classes.isReadonlyFor(property, expression, objectNode)) {
          this.c.error(propertyNode, `${propertyNode.text} は読み取り専用のプロパティなので、代入できません。`);
          return errorType;
        }
        if (property?.getterOnly) {
          this.c.error(propertyNode, `${propertyNode.text} はゲッターだけのプロパティなので、代入できません。`);
          return errorType;
        }
        const type = this.propertyAccess(expression, objectNode, propertyNode, objectType, propertyNode.text);
        if (compound) {
          const key = this.c.flow.referenceKey(expression);
          const entry = key ? this.c.flow.entry(key) : undefined;
          if (entry) return entry.type;
        }
        return property?.optional && !compound ? unionOf([property.type(), undefinedType]) : type;
      }
      case 'subscript_expression': {
        const objectNode = expression.childForFieldName('object') as TreeNode;
        const indexNode = expression.childForFieldName('index') as TreeNode;
        const objectType = this.checkNonNullable(objectNode, this.check(objectNode));
        const indexType = this.check(indexNode);
        if (
          objectType.kind === 'object' &&
          (this.c.isReadonlyArrayType(objectType) || (objectType.objectKind === 'tuple' && objectType.tuple?.readonly))
        ) {
          this.c.error(expression, `型 '${this.c.print(objectType)}' のインデックスは読み取り専用です。`);
          return errorType;
        }
        if (indexType.kind === 'literal' && typeof indexType.value === 'string') {
          const property = this.c.propertyOf(objectType, indexType.value);
          if (property && this.c.classes.isReadonlyFor(property, expression, objectNode)) {
            this.c.error(indexNode, `${indexType.value} は読み取り専用のプロパティなので、代入できません。`);
            return errorType;
          }
        }
        const structure = isAnyLike(objectType) ? undefined : this.c.structureOf(objectType);
        if (structure?.stringIndex?.readonly && !this.c.relations.isAssignable(indexType, numberType)) {
          this.c.error(expression, `型 '${this.c.print(objectType)}' のインデックスは読み取り専用です。`);
          return errorType;
        }
        if (structure?.numberIndex?.readonly && this.c.relations.isAssignable(indexType, numberType)) {
          this.c.error(expression, `型 '${this.c.print(objectType)}' のインデックスは読み取り専用です。`);
          return errorType;
        }
        return this.indexedType(expression, objectNode, indexNode, objectType, indexType);
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

  private assignment(node: TreeNode): Type {
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    const leftExpression = skipParentheses(left);
    if (
      leftExpression.type === 'object_pattern' ||
      leftExpression.type === 'array_pattern' ||
      leftExpression.type === 'object' ||
      leftExpression.type === 'array'
    ) {
      const valueType = this.check(right);
      this.destructuringAssignment(leftExpression, valueType);
      return valueType;
    }
    if (this.isEvolvingArrayAssignment(leftExpression)) {
      const valueType = this.checkWidened(right);
      this.evolve(leftExpression.childForFieldName('object') as TreeNode, valueType);
      this.check(leftExpression.childForFieldName('index') as TreeNode);
      return valueType;
    }
    const targetType = this.targetType(left, false);
    const valueType = this.check(right, targetType === errorType ? undefined : targetType);
    if (targetType !== errorType) this.checkAssignable(leftExpression, valueType, targetType);
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
    if (/^this\d+\.[^.]+$/.test(key)) this.c.flow.current?.assignedFields.add(key);
    if (declared === errorType) return;
    const entry = this.c.flow.entry(key);
    const symbol = target.type === 'identifier' ? this.c.scopeOf(target).lookupValue(target.text) : undefined;
    const isAuto = symbol !== undefined && this.isAutoTyped(symbol);
    const type = isAuto ? this.c.widen(assigned) : this.c.flow.assignmentReduced(declared, regularOf(assigned));
    this.c.flow.set(key, { type, assigned: true, evolving: entry?.evolving });
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

  private destructuringAssignment(pattern: TreeNode, type: Type): void {
    const assign = (target: TreeNode, valueType: Type): void => {
      const declared = this.targetType(target, false);
      if (declared !== errorType && !this.c.relations.isAssignable(valueType, declared))
        this.reportNotAssignable(target, valueType, declared);
      this.assignReference(skipParentheses(target), declared, valueType);
    };
    if (pattern.type === 'array' || pattern.type === 'array_pattern') {
      let index = 0;
      for (const element of named(pattern)) {
        if (element.type === 'spread_element' || element.type === 'rest_pattern') {
          assign(named(element)[0], this.restOfIterable(type, index));
          break;
        }
        const elementType = this.elementAt(element, type, index);
        if (element.type === 'assignment_expression' || element.type === 'assignment_pattern') {
          const left = element.childForFieldName('left') as TreeNode;
          const right = element.childForFieldName('right') as TreeNode;
          this.check(right);
          assign(left, this.c.relations.removeUndefined(elementType));
        } else if (['array', 'object', 'array_pattern', 'object_pattern'].includes(element.type)) {
          this.destructuringAssignment(element, elementType);
        } else {
          assign(element, elementType);
        }
        index++;
      }
      return;
    }
    for (const element of named(pattern)) {
      switch (element.type) {
        case 'shorthand_property_identifier':
        case 'shorthand_property_identifier_pattern': {
          assign(element, this.destructuredProperty(element, type, element.text));
          break;
        }
        case 'pair':
        case 'pair_pattern': {
          const key = element.childForFieldName('key') as TreeNode;
          const value = element.childForFieldName('value') as TreeNode;
          const name = propertyNameText(key) ?? '';
          const propertyType = this.destructuredProperty(key, type, name);
          if (['array', 'object', 'array_pattern', 'object_pattern'].includes(value.type))
            this.destructuringAssignment(value, propertyType);
          else assign(value, propertyType);
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private compoundAssignment(node: TreeNode): Type {
    const left = node.childForFieldName('left') as TreeNode;
    const right = node.childForFieldName('right') as TreeNode;
    const operator = node.childForFieldName('operator')?.text ?? '+=';
    const targetType = this.targetType(left, true);
    if (operator === '&&=' || operator === '||=' || operator === '??=') {
      const valueType = this.check(right, targetType);
      if (targetType !== errorType)
        this.checkAssignable(skipParentheses(left), valueType, this.declaredTargetType(left));
      const kept =
        operator === '??='
          ? this.c.relations.removeNullish(targetType)
          : operator === '||='
            ? this.c.flow.narrowByTruthiness(targetType, true)
            : targetType;
      return this.subtypeReduced([kept, valueType]);
    }
    const valueType = this.check(right);
    const resultType = this.binaryOperatorType(node, operator.slice(0, -1), left, right, targetType, valueType);
    const declared = this.declaredTargetType(left);
    if (targetType !== errorType && resultType !== errorType)
      this.checkAssignable(skipParentheses(left), resultType, declared);
    this.assignReference(skipParentheses(left), declared, resultType);
    return resultType;
  }

  private declaredTargetType(left: TreeNode): Type {
    return this.c.silently(() => this.targetType(left, false));
  }

  private update(node: TreeNode): Type {
    const argument = node.childForFieldName('argument') as TreeNode;
    const type = this.targetType(argument, true);
    if (type === errorType) return numberType;
    if (
      !this.isNumberLike(type) &&
      !isIntrinsic(regularOf(type), 'bigint') &&
      !(type.kind === 'literal' && typeof type.value === 'bigint')
    ) {
      const nonNull = this.c.relations.removeNullish(type);
      if (this.isNumberLike(nonNull) && nonNull !== type) this.checkNonNullable(argument, type);
      else this.c.error(argument, '++ や -- を使える値は、number 型、bigint 型、any 型のものだけです。');
      return numberType;
    }
    const result = this.isBigintLike(type) ? bigintType : numberType;
    this.assignReference(skipParentheses(argument), this.declaredTargetType(argument), result);
    return result;
  }

  // Operators ----------------------------------------------------------------------------------------------------

  private unary(node: TreeNode): Type {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const argument = node.childForFieldName('argument') as TreeNode;
    switch (operator) {
      case '!': {
        this.checkCondition(argument);
        return booleanType;
      }
      case 'typeof': {
        this.c.silently(() => this.check(argument));
        if (argument.type !== 'identifier' || this.c.scopeOf(argument).lookupValue(argument.text)) this.check(argument);
        return typeofResult;
      }
      case 'void': {
        this.check(argument);
        return undefinedType;
      }
      case 'delete': {
        this.checkDelete(argument);
        return booleanType;
      }
      case '-':
      case '+':
      case '~': {
        const type = this.check(argument);
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
        if (!isAnyLike(type) && this.c.relations.isNullable(type)) this.checkNonNullable(argument, type);
        return this.isBigintLike(type) ? bigintType : numberType;
      }
      default: {
        this.check(argument);
        return anyType;
      }
    }
  }

  private checkDelete(argument: TreeNode): void {
    const expression = skipParentheses(argument);
    this.check(expression);
    if (expression.type !== 'member_expression' && expression.type !== 'subscript_expression') {
      this.c.error(argument, 'delete 演算子のオペランドは、プロパティへの参照でなければいけません。');
      return;
    }
    const objectNode = expression.childForFieldName('object') as TreeNode;
    const objectType = this.c.silently(() => this.check(objectNode));
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

  private binary(node: TreeNode, contextual?: Type): Type {
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
    const leftType = this.check(left);
    const rightType = this.check(right);
    return this.binaryOperatorType(node, operator, left, right, leftType, rightType);
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- One rule per group of operators, as TypeScript has.
  private binaryOperatorType(
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
        this.checkNonNullable(operand, type);
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
      const leftType = this.check(left, contextual);
      const rightType = this.check(right, contextual);
      return this.subtypeReduced([this.c.relations.removeNullish(leftType), rightType]);
    }
    const { whenTrue, whenFalse, type: leftType } = this.condition(left);
    const rightState = operator === '&&' ? whenTrue : whenFalse;
    let rightType: Type = neverType;
    const after = this.c.flow.from(rightState, () => {
      rightType = this.check(right, contextual ?? leftType);
    });
    this.c.flow.current = this.c.flow.merge([operator === '&&' ? whenFalse : whenTrue, after]);
    void node;
    if (operator === '&&') return unionOf([this.c.flow.narrowByTruthiness(leftType, false), rightType], true);
    return this.subtypeReduced([this.c.flow.narrowByTruthiness(leftType, true), rightType]);
  }

  private instanceofExpression(left: TreeNode, right: TreeNode): Type {
    const leftType = this.check(left);
    const rightType = this.check(right);
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

  private inExpression(left: TreeNode, right: TreeNode): Type {
    const leftType = left.type === 'private_property_identifier' ? stringType : this.check(left);
    const rightType = this.check(right);
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
        this.checkNonNullable(right, r);
      else this.c.error(right, 'in の右辺は、プリミティブ型であってはいけません。');
    } else if (isIntrinsic(r, 'unknown')) {
      this.c.error(
        right,
        this.isEntityName(right) ? `'${right.text}' の型は 'unknown' です。` : "オブジェクトの型は 'unknown' です。"
      );
    }
    return booleanType;
  }

  private ternary(node: TreeNode, contextual?: Type): Type {
    const condition = node.childForFieldName('condition') as TreeNode;
    const consequence = node.childForFieldName('consequence') as TreeNode;
    const alternative = node.childForFieldName('alternative') as TreeNode;
    const { whenTrue, whenFalse } = this.condition(condition);
    let trueType: Type = neverType;
    let falseType: Type = neverType;
    const afterTrue = this.c.flow.from(whenTrue, () => {
      trueType = this.check(consequence, contextual);
    });
    const afterFalse = this.c.flow.from(whenFalse, () => {
      falseType = this.check(alternative, contextual);
    });
    this.c.flow.current = this.c.flow.merge([afterTrue, afterFalse]);
    return this.subtypeReduced([trueType, falseType]);
  }

  private assertion(node: TreeNode): Type {
    const expression = node.type === 'type_assertion' ? (named(node).at(-1) as TreeNode) : named(node)[0];
    const typeNode = node.type === 'type_assertion' ? named(named(node)[0])[0] : named(node)[1];
    if (!typeNode || node.children.some((child) => child?.type === 'const') || typeNode.text === 'const') {
      return this.check(expression);
    }
    const target = this.c.typeFromNode(typeNode);
    const source = this.check(expression, target);
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

  // Conditions ---------------------------------------------------------------------------------------------------

  /** Checks a condition, returning the flow states where it is true and where it is false. */
  checkCondition(node: TreeNode): { whenTrue: State; whenFalse: State } {
    const { whenTrue, whenFalse } = this.condition(node);
    return { whenTrue, whenFalse };
  }

  // code-gauge-allow functionCognitiveComplexity 50 -- One case per kind of condition that narrows.
  condition(node: TreeNode, testsTruthiness = true): { whenTrue: State; whenFalse: State; type: Type } {
    const result = this.conditionOf(node, testsTruthiness);
    if (testsTruthiness) this.checkTruthiness(node, result.type);
    return result;
  }

  // code-gauge-allow functionCognitiveComplexity 50 -- One case per kind of condition that narrows.
  private conditionOf(node: TreeNode, testsTruthiness: boolean): { whenTrue: State; whenFalse: State; type: Type } {
    void testsTruthiness;
    const expression = skipParentheses(node);
    if (expression.type === 'unary_expression' && expression.childForFieldName('operator')?.text === '!') {
      const inner = this.condition(expression.childForFieldName('argument') as TreeNode);
      return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue, type: booleanType };
    }
    if (expression.type === 'binary_expression') {
      const operator = expression.childForFieldName('operator')?.text ?? '';
      const left = expression.childForFieldName('left') as TreeNode;
      const right = expression.childForFieldName('right') as TreeNode;
      if (operator === '&&' || operator === '||') {
        const leftResult = this.condition(left);
        const rightState = operator === '&&' ? leftResult.whenTrue : leftResult.whenFalse;
        let rightResult = { whenTrue: undefined as State, whenFalse: undefined as State, type: neverType as Type };
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
      if (['===', '!==', '==', '!='].includes(operator)) {
        const type = this.check(expression);
        return { ...this.narrowEquality(left, right, operator), type };
      }
      if (operator === 'instanceof') {
        const type = this.check(expression);
        const instance = this.c.silently(() => this.instanceTypeOfConstructor(this.check(right)));
        return {
          ...this.narrowed(left, (current, assumeTrue) =>
            this.c.flow.narrowByInstanceof(current, instance, assumeTrue)
          ),
          type,
        };
      }
      if (operator === 'in' && left.type === 'string') {
        const type = this.check(expression);
        const name = stringValue(left);
        return {
          ...this.narrowed(right, (current, assumeTrue) => this.c.flow.narrowByIn(current, name, assumeTrue)),
          type,
        };
      }
    }
    if (expression.type === 'call_expression') {
      const type = this.check(expression);
      const predicate = this.calls.predicateOf(expression);
      if (predicate) {
        const { target, type: predicateType } = predicate;
        return {
          ...this.narrowed(target, (current, assumeTrue) =>
            assumeTrue
              ? this.narrowToPredicate(current, predicateType)
              : filterType(current, (member) => !this.c.relations.isAssignable(member, predicateType))
          ),
          type,
        };
      }
      return { ...this.truthiness(expression), type };
    }
    if (expression.type === 'assignment_expression') {
      const type = this.check(expression);
      const left = skipParentheses(expression.childForFieldName('left') as TreeNode);
      return {
        ...this.narrowed(left, (current, assumeTrue) => this.c.flow.narrowByTruthiness(current, assumeTrue)),
        type,
      };
    }
    const type = this.check(expression);
    return { ...this.truthiness(expression), type };
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

  private syntacticTruthiness(node: TreeNode): 'always' | 'never' | 'sometimes' {
    let expression = node;
    for (;;) {
      expression = skipParentheses(expression);
      if (['as_expression', 'satisfies_expression', 'non_null_expression'].includes(expression.type))
        expression = named(expression)[0];
      else if (expression.type === 'type_assertion') expression = named(expression).at(-1) as TreeNode;
      else break;
    }
    switch (expression.type) {
      case 'number': {
        return expression.text === '0' || expression.text === '1'
          ? 'sometimes'
          : expression.text.endsWith('n')
            ? 'always'
            : 'always';
      }
      case 'array':
      case 'arrow_function':
      case 'class':
      case 'function_expression':
      case 'object':
      case 'regex': {
        return 'always';
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
      case 'undefined': {
        return 'never';
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
      if (expression.type !== 'identifier' && expression.type !== 'member_expression') continue;
      const type = this.checkReferenceSilently(expression);
      if (isAnyLike(type) || this.c.relations.isNullable(type) || type.kind !== 'object') continue;
      if (this.c.signaturesOf(type, 'call').length === 0) continue;
      if (expression.type === 'member_expression') {
        const objectType = this.checkReferenceSilently(expression.childForFieldName('object') as TreeNode);
        const property = this.c.propertyOf(
          this.c.relations.removeNullish(objectType),
          expression.childForFieldName('property')?.text ?? ''
        );
        if (!property || property.optional) continue;
      }
      const text = expression.text;
      const usedInBody =
        body?.text.includes(`${text}(`) ||
        condition.text.includes(`${text}(`) ||
        (body?.text.includes(text) && expression.type === 'identifier');
      if (usedInBody) continue;
      this.c.error(
        expression,
        'この関数は常に定義されているので、この条件は常に真になります。呼び出すつもりでしたか？'
      );
    }
  }

  private narrowToPredicate(current: Type, predicateType: Type): Type {
    if (isAnyLike(current) || isIntrinsic(current, 'unknown')) return predicateType;
    const filtered = filterType(current, (member) => this.c.relations.isAssignable(member, predicateType));
    if (!isIntrinsic(filtered, 'never')) return filtered;
    const candidates = filterType(current, (member) => this.c.relations.isAssignable(predicateType, member));
    return isIntrinsic(candidates, 'never') ? predicateType : predicateType;
  }

  /** The instance type a constructor creates, for `instanceof`. */
  instanceTypeOfConstructor(type: Type): Type {
    if (isAnyLike(type)) return anyType;
    const signatures = this.c.signaturesOf(type, 'construct');
    if (signatures.length > 0) {
      const returned = signatures[0].returnType();
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

  private truthiness(expression: TreeNode): { whenTrue: State; whenFalse: State } {
    const narrowedChain = this.narrowed(expression, (current, assumeTrue) =>
      this.c.flow.narrowByTruthiness(current, assumeTrue)
    );
    // `a?.b` being truthy means `a` is not nullish.
    if (expression.type === 'member_expression' && expression.childForFieldName('optional_chain')) {
      const object = expression.childForFieldName('object') as TreeNode;
      const whenTrue = this.c.flow.from(narrowedChain.whenTrue, () =>
        this.c.flow.narrowReference(object, (type) => this.c.relations.removeNullish(type))
      );
      return { whenTrue, whenFalse: narrowedChain.whenFalse };
    }
    return narrowedChain;
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
    if (expression.type !== 'member_expression') return;
    const object = expression.childForFieldName('object') as TreeNode;
    const name = expression.childForFieldName('property')?.text ?? '';
    const objectType = this.checkReferenceSilently(object);
    const nonNull = this.c.relations.removeNullish(objectType);
    if (!this.c.flow.isDiscriminant(nonNull, name) && !this.c.relations.isNullable(objectType)) return;
    const apply = (state: State, assumeTrue: boolean): void => {
      if (!state) return;
      const outer = this.c.flow.current;
      this.c.flow.current = state;
      try {
        this.c.flow.narrowReference(object, (type) =>
          this.c.flow.narrowByDiscriminant(type, name, (propertyType) => narrow(propertyType, assumeTrue))
        );
      } finally {
        this.c.flow.current = outer;
      }
    };
    apply(whenTrue, true);
    apply(whenFalse, false);
    // The states were narrowed in place, so the reference's own entry stays as narrowed.
    void (whenTrue as FlowState | undefined);
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
        const result = this.narrowed(target, (current, assumeTrue) =>
          this.c.flow.narrowByTypeof(current, name, assumeTrue === equal)
        );
        return result;
      }
    }
    const leftType = this.checkReferenceSilently(left);
    const rightType = this.checkReferenceSilently(right);
    const base = this.c.flow.current;
    let whenTrue = base?.clone();
    let whenFalse = base?.clone();
    // Each side that is a reference narrows by the other's type.
    for (const [reference, otherType] of [
      [leftExpression, rightType],
      [rightExpression, leftType],
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
    return { whenTrue, whenFalse };
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

  isUnitType(type: Type): boolean {
    return isUnit(type);
  }

  // Helpers ------------------------------------------------------------------------------------------------------

  falsyType(): Type {
    return unionOf([falseType, literalType(0), literalType(''), nullType, undefinedType]);
  }

  mapTypes(type: Type, map: (member: Type) => Type): Type {
    return mapType(type, map);
  }

  trueLiteral(): Type {
    return trueType;
  }

  structureOfLiteral(structure: Structure): ObjectType {
    return anonymousObject(() => structure, { isLiteral: true });
  }
}

const wellKnownSymbols = new Set([
  'iterator',
  'asyncIterator',
  'hasInstance',
  'isConcatSpreadable',
  'match',
  'matchAll',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
  'unscopables',
]);

/** Functions and blocks whose bodies run when called, after the declarations that precede the call. */
const laterRunningTypes = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'class_static_block',
]);

function isNullishIntrinsic(type: Type): boolean {
  return isIntrinsic(type, 'null') || isIntrinsic(type, 'undefined');
}

/** Node.js names that need its type definitions, which the reference `tsc` does not have. */
function nodeGlobalHint(name: string): string {
  return ['process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer'].includes(name)
    ? 'Node.js の機能は、この採点環境では使えません。'
    : '';
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}
