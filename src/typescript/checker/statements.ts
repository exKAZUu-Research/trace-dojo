// code-gauge-allow-file fileNcss -- Follows the flow of control through each kind of statement.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';
import { assert } from 'es-toolkit';

import { isAmbient, isCheckedAmbientDeclaration } from '../namespaceInstantiation';
import { checkAmbientInitializer } from './ambientDeclarations';
import { checkAmbientExportTarget } from './ambientModuleExports';
import { checkAwaitPlace } from './awaited';
import { declaredNames } from './binder';
import type { Checker } from './checker';
import { checkConstraintDeclarations } from './circularConstraints';
import {
  checkInheritedPropertiesAreIdentical,
  checkOverloadOptionality,
  checkTypeMemberDuplicates,
} from './declarations';
import { FlowState, isUnit, type State } from './flow';
import type { FunctionContext } from './functions';
import { baseIndexMismatch, checkDuplicateIndexSignatures, checkIndexConformance } from './indexConformance';
import type { Scope, Sym } from './scopes';
import {
  hasToken,
  isAmbientModuleBody,
  isDirectEmptyArray,
  isDirectGlobalAugmentationContainer,
  isNamespaceBody,
  jumpLabel,
  labeledBody,
  loopStatementTypes,
  named,
  skipParentheses,
  stringValue,
  templateFragmentText,
} from './syntax';
import {
  anyType,
  errorType,
  filterType,
  isAnyLike,
  isIntrinsic,
  neverType,
  propertyAccessType,
  regularOf,
  stringType,
  type Structure,
  type Type,
  typeMembers,
  undefinedType,
  unknownType,
} from './types';
import { unionStructure } from './unionMembers';
import { checkVarianceAnnotations } from './varianceAnnotations';
import { checkWrittenType } from './writtenTypes';

interface JumpTarget {
  isLoop: boolean;
  /** The labels naming the statement, which `break` and `continue` with a label jump to. */
  labels: string[];
  breaks: State[];
  continues: State[];
}

/**
 * How many times a loop body is checked silently, at most, to find the types its back edges bring; a loop still
 * unsettled then reads the references it assigns or narrows with their declared types.
 */
const MAX_LOOP_PASSES = 10;

