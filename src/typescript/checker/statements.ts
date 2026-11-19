// code-gauge-allow-file fileNcss 621 -- Follows the flow of control through each kind of statement.
import assert from 'node:assert/strict';

import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { checkCircularConstraints } from './circularConstraints';
import {
  checkInheritedPropertiesAreIdentical,
  checkOverloadOptionality,
  checkTypeMemberDuplicates,
} from './declarations';
import { FlowState, type State } from './flow';
import type { FunctionContext } from './functions';
import { baseIndexMismatch, checkDuplicateIndexSignatures, checkIndexConformance } from './indexConformance';
import type { Scope, Sym } from './scopes';
import { arrayLiteralLength, hasToken, named, skipParentheses } from './syntax';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  neverType,
  regularOf,
  stringType,
  type Structure,
  type Type,
  undefinedType,
  unknownType,
} from './types';
import { unionStructure } from './unionMembers';

interface JumpTarget {
  isLoop: boolean;
  breaks: State[];
  continues: State[];
}

/**
 * How many times a loop body is checked silently, at most, to find the types its back edges bring; a loop still
 * unsettled then reads the references it assigns or narrows with their declared types.
 */
const MAX_LOOP_PASSES = 10;

/**
 * The type syntaxes that check themselves where they are written, as in a branch of a conditional type no use
 * instantiates: a tuple its elements, and an indexed access its key.
 */
const eagerTypeSyntaxes = new Set(['tuple_type', 'lookup_type']);

/** The syntaxes whose type identifiers name a type rather than refer to one, or are resolved with their parent. */
const nameOnlyTypeParents = new Set(['generic_type', 'type_parameter', 'mapped_type_clause', 'infer_type']);

/** Checks statements, following the flow of control through them. */
export class StatementChecker {
  /** Where each loop checked silently exits, by the loop and its entry state. */
  private readonly silentLoopExits = new Map<string, State[]>();
  private readonly jumpTargets: JumpTarget[] = [];
  /** The types of the objects `for...in` loops iterate, by loop. */
  private readonly forInObjectTypes = new Map<number, Type>();
  /** How each kind of statement is checked; the others need no checks. */
  private readonly checkers = new Map<string, (node: TreeNode) => void>([
    ['expression_statement', (node) => this.expressionStatement(node)],
    ['lexical_declaration', (node) => this.declaration(node)],
    ['variable_declaration', (node) => this.declaration(node)],
    ['statement_block', (node) => this.checkBlockStatements(named(node))],
    ['if_statement', (node) => this.ifStatement(node)],
    ['while_statement', (node) => this.whileStatement(node)],
    ['do_statement', (node) => this.doStatement(node)],
    ['for_statement', (node) => this.forStatement(node)],
    ['for_in_statement', (node) => this.forInStatement(node)],
    ['switch_statement', (node) => this.switchStatement(node)],
    ['try_statement', (node) => this.tryStatement(node)],
    ['return_statement', (node) => this.returnStatement(node)],
    ['throw_statement', (node) => this.throwStatement(node)],
    ['break_statement', () => this.breakStatement()],
    ['continue_statement', () => this.continueStatement()],
    ['function_signature', (node) => this.c.functions.checkOverloadImplementation(node)],
    ['function_declaration', (node) => this.c.functions.functionDeclaration(node)],
    ['class_declaration', (node) => this.c.classDeclarations.checkClass(node)],
    ['abstract_class_declaration', (node) => this.c.classDeclarations.checkClass(node)],
    ['interface_declaration', (node) => this.interfaceDeclaration(node)],
    ['type_alias_declaration', (node) => this.typeAliasDeclaration(node)],
  ]);

  constructor(private readonly c: Checker) {}

  checkProgram(root: TreeNode): void {
    this.c.flow.current = new FlowState();
    this.declareHoistedVariables(this.c.binder.moduleScope);
    this.checkBlockStatements(named(root));
    checkCircularConstraints(this.c, root);
  }

  /** Starts each `var` of a scope unassigned, as its hoisted binding holds `undefined` until its declaration runs. */
  declareHoistedVariables(scope: Scope | undefined): void {
    for (const symbol of scope?.values.values() ?? []) {
      if (
        symbol.valueKind !== 'var' ||
        symbol.valueDeclarations.some((declaration) => declaration.type !== 'variable_declarator')
      )
        continue;
      this.c.flow.set(`s${symbol.id}`, { type: this.c.expressions.valueTypeOf(symbol), assigned: false });
    }
  }

  /** Checks statements in order, following their reachable paths. */
  checkBlockStatements(statements: TreeNode[]): void {
    for (const statement of statements) {
      const current = this.c.flow.current;
      if (!current) {
        this.checkUnreachable(statement);
        continue;
      }
      if (current.dead) current.dead = 'after';
      this.check(statement);
    }
  }

  private check(node: TreeNode): void {
    // Each statement costs budget, as a statement such as a finally block may be checked more than once.
    this.c.budget.spend();
    this.checkers.get(node.type)?.(node);
  }

