import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { FunctionContext } from './expressions';
import { FlowState, type State } from './flow';
import type { Sym } from './scopes';
import { hasToken, named, patternIdentifiers, skipParentheses } from './syntax';
import {
  anyType,
  errorType,
  isAnyLike,
  isIntrinsic,
  neverType,
  regularOf,
  type Signature,
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
  private readonly jumpTargets: JumpTarget[] = [];

  constructor(private readonly c: Checker) {}

  checkProgram(root: TreeNode): void {
    this.c.flow.current = new FlowState();
    this.checkBlockStatements(named(root));
  }

  checkBlockStatements(statements: TreeNode[]): void {
    for (const statement of statements) {
      if (!this.c.flow.isReachable) {
        // Unreachable code is still checked, with what its declarations say.
        this.c.flow.current = new FlowState();
        this.check(statement);
        this.c.flow.current = undefined;
        continue;
      }
      this.check(statement);
    }
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of statement.
  private check(node: TreeNode): void {
    switch (node.type) {
      case 'expression_statement': {
        const expression = named(node)[0];
        if (expression) this.c.expressions.check(expression);
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        this.declaration(node);
        return;
      }
      case 'statement_block': {
        this.checkBlockStatements(named(node));
        return;
      }
      case 'if_statement': {
        this.ifStatement(node);
        return;
      }
      case 'while_statement': {
        this.whileStatement(node);
        return;
      }
      case 'do_statement': {
        this.doStatement(node);
        return;
      }
      case 'for_statement': {
        this.forStatement(node);
        return;
      }
      case 'for_in_statement': {
        this.forInStatement(node);
        return;
      }
      case 'switch_statement': {
        this.switchStatement(node);
        return;
      }
      case 'try_statement': {
        this.tryStatement(node);
        return;
      }
      case 'return_statement': {
        this.returnStatement(node);
        return;
      }
      case 'throw_statement': {
        const expression = named(node)[0];
        if (expression) this.c.expressions.check(expression);
        this.c.flow.current = undefined;
        return;
      }
      case 'break_statement': {
        const target = this.jumpTargets.at(-1);
        target?.breaks.push(this.c.flow.current?.clone());
        this.c.flow.current = undefined;
        return;
      }
      case 'continue_statement': {
        const target = this.jumpTargets.findLast((candidate) => candidate.isLoop);
        target?.continues.push(this.c.flow.current?.clone());
        this.c.flow.current = undefined;
        return;
      }
      case 'function_declaration': {
        this.functionDeclaration(node);
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        this.c.classes.checkClass(node);
        return;
      }
      case 'interface_declaration': {
        this.interfaceDeclaration(node);
        return;
      }
      case 'type_alias_declaration': {
        const name = node.childForFieldName('name')?.text;
        const symbol = name ? this.c.scopeOf(node).lookupType(name) : undefined;
        this.c.typeParametersOf(node);
        if (symbol) this.c.declaredTypeOf(symbol);
        this.resolveTypesIn(node.childForFieldName('value'));
        return;
      }
      default: {
        return;
      }
    }
  }

  /** Resolves every type written in a node, so that unknown names report errors. */
  private resolveTypesIn(node: TreeNode | null): void {
    if (!node) return;
    const visit = (current: TreeNode): void => {
      if (current.type === 'type_identifier' || current.type === 'generic_type') {
        const parent = current.parent;
        if (
          parent?.type !== 'generic_type' &&
          parent?.type !== 'type_parameter' &&
          parent?.type !== 'mapped_type_clause' &&
          parent?.type !== 'infer_type'
        ) {
          this.c.typeFromNode(current);
        }
      }
      for (const child of named(current)) visit(child);
    };
    visit(node);
  }

  private interfaceDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name')?.text;
    const symbol = name ? this.c.scopeOf(node).lookupType(name) : undefined;
    if (!symbol) return;
    this.c.typeParametersOf(node);
    const type = this.c.declaredTypeOf(symbol);
    if (type.kind === 'object') {
      const structure = type.resolve();
      for (const property of structure.properties.values()) property.type();
      for (const signature of structure.callSignatures) signature.returnType();
      this.checkIndexConformance(structure);
    }
    for (const child of named(node)) if (child.type === 'extends_type_clause') this.resolveTypesIn(child);
    this.resolveTypesIn(node.childForFieldName('body'));
  }

  /** Reports properties that an index signature of the same type does not allow. */
  checkIndexConformance(structure: Structure): void {
    for (const property of structure.properties.values()) {
      const nameNode = property.declaration?.childForFieldName('name');
      if (!nameNode || !property.declaration || this.c.isLibrary(property.declaration)) continue;
      const type = property.optional ? unionOf([property.type(), undefinedType]) : property.type();
      for (const [index, kind] of [
        [structure.stringIndex, 'string'],
        [/^\d+$/.test(property.name) ? structure.numberIndex : undefined, 'number'],
      ] as const) {
        if (index && !this.c.relations.isAssignable(type, index.type)) {
          this.c.error(
            nameNode,
            `型 '${this.c.print(type)}' のプロパティ '${property.name}' は、'${kind}' のインデックスの型 '${this.c.print(index.type)}' に代入できません。`
          );
        }
      }
    }
  }

  // Declarations -------------------------------------------------------------------------------------------------

  // code-gauge-allow functionCognitiveComplexity 30 -- Each form of declarator.
  private declaration(node: TreeNode): void {
    const kind = node.type === 'variable_declaration' ? 'var' : (node.childForFieldName('kind')?.text ?? 'let');
    const isConst = kind === 'const';
    for (const declarator of named(node)) {
      if (declarator.type !== 'variable_declarator') continue;
      const nameNode = declarator.childForFieldName('name') as TreeNode;
      const value = declarator.childForFieldName('value');
      const annotation = this.c.annotationType(declarator.childForFieldName('type'));
      const definite = hasToken(declarator, '!');
      if (nameNode.type === 'identifier') {
        const symbol = this.c.scopeOf(nameNode).lookupValue(nameNode.text);
        if (!symbol) continue;
        const key = `s${symbol.id}`;
        if (!value) {
          if (isConst) continue;
          if (!annotation) {
            // `let x;` follows the types assigned to it, starting as `undefined`.
            this.c.expressions.setVariableType(symbol, anyType);
            this.c.flow.set(key, { type: undefinedType, assigned: true });
            continue;
          }
          this.c.expressions.setVariableType(symbol, annotation);
          const existing = this.c.flow.entry(key);
          // A `var` declared again keeps what it holds.
          if (kind === 'var' && existing) continue;
          this.c.flow.set(key, { type: annotation, assigned: definite });
          continue;
        }
        const valueType = this.c.expressions.check(value, annotation);
        if (annotation) {
          this.c.expressions.checkAssignable(nameNode, valueType, annotation);
          this.c.expressions.setVariableType(symbol, annotation);
          this.c.flow.set(key, {
            type: this.c.flow.assignmentReduced(annotation, regularOf(valueType)),
            assigned: true,
          });
          continue;
        }
        if (this.isEmptyArrayLiteral(value)) {
          // `const a = []` evolves as elements are pushed.
          this.c.expressions.setVariableType(symbol, this.c.arrayType(anyType));
          this.c.flow.set(key, { type: this.c.arrayType(neverType), assigned: true, evolving: true });
          continue;
        }
        const declared = this.c.expressions.widenDeclared(valueType, isConst);
        const widened =
          isIntrinsic(declared, 'null') || isIntrinsic(declared, 'undefined')
            ? isConst
              ? declared
              : anyType
            : declared;
        this.c.expressions.setVariableType(symbol, widened);
        this.c.flow.set(key, { type: isConst ? widened : widened === anyType ? declared : widened, assigned: true });
        continue;
      }
      // A destructuring pattern.
      const valueType = value ? this.c.expressions.check(value, annotation) : (annotation ?? anyType);
      if (annotation && value) this.c.expressions.checkAssignable(nameNode, valueType, annotation);
      const sourceType = annotation ?? this.c.expressions.widenDeclared(valueType, false);
      this.c.expressions.bindPattern(nameNode, sourceType, (identifier, type) => {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (!symbol) return;
        const declared = this.c.expressions.widenDeclared(type, isConst);
        this.c.expressions.setVariableType(symbol, declared);
        this.c.flow.set(`s${symbol.id}`, { type: declared, assigned: true });
      });
    }
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
    const annotation = this.c.annotationType(declaration.childForFieldName('type'));
    const value = declaration.childForFieldName('value');
    const isConst = declaration.parent?.childForFieldName('kind')?.text === 'const';
    if (nameNode.type === 'identifier') {
      if (annotation) return annotation;
      if (!value) return anyType;
      if (this.isEmptyArrayLiteral(value)) return this.c.arrayType(anyType);
      const flow = this.c.flow.current;
      this.c.flow.current = new FlowState();
      try {
        return this.c.expressions.widenDeclared(this.c.expressions.check(value), isConst);
      } finally {
        this.c.flow.current = flow;
      }
    }
    const source =
      annotation ?? (value ? this.c.expressions.widenDeclared(this.c.expressions.check(value), false) : anyType);
    return this.c.expressions.widenDeclared(this.c.expressions.patternType(nameNode, source, symbol.name), isConst);
  }

  private loopVariableType(node: TreeNode, symbol: Sym): Type {
    const header = node.childForFieldName('header') ?? node;
    const right = header.childForFieldName('right') as TreeNode;
    const left = header.childForFieldName('left') as TreeNode;
    const isOf = header.childForFieldName('operator')?.text === 'of';
    const rightType = this.c.expressions.check(right);
    const elementType = isOf ? this.c.expressions.iteratedType(undefined, rightType) : stringType;
    if (left.type === 'identifier') return elementType;
    return this.c.expressions.patternType(left, elementType, symbol.name);
  }

  // Control flow -------------------------------------------------------------------------------------------------

  private ifStatement(node: TreeNode): void {
    const condition = node.childForFieldName('condition') as TreeNode;
    const { whenTrue, whenFalse } = this.c.expressions.checkCondition(condition);
    const consequence = node.childForFieldName('consequence') as TreeNode;
    this.c.expressions.checkUncalledFunction(condition, consequence);
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
  private loop(iterate: (target: JumpTarget) => State): void {
    const entry = this.c.flow.current;
    let state = entry?.clone();
    for (let pass = 0; pass < MAX_LOOP_PASSES; pass++) {
      const target: JumpTarget = { isLoop: true, breaks: [], continues: [] };
      let backEdge: State;
      this.c.silently(() => {
        this.c.flow.current = state?.clone();
        this.jumpTargets.push(target);
        try {
          iterate(target);
          backEdge = this.c.flow.current;
        } finally {
          this.jumpTargets.pop();
        }
      });
      const next = this.c.flow.merge([entry, backEdge!]);
      if (this.sameState(next, state)) break;
      state = next;
    }
    const target: JumpTarget = { isLoop: true, breaks: [], continues: [] };
    this.c.flow.current = state;
    this.jumpTargets.push(target);
    let exit: State;
    try {
      exit = iterate(target);
    } finally {
      this.jumpTargets.pop();
    }
    this.c.flow.current = this.c.flow.merge([exit, ...target.breaks]);
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
    this.loop((target) => {
      const { whenTrue, whenFalse } = this.c.expressions.checkCondition(condition);
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
    this.loop((target) => {
      this.checkSubstatement(body);
      this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      if (!this.c.flow.isReachable) return;
      const { whenTrue, whenFalse } = this.c.expressions.checkCondition(condition);
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
    if (initializer && initializer.type !== 'empty_statement') {
      if (initializer.type === 'lexical_declaration' || initializer.type === 'variable_declaration')
        this.declaration(initializer);
      else if (initializer.type === 'expression_statement') this.c.expressions.check(named(initializer)[0]);
      else this.c.expressions.check(initializer);
    }
    this.loop((target) => {
      let whenFalse: State;
      const conditionNode =
        condition && condition.type !== 'empty_statement'
          ? condition.type === 'expression_statement'
            ? named(condition)[0]
            : condition
          : undefined;
      if (conditionNode) {
        const result = this.c.expressions.checkCondition(conditionNode);
        this.c.flow.current = result.whenTrue;
        whenFalse = this.isAlwaysTrue(conditionNode) ? undefined : result.whenFalse;
      } else {
        whenFalse = undefined;
      }
      this.checkSubstatement(body);
      this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      if (increment && this.c.flow.isReachable) this.c.expressions.check(increment);
      return whenFalse;
    });
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
    let elementType: Type;
    if (isOf) {
      elementType = this.c.expressions.iteratedType(right, rightType);
    } else {
      const object = regularOf(rightType);
      if (
        !isAnyLike(object) &&
        !isIntrinsic(object, 'unknown') &&
        (object.kind === 'literal' || (object.kind === 'intrinsic' && object.name !== 'object'))
      ) {
        this.c.error(
          right,
          'for...in 文の右辺は、any 型、オブジェクト型、型パラメーターのいずれかでなければいけません。'
        );
      }
      elementType = stringType;
    }
    const body = node.childForFieldName('body') as TreeNode;
    const bindLoopVariables = (): void => {
      if (kind) {
        this.c.expressions.bindPattern(left, elementType, (identifier, type) => {
          const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
          if (!symbol) return;
          this.c.expressions.setVariableType(symbol, kind === 'const' ? type : this.c.widen(type));
          this.c.flow.set(`s${symbol.id}`, { type, assigned: true });
        });
        return;
      }
      for (const identifier of patternIdentifiers(left)) {
        const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
        if (symbol) this.c.flow.set(`s${symbol.id}`, { type: this.c.expressions.valueTypeOf(symbol), assigned: true });
      }
      if (left.type === 'identifier') {
        const symbol = this.c.scopeOf(left).lookupValue(left.text);
        const declared = symbol ? this.c.expressions.valueTypeOf(symbol) : errorType;
        if (declared !== errorType && !this.c.relations.isAssignable(elementType, declared))
          this.c.expressions.reportNotAssignable(left, elementType, declared);
      }
    };
    this.loop((target) => {
      const head = this.c.flow.current?.clone();
      bindLoopVariables();
      this.checkSubstatement(body);
      this.c.flow.current = this.c.flow.merge([this.c.flow.current, ...target.continues]);
      return this.c.flow.merge([head, this.c.flow.current]);
    });
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Narrows each case and follows the fallthrough.
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
    try {
      for (const caseNode of cases) {
        let caseEntry: State;
        if (caseNode.type === 'switch_case') {
          const test = caseNode.childForFieldName('value') as TreeNode;
          this.c.flow.current = entry?.clone();
          const testType = this.c.expressions.check(test);
          caseTypes.push(regularOf(testType));
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
          caseEntry = this.c.expressions.narrowSwitchCase(discriminant, entry, [regularOf(testType)], true);
        } else {
          hasDefault = true;
          caseEntry = this.c.expressions.narrowSwitchCase(discriminant, entry, caseTypes, false);
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
    const noMatch = hasDefault ? undefined : this.c.expressions.narrowSwitchCase(discriminant, entry, caseTypes, false);
    this.c.flow.current = this.c.flow.merge([fallthrough!, ...target.breaks, noMatch]);
  }

  private tryStatement(node: TreeNode): void {
    const body = node.childForFieldName('body') as TreeNode;
    const handler = node.childForFieldName('handler');
    const finalizer = node.childForFieldName('finalizer');
    const entry = this.c.flow.current;
    this.checkBlockStatements(named(body));
    const tryEnd = this.c.flow.current;
    let catchEnd: State;
    if (handler) {
      this.c.flow.current = this.c.flow.merge([entry, tryEnd]);
      const parameter = handler.childForFieldName('parameter');
      const annotation = this.c.annotationType(handler.childForFieldName('type'));
      if (annotation && !isAnyLike(annotation) && !isIntrinsic(annotation, 'unknown')) {
        this.c.error(
          handler.childForFieldName('type') ?? handler,
          'catch の変数の型の注釈は、any か unknown にしてください。'
        );
      }
      if (parameter && parameter.type !== 'identifier') {
        this.c.expressions.bindPattern(parameter, annotation ?? anyType, (identifier, type) => {
          const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
          if (symbol) this.c.expressions.setVariableType(symbol, type);
        });
      }
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
    }
    this.c.flow.current = after;
  }

  private returnStatement(node: TreeNode): void {
    const context = this.c.expressions.functions.at(-1);
    const expression = named(node)[0];
    if (!context) {
      if (expression) this.c.expressions.check(expression);
      this.c.flow.current = undefined;
      return;
    }
    context.hasReturn = true;
    if (expression) {
      const declared = context.declaredReturn;
      const type = this.c.expressions.check(expression, declared ?? context.contextualReturn);
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

  // Functions ----------------------------------------------------------------------------------------------------

  private functionDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name');
    const symbol = name ? this.c.scopeOf(node).lookupValue(name.text) : undefined;
    const signature = this.c.signatureOf(node);
    this.checkFunctionLike(node, signature, undefined);
    if (symbol) this.checkOverloads(symbol, node, signature);
  }

  private checkOverloads(symbol: Sym, implementation: TreeNode, signature: Signature): void {
    const overloads = symbol.valueDeclarations.filter((declaration) => declaration.type === 'function_signature');
    for (const overload of overloads) {
      const overloadSignature = this.c.signatureOf(overload);
      const compatible =
        overloadSignature.parameters.length >=
          signature.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length &&
        overloadSignature.parameters.every((parameter, index) => {
          const implementationType = this.c.expressions.calls.parameterTypeAt(signature, index);
          return (
            !implementationType ||
            this.c.relations.isAssignable(parameter.type, implementationType) ||
            this.c.relations.isAssignable(implementationType, parameter.type)
          );
        });
      if (!compatible) {
        this.c.error(
          overload.childForFieldName('name') ?? overload,
          'このオーバーロードのシグネチャは、実装のシグネチャと合いません。'
        );
      }
    }
    void implementation;
  }

  /** Checks a function's body loudly, when its expression or declaration is checked. */
  deferFunctionBody(node: TreeNode, signature: Signature, contextualReturn: Type | undefined): void {
    this.checkFunctionLike(node, signature, contextualReturn);
  }

  checkFunctionLike(node: TreeNode, signature: Signature, contextualReturn: Type | undefined): void {
    if (this.c.silent > 0) return;
    const parameters = node.childForFieldName('parameters');
    for (const parameter of parameters ? named(parameters) : []) {
      const value = parameter.childForFieldName('value');
      const annotation = this.c.annotationType(parameter.childForFieldName('type'));
      if (value) {
        const type = this.c.flow.from(new FlowState(), () => {
          const valueType = this.c.expressions.check(value, annotation);
          if (annotation)
            this.c.expressions.checkAssignable(parameter.childForFieldName('pattern') ?? value, valueType, annotation);
        });
        void type;
      }
    }
    if (!node.childForFieldName('body')) return;
    this.c.expressions.checkFunctionBody(node, signature, contextualReturn, false);
  }

  /** Reports a function that may end without returning a value its declared return type requires. */
  checkMissingReturn(node: TreeNode, context: FunctionContext, declared: Type): void {
    if (!context.endReachable || context.isConstructor) return;
    if (hasToken(node, 'set') || node.childForFieldName('body')?.type !== 'statement_block') return;
    const members = declared.kind === 'union' ? declared.types : [declared];
    if (
      members.some(
        (member) =>
          isAnyLike(member) ||
          isIntrinsic(member, 'void') ||
          isIntrinsic(member, 'unknown') ||
          isIntrinsic(member, 'undefined')
      )
    )
      return;
    const returnNode = node.childForFieldName('return_type') ?? node;
    if (isIntrinsic(declared, 'never')) {
      this.c.error(returnNode, "戻り値の型が 'never' の関数は、最後まで実行されて終わってはいけません。");
      return;
    }
    if (!context.hasReturn) {
      this.c.error(
        returnNode,
        "宣言した戻り値の型が 'undefined'、'void'、'any' のどれでもない関数は、値を返さなければいけません。"
      );
      return;
    }
    this.c.error(returnNode, "関数の最後に return 文がなく、戻り値の型に 'undefined' が含まれていません。");
  }

  unionOfReturns(types: Type[]): Type {
    return unionOf(types);
  }
}