/** Checks statements, following the flow of control through them. */
export class StatementChecker {
  /** Where each loop checked silently exits, by the loop and its entry state. */
  private readonly silentLoopExits = new Map<string, State[]>();
  private readonly jumpTargets: JumpTarget[] = [];
  /**
   * The labels of the loop about to be checked, by the loop, which its jump target takes: a loop its header contains
   * must not take them.
   */
  private readonly pendingLabels = new Map<number, string[]>();
  private readonly reportedMissingTypes = new Set<string>();
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
    ['break_statement', (node) => this.breakStatement(node)],
    ['continue_statement', (node) => this.continueStatement(node)],
    ['labeled_statement', (node) => this.labeledStatement(node)],
    ['with_statement', (node) => this.withStatement(node)],
    ['function_signature', (node) => this.c.functions.checkOverloadImplementation(node)],
    ['function_declaration', (node) => this.c.functions.functionDeclaration(node)],
    ['generator_function_declaration', (node) => this.c.functions.functionDeclaration(node)],
    ['class_declaration', (node) => this.c.classDeclarations.checkClass(node)],
    ['abstract_class_declaration', (node) => this.c.classDeclarations.checkClass(node)],
    ['interface_declaration', (node) => this.interfaceDeclaration(node)],
    ['type_alias_declaration', (node) => this.typeAliasDeclaration(node)],
    ['enum_declaration', (node) => this.c.enums.checkDeclaration(node)],
    ['internal_module', (node) => this.c.namespaces.checkDeclaration(node)],
    ['module', (node) => this.c.namespaces.checkDeclaration(node)],
    ['export_statement', (node) => this.exportStatement(node)],
    ['ambient_declaration', (node) => this.ambientDeclaration(node)],
    ['import_alias', (node) => this.c.namespaces.checkImportAlias(node)],
    ['import_statement', (node) => this.c.namespaces.checkImport(node)],
    ['using_declaration', (node) => this.usingDeclaration(node)],
  ]);

  constructor(private readonly c: Checker) {}

  checkProgram(root: TreeNode): void {
    this.c.flow.current = new FlowState();
    this.declareHoistedVariables(this.c.binder.moduleScope);
    this.checkBlockStatements(named(root));
    checkConstraintDeclarations(this.c, root);
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
    const check = this.checkers.get(node.type);
    if (check) this.c.withTypeDemand(node, () => check(node));
  }

  private expressionStatement(node: TreeNode): void {
    const expression = named(node)[0];
    if (!expression) return;
    if (expression.type === 'internal_module') {
      this.check(expression);
      return;
    }
    const type = this.c.expressions.check(expression);
    const call = skipParentheses(expression);
    if (call.type !== 'call_expression') return;
    if (this.c.expressions.calls.endsFlow(call, type)) this.c.flow.current = undefined;
    else this.c.conditions.applyAssertion(call);
  }

  /**
   * `using` and `await using`, which need the `Disposable` and `AsyncDisposable` types that the ES2025 library the
   * reference checks with lacks: tsc reports each missing type once, without a location, here the first declaration's.
   */
  private usingDeclaration(node: TreeNode): void {
    const name = hasToken(node, 'await') ? 'AsyncDisposable' : 'Disposable';
    if (this.c.silent === 0 && !this.reportedMissingTypes.has(name)) {
      this.reportedMissingTypes.add(name);
      this.c.error(node, `グローバル型 '${name}' が見つかりません。`);
    }
    for (const declarator of named(node)) {
      const value = declarator.childForFieldName('value');
      if (value) this.c.expressions.check(value);
    }
  }

  /**
   * `export`, which checks the declaration or the default value it exports, and that each name `export { ... }`
   * exports is declared. `export =` is CommonJS's, which tsc rejects in a module of ECMAScript syntax.
   */
  private exportStatement(node: TreeNode): void {
    const declaration = node.childForFieldName('declaration');
    if (declaration) this.check(declaration);
    const value = node.childForFieldName('value');
    const clause = named(node).find((child) => child.type === 'export_clause');
    const source = node.childForFieldName('source');
    const assigned = named(node).find((child) => child.type !== 'export_clause' && child.type !== 'comment');
    this.checkExportTargets(node, { declaration, value, assigned, source });
    this.checkExportPlacement(node, { declaration, value, clause, source, assigned });
    this.checkDuplicateExports(node);
    if (source) {
      if (!isNamespaceBody(node.parent)) this.c.namespaces.checkReExport(clause, source);
      return;
    }
    if (clause) this.checkLocalExportClause(clause);
  }

  private checkExportTargets(
    node: TreeNode,
    {
      declaration,
      value,
      assigned,
      source,
    }: { declaration: TreeNode | null; value: TreeNode | null; assigned: TreeNode | undefined; source: TreeNode | null }
  ): void {
    if (value) {
      if (isInAmbientContext(node)) checkAmbientExportTarget(this.c, value);
      else this.c.expressions.check(value);
    }
    if (!declaration && !value && assigned && !source && !this.c.isModule && isAmbientModuleBody(node.parent)) {
      checkAmbientExportTarget(this.c, assigned);
    }
  }

  private checkLocalExportClause(clause: TreeNode): void {
    for (const specifier of named(clause)) {
      const name = specifier.childForFieldName('name');
      const scope = name && this.c.scopeOf(name);
      if (name && !scope?.lookupValue(name.text) && !scope?.lookupType(name.text))
        this.c.error(name, `名前 ${name.text} が見つかりません。`);
    }
  }

  private checkExportPlacement(
    node: TreeNode,
    {
      declaration,
      value,
      clause,
      source,
      assigned,
    }: {
      declaration: TreeNode | null;
      value: TreeNode | null;
      clause: TreeNode | undefined;
      source: TreeNode | null;
      assigned: TreeNode | undefined;
    }
  ): void {
    const inNamespace = isNamespaceBody(node.parent);
    if (this.c.isModule && isAmbientModuleBody(node.parent) && (!declaration || hasToken(node, 'default'))) {
      this.c.error(node, 'エクスポートとエクスポートの代入はモジュールの拡張では許可されていません。');
      return;
    }
    if (node.parent?.type !== 'program' && !isAmbientModuleBody(node.parent) && !inNamespace) {
      this.c.error(node, 'エクスポート宣言は、名前空間またはモジュールの最上位レベルでのみ使用できます。');
      return;
    }
    if (!declaration && !value && assigned && !source && !isAmbientModuleBody(node.parent)) {
      this.c.error(
        node,
        inNamespace
          ? 'エクスポートの代入は、名前空間では使用できません。'
          : "ECMAScript モジュールを対象にするときは、エクスポートの代入は使えません。'export default' か別のモジュール形式を使ってください。"
      );
      return;
    }
    if (inNamespace) this.checkNamespaceExportForm(node, clause, source);
  }

  private checkNamespaceExportForm(node: TreeNode, clause: TreeNode | undefined, source: TreeNode | null): void {
    if (hasToken(node, 'default'))
      this.c.error(node, '既定のエクスポートは、ECMAScript スタイルのモジュールでのみ使用できます。');
    else if ((clause && (!isAmbient(node) || source !== null)) || (!clause && source !== null))
      this.c.error(node, 'エクスポート宣言は名前空間でサポートされません。');
  }

  /**
   * Reports a name that the module exports more than once, as tsc does, where a default or an `export { ... }` name
   * takes part: declarations exported twice are reported as redeclarations, and a clause that names a type, enum,
   * or namespace exported by its declaration only at the clause.
   */
  private checkDuplicateExports(node: TreeNode): void {
    if (node.parent?.type !== 'program') return;
    const all = named(node.parent)
      .filter((child) => child.type === 'export_statement')
      .flatMap(exportedNames);
    for (const own of exportedNames(node)) {
      const others = all.filter((other) => other.name === own.name && other.site.id !== own.site.id);
      const message = duplicateExportMessage(own, others);
      if (message) this.c.error(own.site, message);
    }
  }

  /** `declare global` augments the globals only directly inside an external or ambient module. */
  private ambientDeclaration(node: TreeNode): void {
    const alreadyAmbient = this.reportRedundantAmbientModifier(node);
    const validContainer = isValidAmbientDeclarationContainer(node);
    for (const child of named(node)) {
      if (child.type === 'statement_block') {
        if (!isDirectGlobalAugmentationContainer(node, this.c.isModule))
          this.c.error(node, globalAugmentationPlacementMessage(node));
        else this.checkAmbientBodyStatements(child);
      } else if (isCheckedAmbientDeclaration(child)) {
        if (!alreadyAmbient && !validContainer && !isModuleOrNamespaceDeclaration(child))
          this.c.error(node, 'ここで修飾子を使用することはできません。');
        this.check(child);
      }
    }
  }

  private reportRedundantAmbientModifier(node: TreeNode): boolean {
    if (!isInAmbientContext(node)) return false;
    this.c.error(
      node,
      node.parent?.type === 'ambient_declaration'
        ? "'declare' 修飾子は既に存在します。"
        : "'declare' 修飾子は、環境コンテキストでは使用できません。"
    );
    return true;
  }

  checkAmbientBodyStatements(body: TreeNode): void {
    const valid: TreeNode[] = [];
    for (const child of named(body)) {
      if (isCheckedAmbientDeclaration(child)) valid.push(child);
      else this.c.error(child, 'ステートメントは環境コンテキストでは使用できません。');
    }
    this.checkBlockStatements(valid);
  }

  private throwStatement(node: TreeNode): void {
    const expression = named(node)[0];
    if (expression) this.c.expressions.check(expression);
    this.c.flow.current = undefined;
  }

  private breakStatement(node: TreeNode): void {
    const label = jumpLabel(node);
    const target =
      label === undefined
        ? this.jumpTargets.findLast((candidate) => candidate.isLoop || candidate.labels.length === 0)
        : this.jumpTargets.findLast((candidate) => candidate.labels.includes(label));
    target?.breaks.push(this.c.flow.current?.clone());
    this.c.flow.current = undefined;
  }

  private continueStatement(node: TreeNode): void {
    const label = jumpLabel(node);
    const target = this.jumpTargets.findLast(
      (candidate) => candidate.isLoop && (label === undefined || candidate.labels.includes(label))
    );
    target?.continues.push(this.c.flow.current?.clone());
    this.c.flow.current = undefined;
  }

  /** tsc rejects `with` in strict mode code, and leaves its body unchecked, as every name there has type `any`. */
  private withStatement(node: TreeNode): void {
    this.c.error(node, "'with' 文は Strict モードでは使えません。");
    this.c.error(
      node,
      "'with' 文はサポートされていません。'with' ブロック内のすべてのシンボルの型は 'any' になります。"
    );
  }

  /** A labeled loop takes its labels; any other labeled statement is a target that only `break` jumps out of. */
  private labeledStatement(node: TreeNode): void {
    const { labels, body } = labeledBody(node);
    if (!body) return;
    if (loopStatementTypes.has(body.type)) {
      this.pendingLabels.set(body.id, labels);
      this.checkSubstatement(body);
      return;
    }
    const target: JumpTarget = { isLoop: false, labels, breaks: [], continues: [] };
    this.jumpTargets.push(target);
    try {
      this.checkSubstatement(body);
    } finally {
      this.jumpTargets.pop();
    }
    this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.breaks]);
  }

  private typeAliasDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? this.c.scopeOf(node).lookupType(name) : undefined;
    this.c.signatures.typeParametersOf(node);
    if (symbol) this.c.typeNodes.declaredTypeOf(symbol);
    checkWrittenType(this.c, node.childForFieldName('value'));
    checkVarianceAnnotations(this.c, node);
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
    for (const child of named(node)) if (child.type === 'extends_type_clause') checkWrittenType(this.c, child);
    checkWrittenType(this.c, node.childForFieldName('body'));
    checkVarianceAnnotations(this.c, node);
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
    const type = this.c.typeNodes.declaredTypeOf(symbol);
    const receiver = type.kind === 'object' ? type.thisType : undefined;
    for (const baseNode of named(clause)) {
      const base = this.c.typeNodes.typeFromNode(baseNode);
      const mismatch = holdsTypeParameter(base)
        ? this.typeParameterBaseMismatch(symbol, base)
        : this.structuralBaseMismatch(body, structure, base, receiver);
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
  private structuralBaseMismatch(
    body: TreeNode,
    structure: Structure,
    base: Type,
    receiver?: Type
  ): string | undefined {
    if (isAnyLike(base) || (base.kind !== 'object' && base.kind !== 'intersection')) return undefined;
    return (
      this.propertyBaseMismatch(body, structure, base, receiver) ??
      baseIndexMismatch(this.c, structure, this.c.structureOf(base, receiver))
    );
  }

  /** Why a property an interface body declares does not fit the same property of a base, or `undefined` if none. */
  private propertyBaseMismatch(body: TreeNode, structure: Structure, base: Type, receiver?: Type): string | undefined {
    for (const property of structure.properties.values()) {
      if (property.declaration?.parent?.id !== body.id) continue;
      const baseProperty = this.c.propertyOf(base, property.name, receiver);
      if (
        baseProperty &&
        ((property.optional && !baseProperty.optional) ||
          !this.c.relations.isAssignable(propertyAccessType(property), propertyAccessType(baseProperty)))
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
      checkWrittenType(this.c, declarator.childForFieldName('type'));
      const nameNode = declarator.childForFieldName('name') as TreeNode;
      if (isAmbient(declarator))
        checkAmbientInitializer(this.c, declarator, kind === 'const' && nameNode.type === 'identifier');
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
    const valueType = this.c.expressions.checkAssignedValue(value, annotation);
    if (annotation) this.c.expressions.checkAssignable(nameNode, valueType, annotation, value);
    if (!annotation && isDirectEmptyArray(value)) {
      // `const a = []` evolves as elements are pushed.
      this.c.expressions.setVariableType(symbol, this.c.arrayType(anyType));
      this.c.flow.set(key, { type: this.c.arrayType(neverType), assigned: true, evolving: true });
      return;
    }
    const isConst = kind === 'const';
    const declared = annotation ?? this.c.literals.widenDeclared(valueType, isConst);
    const type =
      !annotation && isConst ? this.c.expressions.expandos.constType(declarator, symbol, declared) : declared;
    this.c.expressions.setVariableType(symbol, this.c.assignments.isAutoTyped(symbol) ? anyType : type);
    // A `let` starts as the members of its declared type that its initializer can be, as tsc reduces it.
    const isReduced =
      annotation !== undefined || valueType.kind === 'literal' || (valueType.kind === 'union' && !isConst);
    const flowType = isReduced ? this.c.flow.assignmentReduced(type, valueType) : type;
    this.c.flow.set(key, { type: flowType, assigned: true });
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
    this.c.assignments.assignReference(declarator.childForFieldName('name') as TreeNode, declared, valueType);
  }

  private uninitializedVariable(declarator: TreeNode, symbol: Sym, kind: string, annotation: Type | undefined): void {
    if (kind === 'const') return;
    const key = `s${symbol.id}`;
    if (!annotation) {
      this.c.expressions.setVariableType(symbol, anyType);
      if (!this.c.assignments.isAutoTyped(symbol)) {
        const name = declarator.childForFieldName('name') as TreeNode;
        this.c.error(name, `変数 ${symbol.name} の型が暗黙に any になります。`);
        return;
      }
      // `let x;` follows the types assigned to it, starting as `undefined`.
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
    const implied = annotation ? undefined : this.c.patterns.impliedBindingType(pattern, isConst);
    const valueType = value ? this.c.expressions.check(value, annotation ?? implied) : (annotation ?? anyType);
    if (annotation && value) this.c.expressions.checkAssignable(pattern, valueType, annotation);
    const sourceType = annotation ?? valueType;
    if (isConst) this.c.patterns.correlatedSources.set(pattern.id, sourceType);
    this.c.patterns.bindPattern(
      pattern,
      sourceType,
      (identifier, type, assigned = type) => {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (!symbol) return;
        const declared = this.c.literals.widenDeclared(type, isConst);
        this.c.expressions.setVariableType(symbol, declared);
        this.c.flow.set(`s${symbol.id}`, { type: this.c.flow.assignmentReduced(declared, assigned), assigned: true });
      },
      { annotated: annotation !== undefined, isConst },
      annotation && value && valueType !== annotation ? valueType : undefined
    );
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
      if (!value || this.c.assignments.isAutoTyped(symbol, declaration)) return anyType;
      if (isDirectEmptyArray(value)) return this.c.arrayType(anyType);
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
      (value ? this.c.expressions.check(value, this.c.patterns.impliedBindingType(nameNode, isConst)) : anyType);
    const type = this.c.patterns.patternType(nameNode, source, symbol, { isConst, annotated: !!annotation });
    return this.c.literals.widenDeclared(type, isConst);
  }

  private loopVariableType(node: TreeNode, symbol: Sym): Type {
    const header = node.childForFieldName('header') ?? node;
    const right = header.childForFieldName('right') as TreeNode;
    const left = header.childForFieldName('left') as TreeNode;
    const isOf = header.childForFieldName('operator')?.text === 'of';
    const isConst = header.childForFieldName('kind')?.text === 'const';
    const rightType = this.c.expressions.check(right);
    const elementType = isOf ? this.iteratedLoopType(node, right, rightType, false) : stringType;
    if (left.type === 'identifier') return elementType;
    return this.c.patterns.patternType(left, elementType, symbol, {
      isConst,
      literalSource: isOf ? right : undefined,
    });
  }

  // Control flow -------------------------------------------------------------------------------------------------

  private ifStatement(node: TreeNode): void {
    const condition = node.childForFieldName('condition') as TreeNode;
    const consequence = node.childForFieldName('consequence') as TreeNode;
    const { whenTrue, whenFalse } = this.c.conditions.checkCondition(condition, consequence);
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
    this.c.flow.current = new FlowState(undefined, undefined, true, 'after');
    this.check(node);
    this.c.flow.current = undefined;
  }

  /**
   * Checks a loop: silently while the types its back edges bring change, then once reporting errors.
   *
   * @param iterate Runs one iteration from the current state and returns the state where the loop exits from it.
   */
  private loop(node: TreeNode, iterate: (target: JumpTarget) => State): void {
    const labels = this.pendingLabels.get(node.id) ?? [];
    this.pendingLabels.delete(node.id);
    const entry = this.c.flow.current;
    let stateKey = this.stateKey(entry);
    // An enclosing loop's silent passes check this loop once each; the same entry state leaves it the same way.
    const key = this.c.silent > 0 ? `${node.id}:${stateKey}` : undefined;
    const known = key === undefined ? undefined : this.silentLoopExits.get(key);
    if (known) {
      this.c.flow.current = this.c.flow.merge(known);
      return;
    }
    let state = entry?.clone();
    let settled: State[] | undefined;
    for (let pass = 1; ; pass++) {
      const { exits, backEdge } = this.c.silently(() => this.loopPass(state, iterate, labels));
      const next = this.c.flow.merge([entry, backEdge]);
      const nextKey = this.stateKey(next);
      if (nextKey === stateKey) {
        settled = exits;
        break;
      }
      if (pass === MAX_LOOP_PASSES) {
        state = widenTouched(next, state, backEdge);
        break;
      }
      state = next;
      stateKey = nextKey;
    }
    // Checking silently already, the pass that settled the loop is the one that would report errors.
    const exits = settled && this.c.silent > 0 ? settled : this.loopPass(state, iterate, labels).exits;
    if (key !== undefined) this.silentLoopExits.set(key, exits);
    this.c.flow.current = this.c.flow.merge(exits);
  }

  /** Runs a loop's iteration once from `state`, and returns where it exits and the state its back edge brings. */
  private loopPass(
    state: State,
    iterate: (target: JumpTarget) => State,
    labels: string[]
  ): { exits: State[]; backEdge: State } {
    const target: JumpTarget = { isLoop: true, labels, breaks: [], continues: [] };
    this.c.flow.current = state?.clone();
    this.jumpTargets.push(target);
    try {
      const exit = iterate(target);
      return { exits: [exit, ...target.breaks], backEdge: this.c.flow.current };
    } finally {
      this.jumpTargets.pop();
    }
  }

  private stateKey(state: State): string {
    if (!state) return '-';
    const entries = [...state.entries].map(([reference, { type, writeType, assigned, constraint, evolving }]) =>
      JSON.stringify([reference, type.id, writeType?.id, assigned, constraint?.id, evolving === true])
    );
    return JSON.stringify([entries.toSorted(), [...state.assignedFields].toSorted(), state.superCalled, state.dead]);
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
      return whenFalse;
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
      return whenFalse;
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
        whenFalse = result.whenFalse;
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

  private forInStatement(node: TreeNode): void {
    const header = node.childForFieldName('header') ?? node;
    const left = header.childForFieldName('left') as TreeNode;
    const right = header.childForFieldName('right') as TreeNode;
    const isOf = header.childForFieldName('operator')?.text === 'of';
    const kind = header.childForFieldName('kind')?.text;
    const rightType = this.c.expressions.check(right);
    if (hasToken(node, 'await')) checkAwaitPlace(this.c, node, true);
    const elementType = this.loopElementType(node, rightType);
    if (!isOf) this.forInObjectTypes.set(node.id, rightType);
    const body = node.childForFieldName('body') as TreeNode;
    this.loop(node, (target) => {
      const head = this.c.flow.current?.clone();
      if (kind) this.bindLoopVariables(left, kind, elementType, isOf ? right : undefined);
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
      ? this.iteratedLoopType(node, right, rightType, true)
      : this.forInKeyType(right, rightType);
  }

  private iteratedLoopType(loop: TreeNode, right: TreeNode, rightType: Type, reportErrors: boolean): Type {
    const element = hasToken(loop, 'await')
      ? this.c.patterns.asyncIteratedType(reportErrors ? right : undefined, rightType, 'loop')
      : this.c.patterns.iteratedType(reportErrors ? right : undefined, rightType, 'loop');
    return this.c.literals.inlineBindingType(element, right);
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

  /**
   * The type of the keys a `for...in` loop takes, reporting an object that is a primitive: `Extract<keyof T, string>`
   * for a generic object `T`, as it can index `T`, and `string` otherwise.
   */
  private forInKeyType(right: TreeNode, rightType: Type): Type {
    const object = filterType(
      regularOf(rightType),
      (member) => !isIntrinsic(member, 'null') && !isIntrinsic(member, 'undefined')
    );
    if (isIntrinsic(object, 'never') || !canEnumerateKeys(object)) {
      this.c.error(
        right,
        'for...in 文の右辺は、any 型、オブジェクト型、型パラメーターのいずれかでなければいけません。'
      );
    }
    const keys = this.genericKeys(object);
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
  private bindLoopVariables(left: TreeNode, kind: string, elementType: Type, literalSource?: TreeNode): void {
    const isConst = kind === 'const';
    this.c.patterns.bindPattern(
      left,
      elementType,
      (identifier, type) => {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (!symbol) return;
        this.c.expressions.setVariableType(symbol, isConst ? type : this.c.widen(type));
        this.c.flow.set(`s${symbol.id}`, { type, assigned: true });
      },
      { isConst, literalSource }
    );
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
    const { caseEntries, noMatch, exhaustive } = this.switchCaseEntries(discriminant, cases);
    const target: JumpTarget = { isLoop: false, labels: [], breaks: [], continues: [] };
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
    const bypass = cases.some((caseNode) => caseNode.type === 'switch_default') ? undefined : noMatch?.clone();
    if (bypass && exhaustive) bypass.dead = 'switchEnd';
    this.c.flow.current = this.c.flow.merge([fallthrough, ...target.breaks, bypass]);
  }

  /** The state each case is entered in where its test matches (undefined for the default), and where none does. */
  private switchCaseEntries(
    discriminant: TreeNode,
    cases: TreeNode[]
  ): { caseEntries: State[]; noMatch: State; exhaustive: boolean } {
    const operand = typeofOperand(discriminant);
    const observed = new Map<number, Type | undefined>(operand ? [[operand.id, undefined]] : []);
    const discriminantType = this.c.expressions.observeTypes(observed, () => this.c.expressions.check(discriminant));
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
    const exhaustive = operand
      ? this.exhaustiveTypeofSwitch(operand, observed.get(operand.id), cases)
      : this.exhaustiveLiteralSwitch(discriminantType, caseTypes);
    return { caseEntries, noMatch, exhaustive };
  }

  private exhaustiveLiteralSwitch(discriminant: Type, cases: Type[]): boolean {
    if (cases.length === 0 || !cases.every(isSwitchUnitOrNever)) return false;
    const covered = new Set(cases.map((type) => regularOf(type).id));
    return typeMembers(this.c.baseConstraint(discriminant)).every(
      (type) => isSwitchUnit(type) && covered.has(regularOf(type).id)
    );
  }

  private exhaustiveTypeofSwitch(operand: TreeNode, type: Type | undefined, cases: TreeNode[]): boolean {
    const names = new Set<string>();
    for (const clause of cases) {
      const test = clause.childForFieldName('value');
      if (!test || (test.type !== 'string' && test.type !== 'template_string')) return false;
      const name = literalTypeofName(test);
      if (name === undefined) return false;
      names.add(name);
    }
    let remaining = this.c.baseConstraint(
      type ?? this.c.flow.probe(() => this.c.silently(() => this.c.expressions.check(operand)))
    );
    if (isAnyLike(remaining) || isIntrinsic(remaining, 'unknown')) return typeofNames.every((name) => names.has(name));
    for (const name of names) remaining = this.c.flow.narrowByTypeof(remaining, name, false);
    return isIntrinsic(remaining, 'never');
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
    const returnStates = finalizer ? this.c.functions.contexts.at(-1)?.returnStates : undefined;
    const returnStart = returnStates?.length ?? 0;
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
    const returned = returnStates?.splice(returnStart) ?? [];
    this.checkFinally(finalizer, [passed, tryEnd, catchPassed, catchEnd], after, returned, returnStates);
  }

  private checkFinally(
    finalizer: TreeNode,
    entries: State[],
    normal: State,
    returned: State[],
    returnStates: State[] | undefined
  ): void {
    this.c.flow.current = this.c.flow.merge([...entries, ...returned]);
    const body = finalizer.childForFieldName('body') ?? named(finalizer)[0];
    if (body) this.checkBlockStatements(named(body));
    this.c.flow.exceptions.include(this.c.flow.current);
    if (!this.c.flow.isReachable) return;
    const continuations = returned.map((state) => this.flowAfterFinally(body, state));
    returnStates?.push(...continuations.filter((state) => state !== undefined));
    this.c.flow.current = this.flowAfterFinally(body, normal);
  }

  private flowAfterFinally(body: TreeNode | undefined, entry: State): State {
    if (!body || !entry) return entry;
    const fn = this.c.functions.contexts.at(-1);
    const exits: unknown[][] = this.jumpTargets.flatMap((target) => [target.breaks, target.continues]);
    if (fn) exits.push(fn.returnStates, fn.returnTypes);
    const lengths = exits.map((states) => states.length);
    try {
      return this.c.flow.from(entry, () => this.c.silently(() => this.checkBlockStatements(named(body))));
    } finally {
      // The joined diagnostic pass already collected exits from the finalizer's own statements.
      for (const [index, states] of exits.entries()) states.length = lengths[index];
    }
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
      this.c.error(node, "'return' ステートメントは、関数本体でのみ使用できます。");
      if (expression) this.c.expressions.check(expression);
      this.c.flow.current = undefined;
      return;
    }
    if (expression) {
      const declared = context.isConstructor ? this.constructorInstanceType(context.node) : context.declaredReturn;
      context.inReturn = true;
      const type = this.returnedType(node, expression, context, declared);
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

  /** The type a `return` gives, where an async function returns what a promise it returns fulfills with. */
  private returnedType(
    returnNode: TreeNode,
    expression: TreeNode,
    context: FunctionContext,
    declared: Type | undefined
  ): Type {
    const contextual = this.c.functions.returnExpressionContext(context, declared ?? context.contextualReturn);
    const checked = this.c.expressions.check(expression, contextual);
    return context.isAsync ? this.c.functions.awaitedReturnExpression(returnNode, checked, context) : checked;
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
    assert(classNode, 'The constructor is outside a class');
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

function canEnumerateKeys(type: Type): boolean {
  if (type.kind === 'union') return type.types.every(canEnumerateKeys);
  if (type.kind === 'intersection') return type.types.some(canEnumerateKeys);
  return (
    isAnyLike(type) ||
    isIntrinsic(type, 'object') ||
    ['object', 'typeParameter', 'indexedAccess', 'conditional'].includes(type.kind)
  );
}

function typeofOperand(node: TreeNode): TreeNode | undefined {
  return node.type === 'unary_expression' && node.childForFieldName('operator')?.text === 'typeof'
    ? (node.childForFieldName('argument') ?? undefined)
    : undefined;
}

function isSwitchUnitOrNever(type: Type): boolean {
  return isSwitchUnit(type) || isIntrinsic(type, 'never');
}

function isSwitchUnit(type: Type): boolean {
  return isUnit(type) && !isIntrinsic(type, 'void');
}

const typeofNames = ['string', 'number', 'bigint', 'boolean', 'symbol', 'undefined', 'object', 'function'];

function literalTypeofName(node: TreeNode): string | undefined {
  if (node.type === 'string') return stringValue(node);
  const parts = named(node);
  if (parts.some((part) => part.type === 'template_substitution')) return undefined;
  return parts.map((part) => templateFragmentText(part)).join('');
}

/** The declarations whose own row tsc reports when an `export { ... }` exports their name again. */
const valueDeclarationTypes = new Set([
  'lexical_declaration',
  'variable_declaration',
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
]);

function duplicateExportMessage(
  own: { name: string; site: TreeNode; declaration?: TreeNode },
  others: { name: string; site: TreeNode; declaration?: TreeNode }[]
): string | undefined {
  if (others.length === 0 || (own.declaration && others.every((other) => other.declaration))) return undefined;
  if (own.declaration && !valueDeclarationTypes.has(own.declaration.type)) return undefined;
  if (own.name === 'default') return 'モジュールに複数の既定のエクスポートを含めることはできません。';
  return own.declaration || others.some((other) => other.declaration)
    ? `エクスポートされた変数 '${own.name}' を再宣言することはできません。`
    : `識別子 '${own.name}' が重複しています。`;
}

export function globalAugmentationPlacementMessage(node: TreeNode): string {
  const owner = node.parent?.type === 'statement_block' ? node.parent.parent : undefined;
  return node.parent?.type === 'program' || owner?.type === 'internal_module' || owner?.type === 'module'
    ? 'グローバルスコープの拡張は、外部モジュールかアンビエントモジュールの宣言の中に直接書くことしかできません。'
    : 'アンビエント モジュール宣言は、ファイルの最上位にのみ使用できます。';
}

function isValidAmbientDeclarationContainer(node: TreeNode): boolean {
  const container = node.parent?.type === 'export_statement' ? node.parent.parent : node.parent;
  return (
    container?.type === 'program' ||
    isNamespaceBody(container) ||
    isAmbientModuleBody(container) ||
    (container?.type === 'statement_block' && isAmbient(container))
  );
}

function isModuleOrNamespaceDeclaration(node: TreeNode): boolean {
  const inner = node.type === 'expression_statement' ? named(node)[0] : node;
  return inner?.type === 'internal_module' || inner?.type === 'module';
}

function isInAmbientContext(node: TreeNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'ambient_declaration') return true;
    if (
      (current.type === 'module' || current.type === 'internal_module') &&
      current.childForFieldName('name')?.type === 'string'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The names an export statement exports, with the node naming each and the declaration declaring it, if any. An
 * overload signature exports nothing of its own: its implementation exports the name.
 */
function exportedNames(node: TreeNode): { name: string; site: TreeNode; declaration?: TreeNode }[] {
  const declaration = node.childForFieldName('declaration');
  if (node.childForFieldName('source') || declaration?.type === 'function_signature') return [];
  if (node.children.some((child) => child?.type === 'default'))
    return [{ name: 'default', site: node.childForFieldName('value') ?? declaration ?? node }];
  if (declaration) return declaredNames(declaration).map((name) => ({ name: name.text, site: name, declaration }));
  const clause = named(node).find((child) => child.type === 'export_clause');
  return (clause ? named(clause) : []).flatMap((specifier) => {
    const exported = specifier.childForFieldName('alias') ?? specifier.childForFieldName('name');
    return exported ? [{ name: exported.text, site: exported }] : [];
  });
}
