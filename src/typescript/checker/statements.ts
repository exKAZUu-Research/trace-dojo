// code-gauge-allow-file fileNcss 518 -- Follows the flow of control through each kind of statement.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { FlowState, type State } from './flow';
import type { Scope, Sym } from './scopes';
import { arrayPatternElements, hasToken, isNumericName, named, skipParentheses } from './syntax';
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
  unionOf,
} from './types';

interface JumpTarget {
  isLoop: boolean;
  breaks: State[];
  continues: State[];
}

/** How many times a loop body is checked silently, at most, to find the types its back edges bring. */
const MAX_LOOP_PASSES = 3;

/** Checks statements, following the flow of control through them. */
export class StatementChecker {
  /** Where each loop checked silently exits, by the loop and its entry state. */
  private readonly silentLoopExits = new Map<string, State[]>();
  private readonly jumpTargets: JumpTarget[] = [];
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

  /** Checks statements in order, calling `afterEach` with the state after each one that is reached. */
  checkBlockStatements(statements: TreeNode[], afterEach?: (state: State) => void): void {
    for (const statement of statements) {
      if (!this.c.flow.isReachable) {
        // Unreachable code is still checked, with what its declarations say.
        this.c.flow.current = new FlowState();
        this.check(statement);
        this.c.flow.current = undefined;
        continue;
      }
      this.check(statement);
      afterEach?.(this.c.flow.current?.clone());
    }
  }

  private check(node: TreeNode): void {
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
  // code-gauge-allow functionCognitiveComplexity 17 -- Walks type references and object types while keeping qualified namespace references intact for availability checks.
  private resolveTypesIn(node: TreeNode | null): void {
    if (!node) return;
    const visit = (current: TreeNode): void => {
      if (current.type === 'nested_type_identifier') {
        this.c.typeNodes.typeFromNode(current);
        return;
      }
      if (current.type === 'type_identifier' || current.type === 'generic_type') {
        const parent = current.parent;
        if (
          parent?.type !== 'generic_type' &&
          parent?.type !== 'type_parameter' &&
          parent?.type !== 'mapped_type_clause' &&
          parent?.type !== 'infer_type'
        ) {
          this.c.typeNodes.typeFromNode(current);
        }
      }
      if (current.type === 'object_type') {
        const type = this.c.typeNodes.typeFromNode(current);
        if (type.kind === 'object') this.checkIndexConformance(type.resolve(), current);
      }
      for (const child of named(current)) visit(child);
    };
    visit(node);
  }

  private interfaceDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? this.c.scopeOf(node).lookupType(name) : undefined;
    if (!symbol) return;
    this.c.signatures.typeParametersOf(node);
    const type = this.c.typeNodes.declaredTypeOf(symbol);
    if (type.kind === 'object') {
      const structure = type.resolve();
      for (const property of structure.properties.values()) property.type();
      for (const signature of structure.callSignatures) signature.returnType();
      this.checkIndexConformance(structure, node.childForFieldName('body') ?? node);
      this.checkInterfaceBases(node, structure);
    }
    for (const child of named(node)) if (child.type === 'extends_type_clause') this.resolveTypesIn(child);
    this.resolveTypesIn(node.childForFieldName('body'));
  }

  /** Reports a property of an interface that does not fit the same property of an interface it extends. */
  // code-gauge-allow functionCognitiveComplexity 19 -- Checks both optionality and value-type compatibility for each interface member redeclared from a base.
  private checkInterfaceBases(node: TreeNode, structure: Structure): void {
    const body = node.childForFieldName('body');
    const clause = named(node).find((child) => child.type === 'extends_type_clause');
    if (!body || !clause) return;
    for (const baseNode of named(clause)) {
      const base = this.c.typeNodes.typeFromNode(baseNode);
      if (isAnyLike(base) || (base.kind !== 'object' && base.kind !== 'intersection')) continue;
      for (const property of structure.properties.values()) {
        const declaration = property.declaration;
        if (!declaration || declaration.parent?.id !== body.id) continue;
        const baseProperty = this.c.propertyOf(base, property.name);
        if (
          !baseProperty ||
          ((!property.optional || baseProperty.optional) &&
            this.c.relations.isAssignable(property.type(), baseProperty.type()))
        )
          continue;
        this.c.error(
          node.childForFieldName('name') ?? node,
          `インターフェース '${node.childForFieldName('name')?.text}' は、'${this.c.print(base)}' を正しく継承していません。プロパティ '${property.name}' の型が合いません。`
        );
        return;
      }
    }
  }