  private expressionStatement(node: TreeNode): void {
    const expression = named(node)[0];
    if (!expression) return;
    this.c.expressions.check(expression);
    const call = skipParentheses(expression);
    if (call.type === 'call_expression' && this.c.expressions.calls.endsFlow(call)) this.c.flow.current = undefined;
  }

  private throwStatement(node: TreeNode): void {
    const expression = named(node)[0];
    if (expression) this.c.expressions.check(expression);
    this.c.flow.current = undefined;
  }

  private breakStatement(): void {
    const target = this.jumpTargets.at(-1);
    target?.breaks.push(this.c.flow.current?.clone());
    this.c.flow.current = undefined;
  }

  private continueStatement(): void {
    const target = this.jumpTargets.findLast((candidate) => candidate.isLoop);
    target?.continues.push(this.c.flow.current?.clone());
    this.c.flow.current = undefined;
  }

  private typeAliasDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? this.c.scopeOf(node).lookupType(name) : undefined;
    this.c.signatures.typeParametersOf(node);
    if (symbol) this.c.typeNodes.declaredTypeOf(symbol);
    this.resolveTypesIn(node.childForFieldName('value'));
  }

  /** Resolves every type written in a node, so that unknown names report errors. */
  private resolveTypesIn(node: TreeNode | null): void {
    if (!node) return;
    const visit = (current: TreeNode): void => {
      // A qualified name resolves as a whole, so that its namespace is checked for availability.
      if (current.type === 'nested_type_identifier') {
        this.c.typeNodes.typeFromNode(current);
        return;
      }
      this.resolveTypeNode(current);
      for (const child of named(current)) visit(child);
    };
    visit(node);
  }

  private resolveTypeNode(node: TreeNode): void {
    if (
      (node.type === 'type_identifier' || node.type === 'generic_type') &&
      (!nameOnlyTypeParents.has(node.parent?.type ?? '') ||
        // The constraint of `infer U extends C` is a sibling of the name.
        (node.parent?.type === 'infer_type' && named(node.parent)[0]?.id !== node.id))
    ) {
      this.c.typeNodes.typeFromNode(node);
    }
    if (node.type === 'object_type') {
      checkTypeMemberDuplicates(this.c, node);
      checkOverloadOptionality(this.c, node);
      checkDuplicateIndexSignatures(this.c, named(node));
      const type = this.c.typeNodes.typeFromNode(node);
      if (type.kind === 'object') checkIndexConformance(this.c, type.resolve(), { bodies: [node] });
    }
    if (eagerTypeSyntaxes.has(node.type)) this.c.typeNodes.typeFromNode(node);
    if (node.type === 'infer_type') this.c.typeNodes.checkInferPlacement(node);
  }

  private interfaceDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? this.c.scopeOf(node).lookupType(name) : undefined;
    if (!symbol) return;
    const body = node.childForFieldName('body');
    if (body) {
      checkTypeMemberDuplicates(this.c, body);
      checkOverloadOptionality(this.c, body);
    }
    this.c.signatures.typeParametersOf(node);
    const type = this.c.typeNodes.declaredTypeOf(symbol);
    if (type.kind === 'object') this.checkInterfaceMembers(node, symbol, type.resolve());
    for (const child of named(node)) if (child.type === 'extends_type_clause') this.resolveTypesIn(child);
    this.resolveTypesIn(node.childForFieldName('body'));
  }

  private checkInterfaceMembers(node: TreeNode, symbol: Sym, structure: Structure): void {
    for (const property of structure.properties.values()) property.type();
    for (const signature of structure.callSignatures) signature.returnType();
    const interfaces = symbol.typeDeclarations.filter((declaration) => declaration.type === 'interface_declaration');
    const isFirst = interfaces[0]?.id === node.id;
    if (isFirst) this.checkIndexSignatures(symbol, interfaces, structure);
    if (!isFirst || checkInheritedPropertiesAreIdentical(this.c, symbol, node.childForFieldName('name') ?? node))
      this.checkInterfaceBases(node, symbol, structure);
  }

  /** Checks the index signatures of merged interface declarations together, as TypeScript does at the first one. */
  private checkIndexSignatures(symbol: Sym, interfaces: TreeNode[], structure: Structure): void {
    const bodies = interfaces.flatMap((declaration) => declaration.childForFieldName('body') ?? []);
    checkDuplicateIndexSignatures(
      this.c,
      bodies.flatMap((body) => named(body))
    );
    checkIndexConformance(this.c, structure, {
      bodies,
      name: interfaces[0].childForFieldName('name') ?? interfaces[0],
      bases: this.c.typeNodes.interfaceBases.baseTypesOf(symbol),
    });
  }

  /** Reports an interface that does not fit a type it extends, as TypeScript checks it is assignable to each base. */
  private checkInterfaceBases(node: TreeNode, symbol: Sym, structure: Structure): void {
    const body = node.childForFieldName('body');
    const clause = named(node).find((child) => child.type === 'extends_type_clause');
    if (!body || !clause) return;
    for (const baseNode of named(clause)) {
      const base = this.c.typeNodes.typeFromNode(baseNode);
      const mismatch = holdsTypeParameter(base)
        ? this.typeParameterBaseMismatch(symbol, base)
        : this.structuralBaseMismatch(body, structure, base);
      if (mismatch === undefined) continue;
      const name = node.childForFieldName('name');
      this.c.error(
        name ?? node,
        `インターフェース '${name?.text}' は、'${this.c.print(base)}' を正しく継承していません。${mismatch}`
      );
      return;
    }
  }

  /**
   * Why an interface does not fit a base that is or intersects a type parameter, or `undefined` when it does: fitting
   * the parameter's constraint is not enough, since the parameter may stand for a subtype.
   */
  private typeParameterBaseMismatch(symbol: Sym, base: Type): string | undefined {
    if (!this.c.typeNodes.interfaceBases.baseTypesOf(symbol).includes(base)) return undefined;
    return this.c.relations.isAssignable(this.c.typeNodes.declaredTypeOf(symbol), base) ? undefined : '';
  }

  /** Why an interface does not fit a base that holds no type parameter, or `undefined` when it does. */
  private structuralBaseMismatch(body: TreeNode, structure: Structure, base: Type): string | undefined {
    if (isAnyLike(base) || (base.kind !== 'object' && base.kind !== 'intersection')) return undefined;
    return (
      this.propertyBaseMismatch(body, structure, base) ?? baseIndexMismatch(this.c, structure, this.c.structureOf(base))
    );
  }

  /** Why a property an interface body declares does not fit the same property of a base, or `undefined` if none. */
  private propertyBaseMismatch(body: TreeNode, structure: Structure, base: Type): string | undefined {
    for (const property of structure.properties.values()) {
      if (property.declaration?.parent?.id !== body.id) continue;
      const baseProperty = this.c.propertyOf(base, property.name);
      if (
        baseProperty &&
        ((property.optional && !baseProperty.optional) ||
          !this.c.relations.isAssignable(property.type(), baseProperty.type()))
      )
        return `プロパティ '${property.name}' の型が合いません。`;
    }
    return undefined;
  }

  // Declarations -------------------------------------------------------------------------------------------------

  private declaration(node: TreeNode): void {
    const kind = node.type === 'variable_declaration' ? 'var' : (node.childForFieldName('kind')?.text ?? 'let');
    for (const declarator of named(node)) {
      if (declarator.type !== 'variable_declarator') continue;
      this.resolveTypesIn(declarator.childForFieldName('type'));
      const nameNode = declarator.childForFieldName('name') as TreeNode;
      if (nameNode.type === 'identifier') this.variableDeclarator(declarator, nameNode, kind);
      else this.patternDeclarator(declarator, nameNode, kind === 'const');
    }
  }

  private variableDeclarator(declarator: TreeNode, nameNode: TreeNode, kind: string): void {
    const value = declarator.childForFieldName('value');
    const annotation = this.c.typeNodes.annotationType(declarator.childForFieldName('type'));
    const symbol = this.c.scopeOf(nameNode).lookupValue(nameNode.text);
    if (!symbol) return;
    if (symbol.valueDeclaration?.id !== declarator.id) {
      this.redeclaredVariable(declarator, symbol, annotation);
      return;
    }
    if (!value) {
      this.uninitializedVariable(declarator, symbol, kind, annotation);
      return;
    }
    const key = `s${symbol.id}`;
    const valueType = this.c.expressions.check(value, annotation);
    if (annotation) {
      this.c.expressions.checkAssignable(nameNode, valueType, annotation, value);
      this.c.expressions.setVariableType(symbol, annotation);
      this.c.flow.set(key, { type: this.c.flow.assignmentReduced(annotation, regularOf(valueType)), assigned: true });
      return;
    }
    if (this.isEmptyArrayLiteral(value)) {
      // `const a = []` evolves as elements are pushed.
      this.c.expressions.setVariableType(symbol, this.c.arrayType(anyType));
      this.c.flow.set(key, { type: this.c.arrayType(neverType), assigned: true, evolving: true });
      return;
    }
    const isConst = kind === 'const';
    const declared = this.c.literals.widenDeclared(valueType, isConst);
    const widened =
      isIntrinsic(declared, 'null') || isIntrinsic(declared, 'undefined')
        ? isConst
          ? declared
          : anyType
        : isConst
          ? this.c.expressions.expandos.constType(declarator, symbol, declared)
          : declared;
    this.c.expressions.setVariableType(symbol, widened);
    this.c.flow.set(key, { type: isConst ? widened : widened === anyType ? declared : widened, assigned: true });
  }

  /** A variable declared again, which keeps the type its first declaration gives, as TypeScript's merged symbol does. */
  private redeclaredVariable(declarator: TreeNode, symbol: Sym, annotation: Type | undefined): void {
    const value = declarator.childForFieldName('value');
    if (!value) return;
    const valueType = this.c.expressions.check(value, annotation);
    if (annotation)
      this.c.expressions.checkAssignable(
        declarator.childForFieldName('name') as TreeNode,
        valueType,
        annotation,
        value
      );
    const declared = this.c.expressions.valueTypeOf(symbol);
    this.c.flow.set(`s${symbol.id}`, {
      type: this.c.flow.assignmentReduced(declared, regularOf(valueType)),
      assigned: true,
    });
  }

  private uninitializedVariable(declarator: TreeNode, symbol: Sym, kind: string, annotation: Type | undefined): void {
    if (kind === 'const') return;
    const key = `s${symbol.id}`;
    if (!annotation) {
      // `let x;` follows the types assigned to it, starting as `undefined`.
      this.c.expressions.setVariableType(symbol, anyType);
      this.c.flow.set(key, { type: undefinedType, assigned: kind === 'var' });
      return;
    }
    this.c.expressions.setVariableType(symbol, annotation);
    // A `var` keeps what its hoisted binding holds, which an assignment before the declaration may have set.
    if (kind === 'var' && this.c.flow.entry(key)) return;
    this.c.flow.set(key, { type: annotation, assigned: hasToken(declarator, '!') });
  }

  private patternDeclarator(declarator: TreeNode, pattern: TreeNode, isConst: boolean): void {
    const value = declarator.childForFieldName('value');
    const annotation = this.c.typeNodes.annotationType(declarator.childForFieldName('type'));
    const implied = annotation ? undefined : this.c.patterns.impliedType(pattern);
    const valueType = value ? this.c.expressions.check(value, annotation ?? implied) : (annotation ?? anyType);
    if (annotation && value) this.c.expressions.checkAssignable(pattern, valueType, annotation);
    if (value && implied) this.c.patterns.checkInitializer(pattern, value, valueType, implied);
    const sourceType = annotation ?? this.c.literals.widenDeclared(valueType, false);
    if (isConst) this.c.patterns.correlatedSources.set(pattern.id, sourceType);
    this.c.patterns.bindPattern(
      pattern,
      sourceType,
      (identifier, type) => {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (!symbol) return;
        const declared = this.c.literals.widenDeclared(type, isConst);
        this.c.expressions.setVariableType(symbol, declared);
        this.c.flow.set(`s${symbol.id}`, { type: declared, assigned: true });
      },
      annotation !== undefined
    );
  }

  private isEmptyArrayLiteral(node: TreeNode): boolean {
    const expression = skipParentheses(node);
    return expression.type === 'array' && arrayLiteralLength(expression) === 0;
  }

  /** The type of a variable from its declaration, computed ahead of its statement when used earlier. */
  declaredVariableType(symbol: Sym, declaration: TreeNode): Type {
    if (declaration.type === 'for_in_statement') return this.loopVariableType(declaration, symbol);
    if (declaration.type !== 'variable_declarator') return anyType;
    const nameNode = declaration.childForFieldName('name') as TreeNode;
    const annotation = this.c.typeNodes.annotationType(declaration.childForFieldName('type'));
    const value = declaration.childForFieldName('value');
    const isConst = declaration.parent?.childForFieldName('kind')?.text === 'const';
    if (nameNode.type === 'identifier') {
      if (annotation) return annotation;
      if (!value) return anyType;
      if (this.isEmptyArrayLiteral(value)) return this.c.arrayType(anyType);
      const flow = this.c.flow.current;
      this.c.flow.current = new FlowState();
      try {
        return this.c.literals.widenDeclared(this.c.expressions.check(value), isConst);
      } finally {
        this.c.flow.current = flow;
      }
    }
    const source =
      annotation ??
      (value
        ? this.c.literals.widenDeclared(this.c.expressions.check(value, this.c.patterns.impliedType(nameNode)), false)
        : anyType);
    return this.c.literals.widenDeclared(this.c.patterns.patternType(nameNode, source, symbol.name), isConst);
  }

  private loopVariableType(node: TreeNode, symbol: Sym): Type {
    const header = node.childForFieldName('header') ?? node;
    const right = header.childForFieldName('right') as TreeNode;
    const left = header.childForFieldName('left') as TreeNode;
    const isOf = header.childForFieldName('operator')?.text === 'of';
    const rightType = this.c.expressions.check(right, isOf ? this.iterableContext(left) : undefined);
    const elementType = isOf ? this.c.patterns.iteratedType(undefined, rightType) : stringType;
    if (left.type === 'identifier') return elementType;
    return this.c.patterns.patternType(left, elementType, symbol.name);
  }

  // Control flow -------------------------------------------------------------------------------------------------

  private ifStatement(node: TreeNode): void {
    const condition = node.childForFieldName('condition') as TreeNode;
    const checked = this.c.conditions.checkCondition(condition);
    // `if (true)` never takes its else branch, and `if (false)` never takes its then branch.
    const literal = skipParentheses(condition).type;
    const whenTrue = literal === 'false' ? undefined : checked.whenTrue;
    const whenFalse = literal === 'true' ? undefined : checked.whenFalse;
    const consequence = node.childForFieldName('consequence') as TreeNode;
    this.c.conditions.checkUncalledFunction(condition, consequence);
    const alternative = node.childForFieldName('alternative');
    const afterTrue = this.c.flow.from(whenTrue, () => this.checkSubstatement(consequence));
    const afterFalse = this.c.flow.from(whenFalse, () => {
      if (alternative) for (const child of named(alternative)) this.checkSubstatement(child);
    });
    this.c.flow.current = this.c.flow.merge([afterTrue, afterFalse]);
  }

  private checkSubstatement(node: TreeNode): void {
    if (!this.c.flow.isReachable) {
      this.checkUnreachable(node);
      return;
    }
    this.check(node);
  }

  private checkUnreachable(node: TreeNode): void {
    this.c.flow.current = new FlowState(undefined, undefined, true);
    this.check(node);
    this.c.flow.current = undefined;
  }

  /**
   * Checks a loop: silently while the types its back edges bring change, then once reporting errors.
   *
   * @param iterate Runs one iteration from the current state and returns the state where the loop exits from it.
   */
  private loop(node: TreeNode, iterate: (target: JumpTarget) => State): void {
    const entry = this.c.flow.current;
    // An enclosing loop's silent passes check this loop once each; the same entry state leaves it the same way.
    const key = this.c.silent > 0 ? `${node.id}:${this.stateKey(entry)}` : undefined;
    const known = key === undefined ? undefined : this.silentLoopExits.get(key);
    if (known) {
      this.c.flow.current = this.c.flow.merge(known);
      return;
    }
    let state = entry?.clone();
    let settled: State[] | undefined;
    for (let pass = 1; ; pass++) {
      const { exits, backEdge } = this.c.silently(() => this.loopPass(state, iterate));
      const next = this.c.flow.merge([entry, backEdge]);
      if (this.sameState(next, state)) {
        settled = exits;
        break;
      }
      if (pass === MAX_LOOP_PASSES) {
        state = widenTouched(next, state, backEdge);
        break;
      }
      state = next;
    }
    // Checking silently already, the pass that settled the loop is the one that would report errors.
    const exits = settled && this.c.silent > 0 ? settled : this.loopPass(state, iterate).exits;
    if (key !== undefined) this.silentLoopExits.set(key, exits);
    this.c.flow.current = this.c.flow.merge(exits);
  }

  /** Runs a loop's iteration once from `state`, and returns where it exits and the state its back edge brings. */
  private loopPass(state: State, iterate: (target: JumpTarget) => State): { exits: State[]; backEdge: State } {
    const target: JumpTarget = { isLoop: true, breaks: [], continues: [] };
    this.c.flow.current = state?.clone();
    this.jumpTargets.push(target);
    try {
      const exit = iterate(target);
      return { exits: [exit, ...target.breaks], backEdge: this.c.flow.current };
    } finally {
      this.jumpTargets.pop();
    }
  }

  /** A key that two states share when they hold the same types for the same references. */
  private stateKey(state: State): string {
    if (!state) return '-';
    const entries = [...state.entries].map(
      ([reference, entry]) => `${reference}=${entry.type.id}${entry.assigned ? '' : '?'}${entry.constraint?.id ?? ''}`
    );
    return `${entries.toSorted().join(',')}|${[...state.assignedFields].toSorted().join(',')}|${state.superCalled}`;
  }

  private sameState(a: State, b: State): boolean {
    if (!a || !b) return a === b;
    if (a.superCalled !== b.superCalled || a.entries.size !== b.entries.size) return false;
    for (const [key, entry] of a.entries) {
      const other = b.entries.get(key);
      if (!other || other.type.id !== entry.type.id || other.assigned !== entry.assigned) return false;
    }
    return true;
  }

  private whileStatement(node: TreeNode): void {
    const condition = node.childForFieldName('condition') as TreeNode;
    const body = node.childForFieldName('body') as TreeNode;
    this.loop(node, (target) => {
      const { whenTrue, whenFalse } = this.c.conditions.checkCondition(condition);
      this.c.flow.current = whenTrue;
      this.checkSubstatement(body);
      const end = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      this.c.flow.current = end;
      return this.isAlwaysTrue(condition) ? undefined : whenFalse;
    });
  }

  private doStatement(node: TreeNode): void {
    const condition = node.childForFieldName('condition') as TreeNode;
    const body = node.childForFieldName('body') as TreeNode;
    this.loop(node, (target) => {
      this.checkSubstatement(body);
      this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      if (!this.c.flow.isReachable) return;
      const { whenTrue, whenFalse } = this.c.conditions.checkCondition(condition);
      this.c.flow.current = whenTrue;
      return this.isAlwaysTrue(condition) ? undefined : whenFalse;
    });
  }

  private forStatement(node: TreeNode): void {
    const header = node.childForFieldName('header') ?? node;
    const initializer = header.childForFieldName('initializer');
    const condition = header
      .childrenForFieldName('condition')
      .find((child) => child.isNamed && child.type !== 'empty_statement');
    const increment = header.childrenForFieldName('increment').find((child) => child.isNamed);
    const body = node.childForFieldName('body') as TreeNode;
    if (initializer && initializer.type !== 'empty_statement') this.forInitializer(initializer);
    const conditionNode = condition && condition.type === 'expression_statement' ? named(condition)[0] : condition;
    this.loop(node, (target) => {
      let whenFalse: State;
      if (conditionNode) {
        const result = this.c.conditions.checkCondition(conditionNode);
        this.c.flow.current = result.whenTrue;
        whenFalse = this.isAlwaysTrue(conditionNode) ? undefined : result.whenFalse;
      }
      this.checkSubstatement(body);
      this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      if (increment && this.c.flow.isReachable) this.c.expressions.check(increment);
      return whenFalse;
    });
  }

  private forInitializer(initializer: TreeNode): void {
    if (initializer.type === 'lexical_declaration' || initializer.type === 'variable_declaration')
      this.declaration(initializer);
    else if (initializer.type === 'expression_statement') this.c.expressions.check(named(initializer)[0]);
    else this.c.expressions.check(initializer);
  }

  private isAlwaysTrue(condition: TreeNode): boolean {
    return skipParentheses(condition).type === 'true';
  }

  private forInStatement(node: TreeNode): void {
    const header = node.childForFieldName('header') ?? node;
    const left = header.childForFieldName('left') as TreeNode;
    const right = header.childForFieldName('right') as TreeNode;
    const isOf = header.childForFieldName('operator')?.text === 'of';
    const kind = header.childForFieldName('kind')?.text;
    const rightType = this.c.expressions.check(right, isOf ? this.iterableContext(left) : undefined);
    const elementType = this.loopElementType(node, rightType);
    if (!isOf) this.forInObjectTypes.set(node.id, rightType);
    const body = node.childForFieldName('body') as TreeNode;
    this.loop(node, (target) => {
      const head = this.c.flow.current?.clone();
      if (kind) this.bindLoopVariables(left, kind, elementType);
      else this.assignLoopVariables(left, elementType);
      this.checkSubstatement(body);
      this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      return this.c.flow.merge([head, this.c.flow.current]);
    });
  }

  loopElementType(node: TreeNode, rightType: Type): Type {
    const header = node.childForFieldName('header') ?? node;
    const right = header.childForFieldName('right') as TreeNode;
    return header.childForFieldName('operator')?.text === 'of'
      ? this.c.patterns.iteratedType(right, rightType)
      : this.forInKeyType(right, rightType);
  }

  /**
   * Whether an index is the variable of an enclosing `for...in` loop over an object whose only index signature is a
   * number one, as an array's, which TypeScript's `isForInVariableForNumericPropertyNames` lets index as a number.
   */
  isForInNumericIndex(index: TreeNode): boolean {
    const expression = skipParentheses(index);
    if (expression.type !== 'identifier') return false;
    const symbol = this.c.scopeOf(expression).lookupValue(expression.text);
    for (let child = index, node = index.parent; symbol && node; child = node, node = node.parent) {
      if (
        node.type === 'for_in_statement' &&
        node.childForFieldName('body')?.id === child.id &&
        this.forInVariable(node) === symbol &&
        this.hasOnlyNumberIndex(this.forInObjectTypes.get(node.id))
      )
        return true;
    }
    return false;
  }

  /** The variable a `for...in` loop assigns, when it is a single name. */
  private forInVariable(node: TreeNode): Sym | undefined {
    const header = node.childForFieldName('header') ?? node;
    const left = header.childForFieldName('left');
    if (header.childForFieldName('operator')?.text !== 'in' || left?.type !== 'identifier') return undefined;
    return this.c.scopeOf(left).lookupValue(left.text);
  }

  private hasOnlyNumberIndex(type: Type | undefined): boolean {
    if (!type) return false;
    const apparent = this.c.apparentType(type);
    const { stringIndex, numberIndex, symbolIndex } =
      apparent.kind === 'union' ? unionStructure(this.c, apparent.types) : this.c.structureOf(apparent);
    return numberIndex !== undefined && !stringIndex && !symbolIndex;
  }

  /** The array a `for...of` loop's pattern implies for an array literal it iterates. */
  private iterableContext(left: TreeNode): Type | undefined {
    const implied = this.c.patterns.impliedType(left);
    return implied && this.c.arrayType(implied);
  }

  /**
   * The type of the keys a `for...in` loop takes, reporting an object that is a primitive: `Extract<keyof T, string>`
   * for a generic object `T`, as it can index `T`, and `string` otherwise.
   */
  private forInKeyType(right: TreeNode, rightType: Type): Type {
    const object = regularOf(rightType);
    if (
      !isAnyLike(object) &&
      (object.kind === 'literal' || (object.kind === 'intrinsic' && object.name !== 'object'))
    ) {
      this.c.error(
        right,
        'for...in 文の右辺は、any 型、オブジェクト型、型パラメーターのいずれかでなければいけません。'
      );
    }
    const keys = this.genericKeys(this.c.relations.removeNullish(object));
    if (!keys) return stringType;
    const extract = this.c.libraryBinder.moduleScope.lookupType('Extract') as Sym;
    const [type, union] = this.c.signatures.typeParametersOfSymbol(extract);
    return this.c.instantiate(
      this.c.typeNodes.declaredTypeOf(extract),
      new Map<number, Type>([
        [type.id, keys],
        [union.id, stringType],
      ])
    );
  }

  /**
   * `keyof object` when TypeScript leaves it a type parameter or a deferred `keyof`: for an instantiable type or a mapped
   * type over generic keys.
   */
  private genericKeys(object: Type): Type | undefined {
    if (['typeParameter', 'indexedAccess', 'conditional'].includes(object.kind))
      return this.c.typeOperators.keyofType(object);
    const mapped = object.kind === 'object' && !object.mapped?.nameType ? object.mapped?.constraint : undefined;
    return mapped?.kind === 'typeParameter' || mapped?.kind === 'keyof' ? mapped : undefined;
  }

  /** Declares the variables of a loop's `const`, `let`, or `var` head. */
  private bindLoopVariables(left: TreeNode, kind: string, elementType: Type): void {
    this.c.patterns.bindPattern(left, elementType, (identifier, type) => {
      const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
      if (!symbol) return;
      this.c.expressions.setVariableType(symbol, kind === 'const' ? type : this.c.widen(type));
      this.c.flow.set(`s${symbol.id}`, { type, assigned: true });
    });
  }

  /** Assigns the existing variables a loop's head without a declaration names. */
  private assignLoopVariables(left: TreeNode, elementType: Type): void {
    if (left.type === 'array_pattern' || left.type === 'object_pattern') {
      this.c.assignments.destructuringAssignment(left, elementType);
      return;
    }
    const declared = this.c.assignments.targetType(left, false);
    if (declared !== errorType) this.c.expressions.checkAssignable(left, elementType, declared);
    this.c.assignments.assignReference(left, declared, elementType);
  }

  private switchStatement(node: TreeNode): void {
    const discriminant = skipParentheses(node.childForFieldName('value') as TreeNode);
    const body = node.childForFieldName('body') as TreeNode;
    const cases = named(body).filter((child) => child.type === 'switch_case' || child.type === 'switch_default');
    const { caseEntries, noMatch } = this.switchCaseEntries(discriminant, cases);
    const target: JumpTarget = { isLoop: false, breaks: [], continues: [] };
    this.jumpTargets.push(target);
    let fallthrough: State;
    try {
      for (const [index, caseNode] of cases.entries()) {
        // The default clause is taken where no case matches, including the cases after it.
        this.c.flow.current = this.c.flow.merge([caseEntries[index] ?? noMatch, fallthrough]);
        const statements = caseNode
          .childrenForFieldName('body')
          .filter((child) => child.isNamed && child.type !== 'comment');
        this.checkBlockStatements(statements);
        fallthrough = this.c.flow.current;
      }
    } finally {
      this.jumpTargets.pop();
    }
    const bypass = cases.some((caseNode) => caseNode.type === 'switch_default') ? undefined : noMatch;
    this.c.flow.current = this.c.flow.merge([fallthrough, ...target.breaks, this.markExhaustive(discriminant, bypass)]);
  }

  /** The state each case is entered in where its test matches (undefined for the default), and where none does. */
  private switchCaseEntries(discriminant: TreeNode, cases: TreeNode[]): { caseEntries: State[]; noMatch: State } {
    const discriminantType = this.c.expressions.check(discriminant);
    const entry = this.c.flow.current;
    const caseTypes: Type[] = [];
    // `switch (true)` enters a case where its test is true, and the default where every test is false.
    const testsConditions = discriminant.type === 'true';
    let allFalse = entry;
    const caseEntries = cases.map((caseNode): State => {
      if (caseNode.type !== 'switch_case') return undefined;
      this.c.flow.current = entry?.clone();
      const test = caseNode.childForFieldName('value') as TreeNode;
      const testType = this.checkCaseTest(test, discriminantType);
      caseTypes.push(testType);
      if (!testsConditions) return this.c.conditions.narrowSwitchCase(discriminant, entry, [testType], true);
      this.c.flow.current = allFalse?.clone();
      const { whenTrue, whenFalse } = this.c.silently(() => this.c.conditions.checkCondition(test));
      allFalse = whenFalse;
      return whenTrue;
    });
    this.c.flow.current = entry;
    const noMatch = testsConditions
      ? allFalse
      : this.c.conditions.narrowSwitchCase(discriminant, entry, caseTypes, false);
    return { caseEntries, noMatch };
  }

  /**
   * Marks the state past a `switch` without a default as one no path reaches where its cases cover every value of its
   * discriminant (or of the operand of a `typeof` discriminant), which stays narrowed to `never` there.
   */
  private markExhaustive(discriminant: TreeNode, bypass: State): State {
    const reference =
      discriminant.type === 'unary_expression' && discriminant.childForFieldName('operator')?.text === 'typeof'
        ? skipParentheses(discriminant.childForFieldName('argument') as TreeNode)
        : discriminant;
    if (!bypass || !this.c.flow.referenceKey(reference)) return bypass;
    let remaining: Type = neverType;
    this.c.flow.from(bypass, () => {
      remaining = this.c.expressions.checkReferenceSilently(reference);
    });
    if (!isIntrinsic(remaining, 'never')) return bypass;
    const exhausted = bypass.clone();
    exhausted.dead = 'switchEnd';
    return exhausted;
  }

  /** Checks a `case` test, reporting one that cannot equal the discriminant, and returns its type. */
  private checkCaseTest(test: TreeNode, discriminantType: Type): Type {
    const testType = this.c.expressions.check(test);
    if (
      !isAnyLike(discriminantType) &&
      !isAnyLike(testType) &&
      !this.c.relations.isComparable(regularOf(discriminantType), regularOf(testType))
    ) {
      const target = regularOf(discriminantType);
      this.c.error(
        test,
        `型 '${this.c.print(this.c.widenLiteralForMessage(testType, target))}' は型 '${this.c.print(target)}' と比べられません。`
      );
    }
    return regularOf(testType);
  }

  private tryStatement(node: TreeNode): void {
    const body = node.childForFieldName('body') as TreeNode;
    const handler = node.childForFieldName('handler');
    const finalizer = node.childForFieldName('finalizer');
    const passed = this.c.flow.exceptions.collect(body, () => this.checkBlockStatements(named(body)));
    const tryEnd = this.c.flow.current;
    let catchEnd: State;
    let catchPassed: State;
    if (handler) {
      this.c.flow.current = passed;
      this.bindCatchParameter(handler);
      const handlerBody = handler.childForFieldName('body') as TreeNode;
      catchPassed = this.c.flow.exceptions.collect(handlerBody, () => this.checkBlockStatements(named(handlerBody)));
      catchEnd = this.c.flow.current;
    }
    const after = handler ? this.c.flow.merge([tryEnd, catchEnd!]) : tryEnd;
    if (!finalizer) {
      this.c.flow.current = after;
      return;
    }
    this.c.flow.current = this.c.flow.merge([passed, tryEnd, catchPassed!, handler ? catchEnd! : undefined]);
    const finalBody = finalizer.childForFieldName('body') ?? named(finalizer)[0];
    if (finalBody) this.checkBlockStatements(named(finalBody));
    this.c.flow.exceptions.include(this.c.flow.current);
    if (!this.c.flow.isReachable) return;
    this.c.flow.current = after;
    if (finalBody && after) this.c.silently(() => this.checkBlockStatements(named(finalBody)));
  }

  private bindCatchParameter(handler: TreeNode): void {
    const parameter = handler.childForFieldName('parameter');
    const annotation = this.c.typeNodes.annotationType(handler.childForFieldName('type'));
    if (annotation && !isAnyLike(annotation) && !isIntrinsic(annotation, 'unknown')) {
      this.c.error(
        handler.childForFieldName('type') ?? handler,
        'catch の変数の型の注釈は、any か unknown にしてください。'
      );
    }
    if (parameter && parameter.type !== 'identifier') {
      this.c.patterns.bindPattern(parameter, annotation ?? unknownType, (identifier, type) => {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (symbol) this.c.expressions.setVariableType(symbol, type);
      });
    }
  }

  private returnStatement(node: TreeNode): void {
    const context = this.c.functions.contexts.at(-1);
    const expression = named(node)[0];
    if (!context) {
      if (expression) this.c.expressions.check(expression);
      this.c.flow.current = undefined;
      return;
    }
    if (expression) {
      const declared = context.isConstructor ? this.constructorInstanceType(context.node) : context.declaredReturn;
      context.inReturn = true;
      const type = this.c.expressions.check(expression, declared ?? context.contextualReturn);
      context.inReturn = false;
      if (hasToken(context.node, 'set')) {
        this.c.error(node, 'set アクセサーは値を返せません。');
      } else if (declared) {
        if (context.isConstructor) this.checkConstructorReturn(expression, type, declared);
        else this.c.expressions.checkReturnValue(expression, type, declared);
      }
      context.returnTypes.push(type);
      context.hasReturnWithValue = true;
    } else this.returnWithoutValue(node, context);
    context.returnStates.push(this.c.flow.current?.clone());
    this.c.flow.current = undefined;
  }

  private returnWithoutValue(node: TreeNode, context: FunctionContext): void {
    context.hasReturnWithoutValue = true;
    const declared = context.declaredReturn;
    if (
      declared &&
      !context.isConstructor &&
      !isAnyLike(declared) &&
      !isIntrinsic(declared, 'void') &&
      !this.c.relations.isAssignable(undefinedType, declared)
    )
      this.c.expressions.reportNotAssignable(node, undefinedType, declared);
  }

  private constructorInstanceType(node: TreeNode): Type {
    const classNode = node.parent?.parent;
    assert.ok(classNode);
    return this.c.classes.classInfoOfNode(classNode).instanceType;
  }

  private checkConstructorReturn(node: TreeNode, type: Type, expected: Type): void {
    if (this.c.relations.isAssignable(type, expected)) return;
    this.c.expressions.reportNotAssignable(node, type, expected);
    this.c.error(node, 'コンストラクタの戻り値の型は、このクラスのインスタンス型に代入できる必要があります。');
  }
}

/**
 * `state` without the references that a loop pass from `start` assigned or narrowed by its back edge `backEdge`, which
 * then read with their declared types.
 */
function widenTouched(state: State, start: State, backEdge: State): State {
  if (!state) return state;
  const widened = state.clone();
  for (const key of state.entries.keys()) {
    if (backEdge?.entries.get(key) !== start?.entries.get(key)) widened.entries.delete(key);
  }
  return widened;
}

/** Whether a base is a type parameter or intersects one, which an interface cannot fit by its members alone. */
function holdsTypeParameter(base: Type): boolean {
  return (
    base.kind === 'typeParameter' ||
    (base.kind === 'intersection' && base.types.some((member) => member.kind === 'typeParameter'))
  );
}