  /**
   * Reports properties that an index signature of the same type does not allow, and a number index that does not fit
   * the string index. A property inherited from elsewhere is reported at the index signature of `owner`, the body
   * declaring the type.
   */
  // code-gauge-allow functionCognitiveComplexity 21 -- Follows TypeScript's checks of properties and number indexes against index signatures.
  checkIndexConformance(structure: Structure, owner?: TreeNode): void {
    for (const property of structure.properties.values()) {
      const nameNode = property.declaration?.childForFieldName('name');
      if (!nameNode || !property.declaration || this.c.isLibrary(property.declaration)) continue;
      const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      const inherited = owner !== undefined && !isWithin(property.declaration, owner);
      for (const [index, kind] of [
        [structure.stringIndex, 'string'],
        [isNumericName(property.name) ? structure.numberIndex : undefined, 'number'],
      ] as const) {
        if (index && !this.c.relations.isAssignable(type, index.type)) {
          this.c.error(
            (inherited && owner && indexSignatureNode(owner, kind)) || nameNode,
            `型 '${this.c.print(type)}' のプロパティ '${property.name}' は、'${kind}' のインデックスの型 '${this.c.print(index.type)}' に代入できません。`
          );
        }
      }
    }
    const { stringIndex, numberIndex } = structure;
    const numberNode = owner && indexSignatureNode(owner, 'number');
    if (
      stringIndex &&
      numberIndex &&
      numberNode &&
      !this.c.relations.isAssignable(numberIndex.type, stringIndex.type)
    ) {
      this.c.error(
        numberNode,
        `'number' のインデックスの型 '${this.c.print(numberIndex.type)}' は、'string' のインデックスの型 '${this.c.print(stringIndex.type)}' に代入できません。`
      );
    }
  }

  // Declarations -------------------------------------------------------------------------------------------------

  private declaration(node: TreeNode): void {
    const kind = node.type === 'variable_declaration' ? 'var' : (node.childForFieldName('kind')?.text ?? 'let');
    for (const declarator of named(node)) {
      if (declarator.type !== 'variable_declarator') continue;
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
    if (!value) {
      this.uninitializedVariable(declarator, symbol, kind, annotation);
      return;
    }
    const key = `s${symbol.id}`;
    const valueType = this.c.expressions.check(value, annotation);
    if (annotation) {
      this.c.expressions.checkAssignable(nameNode, valueType, annotation);
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
      isIntrinsic(declared, 'null') || isIntrinsic(declared, 'undefined') ? (isConst ? declared : anyType) : declared;
    this.c.expressions.setVariableType(symbol, widened);
    this.c.flow.set(key, { type: isConst ? widened : widened === anyType ? declared : widened, assigned: true });
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
    // A `var` declared again keeps what it holds.
    if (kind === 'var' && this.c.flow.entry(key)) return;
    this.c.flow.set(key, { type: annotation, assigned: hasToken(declarator, '!') });
  }

  private patternDeclarator(declarator: TreeNode, pattern: TreeNode, isConst: boolean): void {
    const value = declarator.childForFieldName('value');
    const annotation = this.c.typeNodes.annotationType(declarator.childForFieldName('type'));
    const valueType = value
      ? this.c.expressions.check(value, annotation ?? this.arrayPatternContext(pattern))
      : (annotation ?? anyType);
    if (annotation && value) this.c.expressions.checkAssignable(pattern, valueType, annotation);
    const sourceType = annotation ?? this.c.literals.widenDeclared(valueType, false);
    this.c.patterns.bindPattern(pattern, sourceType, (identifier, type) => {
      const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
      if (!symbol) return;
      const declared = this.c.literals.widenDeclared(type, isConst);
      this.c.expressions.setVariableType(symbol, declared);
      this.c.flow.set(`s${symbol.id}`, { type: declared, assigned: true });
    });
  }

  /** The tuple an array pattern implies for the array literal it takes apart, so that each element keeps its type. */
  private arrayPatternContext(pattern: TreeNode): Type | undefined {
    if (pattern.type !== 'array_pattern') return undefined;
    return this.c.tupleType(
      arrayPatternElements(pattern).map(({ element }) =>
        element.type === 'rest_pattern'
          ? { type: this.c.arrayType(anyType), optional: false, rest: true }
          : { type: anyType, optional: false, rest: false }
      )
    );
  }

  private isEmptyArrayLiteral(node: TreeNode): boolean {
    const expression = skipParentheses(node);
    return expression.type === 'array' && named(expression).length === 0;
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
      annotation ?? (value ? this.c.literals.widenDeclared(this.c.expressions.check(value), false) : anyType);
    return this.c.literals.widenDeclared(this.c.patterns.patternType(nameNode, source, symbol.name), isConst);
  }

  private loopVariableType(node: TreeNode, symbol: Sym): Type {
    const header = node.childForFieldName('header') ?? node;
    const right = header.childForFieldName('right') as TreeNode;
    const left = header.childForFieldName('left') as TreeNode;
    const isOf = header.childForFieldName('operator')?.text === 'of';
    const rightType = this.c.expressions.check(right);
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
      this.c.flow.current = new FlowState();
      this.check(node);
      this.c.flow.current = undefined;
      return;
    }
    this.check(node);
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
    let last: { exit: State; breaks: State[] } | undefined;
    for (let pass = 0; pass < MAX_LOOP_PASSES; pass++) {
      const target: JumpTarget = { isLoop: true, breaks: [], continues: [] };
      let backEdge: State;
      let exit: State;
      this.c.silently(() => {
        this.c.flow.current = state?.clone();
        this.jumpTargets.push(target);
        try {
          exit = iterate(target);
          backEdge = this.c.flow.current;
        } finally {
          this.jumpTargets.pop();
        }
      });
      const next = this.c.flow.merge([entry, backEdge!]);
      if (this.sameState(next, state)) {
        last = { exit: exit!, breaks: target.breaks };
        break;
      }
      state = next;
    }
    // Checking silently already, the pass that settled the loop is the one that would report errors.
    const exits = last && this.c.silent > 0 ? [last.exit, ...last.breaks] : this.finalPass(state, iterate);
    if (key !== undefined) this.silentLoopExits.set(key, exits);
    this.c.flow.current = this.c.flow.merge(exits);
  }

  /** Runs a loop's iteration once more from its settled state, reporting errors, and returns where it exits. */
  private finalPass(state: State, iterate: (target: JumpTarget) => State): State[] {
    const target: JumpTarget = { isLoop: true, breaks: [], continues: [] };
    this.c.flow.current = state;
    this.jumpTargets.push(target);
    try {
      return [iterate(target), ...target.breaks];
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
    return `${entries.toSorted().join(',')}|${[...state.assignedFields].toSorted().join(',')}`;
  }

  private sameState(a: State, b: State): boolean {
    if (!a || !b) return a === b;
    if (a.entries.size !== b.entries.size) return false;
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
    const rightType = this.c.expressions.check(right);
    const elementType = isOf ? this.c.patterns.iteratedType(right, rightType) : this.forInKeyType(right, rightType);
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

  /** The type of the keys a `for...in` loop takes, reporting an object that is a primitive. */
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
    return stringType;
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

  // code-gauge-allow functionNcss 47 -- Follows the flow through the cases, fall-through, and an exhaustive end in one pass.
  // code-gauge-allow functionCognitiveComplexity 20 -- Follows the flow through the cases, fall-through, `switch (true)`, and an exhaustive end in one pass.
  private switchStatement(node: TreeNode): void {
    const value = node.childForFieldName('value') as TreeNode;
    const discriminant = skipParentheses(value);
    const discriminantType = this.c.expressions.check(discriminant);
    const body = node.childForFieldName('body') as TreeNode;
    const cases = named(body).filter((child) => child.type === 'switch_case' || child.type === 'switch_default');
    const entry = this.c.flow.current;
    const target: JumpTarget = { isLoop: false, breaks: [], continues: [] };
    this.jumpTargets.push(target);
    let fallthrough: State;
    const caseTypes: Type[] = [];
    let hasDefault = false;
    // `switch (true)` enters a case where its test is true, and the default where every test is false.
    const testsConditions = discriminant.type === 'true';
    let allFalse = entry;
    try {
      for (const caseNode of cases) {
        let caseEntry: State;
        if (caseNode.type === 'switch_case') {
          this.c.flow.current = entry?.clone();
          const test = caseNode.childForFieldName('value') as TreeNode;
          const testType = this.checkCaseTest(test, discriminantType);
          caseTypes.push(testType);
          if (testsConditions) {
            const outer = this.c.flow.current;
            this.c.flow.current = allFalse?.clone();
            const { whenTrue, whenFalse } = this.c.silently(() => this.c.conditions.checkCondition(test));
            this.c.flow.current = outer;
            caseEntry = whenTrue;
            allFalse = whenFalse;
          } else {
            caseEntry = this.c.conditions.narrowSwitchCase(discriminant, entry, [testType], true);
          }
        } else {
          hasDefault = true;
          caseEntry = testsConditions
            ? allFalse
            : this.c.conditions.narrowSwitchCase(discriminant, entry, caseTypes, false);
        }
        this.c.flow.current = this.c.flow.merge([caseEntry, fallthrough]);
        const statements = caseNode
          .childrenForFieldName('body')
          .filter((child) => child.isNamed && child.type !== 'comment');
        this.checkBlockStatements(statements);
        fallthrough = this.c.flow.current;
      }
    } finally {
      this.jumpTargets.pop();
    }
    let noMatch = hasDefault
      ? undefined
      : testsConditions
        ? allFalse
        : this.c.conditions.narrowSwitchCase(discriminant, entry, caseTypes, false);
    // Cases that cover every value of the discriminant leave no path past the switch, as `default` would.
    if (noMatch && this.c.flow.referenceKey(discriminant)) {
      let remaining: Type = neverType;
      this.c.flow.from(noMatch, () => {
        remaining = this.c.expressions.checkReferenceSilently(discriminant);
      });
      if (isIntrinsic(remaining, 'never')) noMatch = undefined;
    }
    this.c.flow.current = this.c.flow.merge([fallthrough!, ...target.breaks, noMatch]);
  }

  /** Checks a `case` test, reporting one that cannot equal the discriminant, and returns its type. */
  private checkCaseTest(test: TreeNode, discriminantType: Type): Type {
    const testType = this.c.expressions.check(test);
    if (
      !isAnyLike(discriminantType) &&
      !isAnyLike(testType) &&
      !this.c.relations.isComparable(regularOf(discriminantType), regularOf(testType))
    ) {
      this.c.error(
        test,
        `型 '${this.c.print(regularOf(testType))}' は型 '${this.c.print(regularOf(discriminantType))}' と比べられません。`
      );
    }
    return regularOf(testType);
  }

  private tryStatement(node: TreeNode): void {
    const body = node.childForFieldName('body') as TreeNode;
    const handler = node.childForFieldName('handler');
    const finalizer = node.childForFieldName('finalizer');
    // The try block changes the current state in place, while the catch block starts from any state the try block
    // passed through, as an exception may leave it after any statement.
    const entry = this.c.flow.current?.clone();
    const passed: State[] = [entry];
    this.checkBlockStatements(named(body), (state) => passed.push(state));
    const tryEnd = this.c.flow.current;
    let catchEnd: State;
    if (handler) {
      this.c.flow.current = this.c.flow.merge([...passed, tryEnd]);
      this.bindCatchParameter(handler);
      const handlerBody = handler.childForFieldName('body') as TreeNode;
      this.checkBlockStatements(named(handlerBody));
      catchEnd = this.c.flow.current;
    }
    const after = handler ? this.c.flow.merge([tryEnd, catchEnd!]) : tryEnd;
    if (finalizer) {
      this.c.flow.current = this.c.flow.merge([entry, tryEnd, handler ? catchEnd! : undefined]);
      const finalBody = finalizer.childForFieldName('body') ?? named(finalizer)[0];
      if (finalBody) this.checkBlockStatements(named(finalBody));
      if (!this.c.flow.isReachable) return;
      // Past the statement, the finally block ran after the try or catch block completed normally.
      this.c.flow.current = after;
      if (finalBody && after) this.c.silently(() => this.checkBlockStatements(named(finalBody)));
      return;
    }
    this.c.flow.current = after;
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
      this.c.patterns.bindPattern(parameter, annotation ?? anyType, (identifier, type) => {
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
    context.hasReturn = true;
    if (expression) {
      const declared = context.declaredReturn;
      context.inReturn = true;
      const type = this.c.expressions.check(expression, declared ?? context.contextualReturn);
      context.inReturn = false;
      if (declared && !context.isConstructor) this.c.expressions.checkReturnValue(expression, type, declared);
      context.returnTypes.push(type);
      context.hasReturnWithValue = true;
    } else if (context.declaredReturn && !context.isConstructor) {
      const declared = context.declaredReturn;
      if (
        !isAnyLike(declared) &&
        !isIntrinsic(declared, 'void') &&
        !this.c.relations.isAssignable(undefinedType, declared)
      ) {
        this.c.expressions.reportNotAssignable(node, undefinedType, declared);
      }
    }
    context.returnStates.push(this.c.flow.current?.clone());
    this.c.flow.current = undefined;
  }
}

function isWithin(node: TreeNode, ancestor: TreeNode): boolean {
  for (let current: TreeNode | null = node; current; current = current.parent)
    if (current.id === ancestor.id) return true;
  return false;
}

/** The index signature for `string` or `number` keys that a type's body declares. */
function indexSignatureNode(body: TreeNode, kind: 'string' | 'number'): TreeNode | undefined {
  return named(body).find(
    (member) => member.type === 'index_signature' && new RegExp(`^\\[\\s*\\w+\\s*:\\s*${kind}\\b`).test(member.text)
  );
}
