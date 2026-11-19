import { isBaseAccessible } from './access';
import { AUTO, hasAuto } from './compilerBase';
import { permitsQualificationConversion } from './conversions';
import { CppException, ProgramAbort } from './errors';
import type { Expr } from './expr';
import { ExpressionCompiler } from './expressionCompiler';
import { withTemporaries, zeroOf } from './objectCompiler';
import { BREAK, type Completion, CONTINUE, type Eval, type Exec, type Frame, type LocalInfo, RETURN } from './runtime';
import { type Entity, Scope } from './scopes';
import { isObjectCreation, onlyCalls } from './stepRules';
import { fieldOf, fieldsOf, hasToken, type Syntax } from './syntax';
import {
  type GlobalInfo,
  isArithmetic,
  isConstType,
  isInteger,
  isLibraryClass,
  isReferenceRelated,
  nonReference,
  referenceTo,
  sameType,
  type Type,
  typeName,
  unqualified,
  withConst,
} from './types';
import { Box, type CObject, endLifetime, Liveness, Ptr, type Store, UNINIT, type Value } from './values';

/** The type an `auto` declarator deduced, which the declaration's other declarators must agree with. */
export type ReferenceBinding = { type: Extract<Type, { kind: 'reference' }> } & (
  | { loc: Eval<Ptr> }
  | { lifetime: { type: Type; make: Eval<Value | Ptr>; locate: (box: Box) => Ptr } }
);

export interface AutoDeduction {
  name: string;
  type: Type;
}

/** Compiles statements to closures that run them and tell how they completed. */
export abstract class StatementCompiler extends ExpressionCompiler {
  /** Whether the program is compiled for tracing, where statements record steps. */
  abstract readonly recordsSteps: boolean;

  /** Records the step of a statement after it runs, as `StepTracker.runStatement` says. */
  withStep(row: number, exec: Exec, isOnlyCall = false): Exec {
    if (!this.recordsSteps || this.recordsStepsOverride === false) return exec;
    return (frame) => frame.runtime.steps.runStatement(row, isOnlyCall, () => exec(frame));
  }

  /** Runs an expression as a full-expression, whose temporaries end their lifetime when it completes. */
  fullExpression<T>(run: Eval<T>): Eval<T> {
    return (frame) => withTemporaries(frame, run);
  }

  /** Compiles statements in a new block scope, whose variables end their lifetime when the block completes. */
  inScope(compile: () => Exec, scope = new Scope()): Exec {
    this.context.scopes.push(scope);
    let exec: Exec;
    try {
      exec = compile();
    } finally {
      this.context.popScope();
    }
    return this.withScopeExit(exec, scope);
  }

  /** Ends the lifetime of a scope's variables when its statements complete, however they complete. */
  withScopeExit(exec: Exec, scope: Scope): Exec {
    const { slots, destructibles } = scope;
    if (slots.length === 0) return exec;
    return (frame) => {
      let completion: Completion;
      try {
        completion = exec(frame);
      } catch (error) {
        // Only a caught exception unwinds the stack; other errors end the program where they occur.
        if (error instanceof CppException) endScope(frame, slots, destructibles);
        throw error;
      }
      endScope(frame, slots, destructibles);
      return completion;
    };
  }

  compileBlock(node: Syntax): Exec {
    return this.inScope(() => this.compileStatements(node.children));
  }

  compileStatements(nodes: readonly Syntax[]): Exec {
    const compiled = nodes.filter((node) => node.type !== 'comment').map((node) => this.compileStatement(node));
    if (compiled.length === 1) return compiled[0];
    return (frame) => {
      for (const exec of compiled) {
        const completion = exec(frame);
        if (completion !== undefined) return completion;
      }
      return;
    };
  }

  compileStatement(node: Syntax): Exec {
    const exec = this.compileStatementBody(node);
    return (frame) => {
      frame.runtime.spend();
      return exec(frame);
    };
  }

  // code-gauge-allow functionNcss 40 -- One case per statement kind, each delegating to its own compiler.
  private compileStatementBody(node: Syntax): Exec {
    switch (node.type) {
      case 'compound_statement': {
        return this.compileBlock(node);
      }
      case 'declaration': {
        return this.localDeclaration(node);
      }
      case 'expression_statement': {
        return this.expressionStatement(node);
      }
      case 'if_statement': {
        return this.ifStatement(node);
      }
      case 'while_statement': {
        return this.whileStatement(node);
      }
      case 'do_statement': {
        return this.doStatement(node);
      }
      case 'for_statement': {
        return this.forStatement(node);
      }
      case 'for_range_loop': {
        return this.rangeFor(node);
      }
      case 'switch_statement': {
        return this.switchStatement(node);
      }
      case 'case_statement': {
        return this.error(node.row, 'case と default は switch 文の中にしか書けません。');
      }
      case 'break_statement': {
        if (this.context.loopDepth === 0 && this.context.switchDepth === 0) {
          this.error(node.row, 'break 文はループや switch 文の中にしか書けません。');
        }
        return () => BREAK;
      }
      case 'continue_statement': {
        if (this.context.loopDepth === 0) this.error(node.row, 'continue 文はループの中にしか書けません。');
        return () => CONTINUE;
      }
      case 'return_statement': {
        return this.returnStatement(node);
      }
      case 'try_statement': {
        return this.tryStatement(node);
      }
      case 'throw_statement': {
        return this.throwStatement(node);
      }
      case 'class_specifier':
      case 'struct_specifier': {
        return this.unsupported(node.row, '関数の中のクラスの定義');
      }
      case 'function_definition': {
        const assignment = asZeroAssignment(node);
        if (assignment) return this.compileStatementBody(assignment);
        return this.error(node.row, '関数の中に関数は定義できません（ラムダ式は、この採点環境では使えません）。');
      }
      case 'using_declaration': {
        this.usingDeclaration(node);
        return () => {};
      }
      default: {
        return this.error(node.row, `${node.text.split('\n')[0]} は文として書けません。`);
      }
    }
  }

  /** Brings `std` names into scope, for `using namespace std;` or `using std::cout;`. */
  abstract usingDeclaration(node: Syntax): void;

  // Declarations -----------------------------------------------------------------------------------------------------

  private localDeclaration(node: Syntax): Exec {
    if (this.hasSpecifier(node, 'static')) return this.staticLocal(node);
    const base = this.specifiedType(node, true);
    const declarators = fieldsOf(node, 'declarator');
    if (declarators.length === 0) return this.error(node.row, '変数の名前を書いてください。');
    let recordsStep = false;
    let allCreate = true;
    const parts: Exec[] = [];
    let firstDeduced: AutoDeduction | undefined;
    for (const declarator of declarators) {
      const { exec, hasInitializer, createsObject, deduced } = this.localDeclarator(base, declarator, node);
      firstDeduced = this.checkAutoDeduction(firstDeduced, deduced, declarator.row);
      parts.push(exec);
      if (hasInitializer || createsObject) recordsStep = true;
      if (!createsObject) allCreate = false;
    }
    const run: Exec = (frame) => {
      for (const part of parts) part(frame);
      return;
    };
    return recordsStep ? this.withStep(node.row, run, allCreate) : run;
  }

  private localDeclarator(
    base: Type,
    declarator: Syntax,
    declaration: Syntax
  ): { exec: Exec; hasInitializer: boolean; createsObject: boolean; deduced?: AutoDeduction } {
    const declared = this.applyDeclarator(base, declarator);
    const reread = declared.function ? this.asDirectInitialization(declarator, declared.function) : undefined;
    if (reread) return this.localDeclarator(base, reread, declaration);
    if (declared.function)
      return this.error(
        declarator.row,
        `${declared.name ?? ''}(); は関数の宣言になります。変数を作るには ${declared.name ?? ''}; と書いてください（関数の中での関数の宣言は、この採点環境では使えません）。`
      );
    const name = declared.name as string;
    if (declared.nameNode?.type === 'qualified_identifier')
      return this.error(declarator.row, `${name} の宣言に :: は書けません。`);
    this.checkRedeclaration(name, declarator.row);
    const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
    let type = declared.type;
    if (type.kind === 'reference') return this.referenceDeclarator(name, type, value, declarator.row);
    if (type.kind === 'void') return this.error(declarator.row, `void 型の変数 ${name} は作れません。`);
    let init: Eval<Value>;
    let createsObject = false;
    let entity: Extract<Entity, { kind: 'local' }>;
    let deduced: AutoDeduction | undefined;
    if (hasAuto(type)) {
      const source = this.autoInitializer(declarator, value, name);
      const expr = this.compileExpression(source);
      type = this.deduceAuto(type, expr, declarator.row);
      createsObject =
        type.kind === 'class' &&
        expr.isTemporaryObject === true &&
        source === value &&
        value.type !== 'call_expression';
      init = this.copyInitializer(type, expr, declarator.row, value?.type === 'initializer_list');
      entity = this.declareVariable(name, type);
      entity.constant = isConstType(type) ? this.rvalue(expr).constant : undefined;
      deduced = { name, type: deducedType(declared.type, type) };
    } else {
      if (type.kind === 'array' && type.length === undefined && value) type = this.completeArrayType(type, value);
      if (type.kind === 'array' && type.length === undefined)
        return this.error(declarator.row, `配列 ${name} の大きさを書いてください。`);
      // The variable's name is usable in its own initializer (C++20 [basic.scope.pdecl]).
      entity = this.declareVariable(name, type);
      const compiled = this.initializerOf(type, value, declarator, name);
      init = compiled.init;
      entity.constant = compiled.constant;
      createsObject = compiled.createsObject;
    }
    if (this.isConstexpr(declaration)) entity.constant = this.requireConstantInitializer(type, value, declarator.row);
    if (this.isClassLike(type) && !value) createsObject = true;
    const { local } = entity;
    const destroy = this.destroyerOf(type, declarator.row);
    if (destroy) this.context.scope.destructibles.set(local.slot, destroy);
    const { slot } = local;
    // A variable must be declared before its initializer runs, which may name it (C++20 [basic.scope.pdecl]).
    const exec: Exec = (frame) => {
      const store = new Box(UNINIT);
      frame.slots[slot] = store;
      store.value = init(frame);
      return;
    };
    return {
      exec: this.fullExpression(exec),
      hasInitializer: value !== undefined,
      createsObject: createsObject || (type.kind === 'class' && !value),
      deduced,
    };
  }

  /** Rejects `auto x = 1, y = 2.0;`, whose declarators deduce `auto` differently, and returns the first deduction. */
  protected checkAutoDeduction(
    first: AutoDeduction | undefined,
    next: AutoDeduction | undefined,
    row: number
  ): AutoDeduction | undefined {
    if (!first || !next) return first ?? next;
    if (!sameType(first.type, next.type)) {
      this.error(
        row,
        `auto が、${first.name} の宣言では ${typeName(first.type)} 型、${next.name} の宣言では ${typeName(next.type)} 型と、違う型になりました。`
      );
    }
    return first;
  }

  /** Rejects `auto x = {1, 2};`, which deduces `std::initializer_list`. */
  protected rejectInitializerListDeduction(declarator: Syntax, value: Syntax | undefined): void {
    if (value?.type === 'initializer_list' && value.children.length > 0 && hasToken(declarator, '=')) {
      this.unsupported(declarator.row, 'std::initializer_list（auto x = {1, 2}; など）');
    }
  }

  protected autoInitializer(declarator: Syntax, value: Syntax | undefined, name: string): Syntax {
    if (value && value.type !== 'initializer_list' && value.type !== 'argument_list') return value;
    this.rejectInitializerListDeduction(declarator, value);
    if (value?.children.length === 1) return value.children[0];
    return this.error(declarator.row, `auto の変数 ${name} には初期値を1つ書いてください。`);
  }

  private declareVariable(name: string, type: Type): Extract<Entity, { kind: 'local' }> {
    const local = this.context.declareLocal(name, type, false);
    const entity: Extract<Entity, { kind: 'local' }> = { kind: 'local', local, isReference: false };
    this.context.scope.names.set(name, entity);
    return entity;
  }

  /** A declarator, or the variable with arguments that `asDirectInitialization` reads it as. */
  protected variableOrFunctionDeclarator(base: Type, declarator: Syntax): Syntax {
    const declared = this.applyDeclarator(base, declarator);
    return (declared.function ? this.asDirectInitialization(declarator, declared.function) : undefined) ?? declarator;
  }

  /**
   * Reads `Turtle t(x, y);` as a variable with constructor arguments when the grammar took it for a function
   * declaration: its "parameters" are names of variables, not types, so C++ reads it as a variable.
   */
  protected asDirectInitialization(declarator: Syntax, functionDeclarator: Syntax): Syntax | undefined {
    const parameters = fieldOf(functionDeclarator, 'parameters');
    const name = fieldOf(functionDeclarator, 'declarator');
    if (!parameters || !name || name.type !== 'identifier' || parameters.children.length === 0) return undefined;
    const args: Syntax[] = [];
    for (const parameter of parameters.children) {
      const type = fieldOf(parameter, 'type');
      if (
        parameter.type !== 'parameter_declaration' ||
        fieldOf(parameter, 'declarator') ||
        parameter.children.length !== 1
      )
        return undefined;
      if (type?.type !== 'type_identifier' && type?.type !== 'qualified_identifier') return undefined;
      const entity = type.type === 'qualified_identifier' ? this.lookupQualified(type) : this.findName(type.text);
      if (!entity || entity.kind === 'class' || entity.kind === 'type' || entity.kind === 'template') return undefined;
      args.push({ ...type, type: type.type === 'type_identifier' ? 'identifier' : type.type, field: undefined });
    }
    const argumentList: Syntax = { ...parameters, type: 'argument_list', children: args, all: args, field: 'value' };
    const variable: Syntax = { ...name, field: 'declarator' };
    return {
      ...declarator,
      type: 'init_declarator',
      children: [variable, argumentList],
      all: [variable, argumentList],
    };
  }

  private isClassLike(type: Type): boolean {
    if (type.kind === 'class') return true;
    return type.kind === 'array' && this.isClassLike(type.of);
  }

  /** The initializer of a variable of a type that is no reference, with what the trace needs to know of it. */
  private initializerOf(
    type: Type,
    value: Syntax | undefined,
    declarator: Syntax,
    name: string
  ): { init: Eval<Value>; constant?: number | bigint; createsObject: boolean } {
    const { row } = declarator;
    if (!value) return { init: this.defaultInitializer(type, row), createsObject: this.isClassLike(type) };
    if (value.type === 'initializer_list') {
      return {
        init: this.listInitializer(type, value, row),
        createsObject: (type.kind === 'class' && !isLibraryClass(type)) || isObjectCreation(value),
      };
    }
    if (value.type === 'argument_list') {
      const args = value.children.map((arg) => this.argument(arg));
      if (type.kind === 'class')
        return {
          init: this.constructObject(type.cls, args, row, false).run as Eval<Value>,
          createsObject: !type.cls.library,
        };
      if (args.length !== 1) return this.error(row, `${name} の初期値には値を1つだけ書いてください。`);
      const expr = args[0];
      if (type.kind === 'array')
        return this.error(row, `配列 ${name} は (...) では初期化できません。{...} を使ってください。`);
      return {
        init: this.copyInitializer(type, expr, row, false),
        constant: isConstType(type) ? this.constantOf(expr, type) : undefined,
        createsObject: false,
      };
    }
    const expr = this.compileExpression(value);
    const createsObject =
      type.kind === 'class' && expr.isTemporaryObject === true && !type.cls.library && value.type !== 'call_expression';
    return {
      init: this.copyInitializer(type, expr, row, false),
      constant: isConstType(type) ? this.constantOf(expr, type) : undefined,
      createsObject: createsObject || value.type === 'new_expression',
    };
  }

  /** The constant value a const variable of arithmetic type takes, when its initializer is a constant expression. */
  constantOf(expr: Expr, type: Type): number | bigint | undefined {
    if (!isArithmetic(type)) return undefined;
    const value = this.rvalue(expr);
    if (value.constant === undefined || !isArithmetic(value.type)) return undefined;
    try {
      return this.convert(value, unqualified(type), expr.row).constant;
    } catch {
      return undefined;
    }
  }

  protected requireConstantInitializer(
    type: Type,
    value: Syntax | undefined,
    row: number
  ): number | bigint | undefined {
    if (!value) return this.error(row, 'constexpr の変数には初期値を書いてください。');
    if (!isArithmetic(type)) return undefined;
    const isList = value.type === 'initializer_list';
    const args =
      isList || value.type === 'argument_list' ? value.children.filter((child) => child.type !== 'comment') : [value];
    if (args.length === 0 && isList) return zeroOf(type) as number | bigint;
    const constant = args.length === 1 ? this.constantOf(this.compileExpression(args[0]), type) : undefined;
    if (constant === undefined) return this.error(row, 'constexpr の変数の初期値には定数式を書いてください。');
    return constant;
  }

  /** The length of an array declared without one, which its initializer decides. */
  completeArrayType(type: Extract<Type, { kind: 'array' }>, value: Syntax): Type {
    if (value.type === 'initializer_list') return { ...type, length: this.bracedArrayLength(type, value) };
    if (value.type === 'string_literal' || value.type === 'concatenated_string') {
      const literal = this.compileExpression(value);
      if (literal.literalBytes !== undefined) return { ...type, length: literal.literalBytes.length + 1 };
    }
    return this.error(value.row, '配列の初期値には {...} か文字列リテラルを書いてください。');
  }

  /** The length of an array of unknown bound that a braced list initializes. */
  abstract bracedArrayLength(type: Extract<Type, { kind: 'array' }>, list: Syntax): number;

  private referenceDeclarator(
    name: string,
    declared: Extract<Type, { kind: 'reference' }>,
    value: Syntax | undefined,
    row: number
  ): { exec: Exec; hasInitializer: boolean; createsObject: boolean; deduced?: AutoDeduction } {
    const binding = this.bindReference(name, declared, value, row);
    const { type } = binding;
    const deduced = hasAuto(declared.to) ? { name, type: deducedType(declared, type) } : undefined;
    const local = this.context.declareLocal(name, type, false);
    this.context.scope.names.set(name, { kind: 'local', local, isReference: true });
    const { slot } = local;
    if ('lifetime' in binding) {
      const { type: held, make, locate } = binding.lifetime;
      return { ...this.extendedReference(slot, name, held, make, locate), deduced };
    }
    return {
      exec: this.fullExpression<undefined>((frame) => {
        frame.slots[slot] = binding.loc(frame);
        return;
      }),
      hasInitializer: true,
      createsObject: false,
      deduced,
    };
  }

  protected bindReference(
    name: string,
    declared: Extract<Type, { kind: 'reference' }>,
    value: Syntax | undefined,
    row: number
  ): ReferenceBinding {
    if (!value) return this.error(row, `参照 ${name} には初期値が要ります。`);
    const isDeduced = hasAuto(declared.to);
    let target: Expr;
    if (value.type === 'initializer_list' && !isDeduced) {
      const bound = this.listReferenceValue(value, declared.to);
      if (!bound) return this.error(row, `参照 ${name} を {...} の値に束縛できません。`);
      target = bound;
    } else if (value.type === 'initializer_list' || value.type === 'argument_list') {
      if (value.children.length !== 1) return this.error(row, `参照 ${name} の初期値には値を1つだけ書いてください。`);
      target = this.compileExpression(value.children[0]);
    } else {
      target = this.compileExpression(value);
    }
    const type = isDeduced ? referenceTo(this.deduceAutoReference(declared.to, target)) : declared;
    // A const reference bound to a temporary extends the temporary's lifetime to the reference's, whether the
    // temporary is the initializer's object or a converted value (C++20 [class.temporary]).
    const isDirect = target.isLvalue && isReferenceRelated(target.type, type.to);
    const isTemporaryClass =
      !target.isLvalue &&
      target.type.kind === 'class' &&
      type.to.kind === 'class' &&
      target.type.cls.isDerivedFrom(type.to.cls);
    if (!isDirect && isConstType(type.to) && !target.functions && target.type.kind !== 'void') {
      const heldType = isTemporaryClass ? target.type : unqualified(type.to);
      const bound = isTemporaryClass ? target : this.convert(target, heldType, row);
      return { type, lifetime: { type: heldType, make: bound.run, locate: (box) => new Ptr(box, 0) } };
    }
    const member = isDirect ? target.temporaryMember : undefined;
    if (member) {
      return { type, lifetime: { type: member.object.type, make: member.object.run, locate: memberAt(member.path) } };
    }
    return { type, loc: this.convert(target, type, row).run as Eval<Ptr> };
  }

  /**
   * A reference bound to (a part of) a temporary of type `heldType`, which a hidden variable holds as long as the
   * reference lives.
   */
  private extendedReference(
    slot: number,
    name: string,
    heldType: Type,
    make: Eval<Value | Ptr>,
    locate: (box: Box) => Ptr
  ): { exec: Exec; hasInitializer: boolean; createsObject: boolean } {
    const destroy = this.destroyerOf(heldType);
    const holder = this.context.declareLocal(`\0${name}`, heldType, false);
    if (destroy) this.context.scope.destructibles.set(holder.slot, destroy);
    return {
      exec: this.fullExpression<undefined>((frame) => {
        const box = new Box(make(frame) as Value);
        frame.slots[holder.slot] = box;
        frame.slots[slot] = locate(box);
        return;
      }),
      hasInitializer: true,
      createsObject: false,
    };
  }

  private staticLocal(node: Syntax): Exec {
    const base = this.specifiedType(node, true);
    let firstDeduced: AutoDeduction | undefined;
    const initializers = fieldsOf(node, 'declarator').map((written) => {
      const declarator = this.variableOrFunctionDeclarator(base, written);
      const declared = this.applyDeclarator(base, declarator);
      const name = declared.name as string;
      this.checkRedeclaration(name, declarator.row);
      const value = declarator.type === 'init_declarator' ? fieldOf(declarator, 'value') : undefined;
      let type: Type = declared.type;
      const reference = type.kind === 'reference' ? this.bindReference(name, type, value, declarator.row) : undefined;
      if (reference) type = reference.type;
      else if (hasAuto(type)) {
        type = this.deduceAuto(
          type,
          this.compileExpression(this.autoInitializer(declarator, value, name)),
          declarator.row
        );
      }
      if (hasAuto(declared.type)) {
        firstDeduced = this.checkAutoDeduction(
          firstDeduced,
          { name, type: deducedType(declared.type, type) },
          declarator.row
        );
      }
      if (type.kind === 'array' && type.length === undefined && value) type = this.completeArrayType(type, value);
      if (type.kind === 'array' && type.length === undefined)
        return this.error(declarator.row, `配列 ${name} の大きさを書いてください。`);
      const global = this.declareStaticStorage(name, type, declarator.row, false);
      const local = this.context.declareLocal(name, type, false);
      const constant =
        !reference && this.isConstexpr(node) ? this.requireConstantInitializer(type, value, declarator.row) : undefined;
      this.context.scope.names.set(name, { kind: 'local', local, isReference: reference !== undefined, constant });
      const { slot } = local;
      const { index } = global;
      const initialize = reference
        ? this.staticReferenceInitializer(global, reference, declarator.row)
        : this.staticInitializer(global, type, value, declarator.row);
      this.context.scope.slots.splice(this.context.scope.slots.indexOf(slot), 1);
      this.context.scope.returnSlots.delete(local);
      this.context.scope.statics.push(slot);
      return (frame: Frame) => {
        const store = frame.runtime.globals[index];
        if (!reference) frame.slots[slot] = store;
        initialize(frame);
        if (reference) frame.slots[slot] = (store as Box).value as Ptr;
      };
    });
    return (frame) => {
      for (const initialize of initializers) initialize(frame);
      return;
    };
  }

  /** Declares a variable with static storage duration, which the program's start creates. */
  abstract declareStaticStorage(name: string, type: Type, row: number, isShown: boolean): GlobalInfo;

  abstract staticReferenceInitializer(
    global: GlobalInfo,
    binding: ReferenceBinding,
    row: number
  ): (frame: Frame) => void;

  /** Initializes a function's static variable the first time its declaration runs. */
  abstract staticInitializer(
    global: GlobalInfo,
    type: Type,
    value: Syntax | undefined,
    row: number
  ): (frame: Frame) => void;

  checkRedeclaration(name: string, row: number): void {
    const { names, conflictingDeclarations } = this.context.scope;
    if (names.has(name) || conflictingDeclarations?.has(name))
      this.error(row, `${name} は、同じブロックの中ですでに宣言されています。`);
  }

  // Statements --------------------------------------------------------------------------------------------------------

  private expressionStatement(node: Syntax): Exec {
    const expressionNode = node.children[0];
    if (!expressionNode) return () => {};
    const expr = this.compileExpression(expressionNode);
    if (expr.functions)
      return this.error(node.row, `関数 ${expr.functions.name} の後に (...) を書いて呼び出してください。`);
    const destroy = expr.isTemporaryObject ? this.destroyerOf(expr.type, node.row) : undefined;
    const run = expr.run;
    const exec = this.fullExpression<Completion>((frame) => {
      const value = run(frame);
      if (expr.isTemporaryObject && !(value instanceof Ptr)) {
        destroy?.(frame, value as Value);
        endLifetime(value as Value);
      }
      return;
    });
    return this.withStep(node.row, exec, onlyCalls(expressionNode));
  }

  private conditionOf(clause: Syntax): Eval<boolean> {
    const value = clause.type === 'condition_clause' ? fieldOf(clause, 'value') : clause;
    if (!value) return this.error(clause.row, '条件を書いてください。');
    if (value.type === 'declaration')
      return this.unsupported(value.row, '条件の中の変数の宣言（if (int x = f()) など）');
    const condition = this.condition(this.compileExpression(value), value.row);
    return this.fullExpression(condition);
  }

  private ifStatement(node: Syntax): Exec {
    if (node.all.some((child) => child.type === 'constexpr')) return this.unsupported(node.row, 'if constexpr');
    if (node.all.some((child) => child.type === 'consteval')) return this.unsupported(node.row, 'if consteval');
    const condition = this.conditionOf(fieldOf(node, 'condition') as Syntax);
    const consequence = this.inScope(() => this.compileStatement(fieldOf(node, 'consequence') as Syntax));
    const elseClause = fieldOf(node, 'alternative');
    const alternativeNode = elseClause?.children[0];
    const alternative = alternativeNode ? this.inScope(() => this.compileStatement(alternativeNode)) : undefined;
    return (frame) => (condition(frame) ? consequence(frame) : alternative?.(frame));
  }

  private loopBody(node: Syntax, header?: Scope): Exec {
    this.context.loopDepth++;
    try {
      return this.inScope(
        () =>
          node.type === 'compound_statement' ? this.compileStatements(node.children) : this.compileStatement(node),
        new Scope(header?.names)
      );
    } finally {
      this.context.loopDepth--;
    }
  }

  private whileStatement(node: Syntax): Exec {
    const condition = this.conditionOf(fieldOf(node, 'condition') as Syntax);
    const body = this.loopBody(fieldOf(node, 'body') as Syntax);
    return (frame) => {
      while (condition(frame)) {
        frame.runtime.spend();
        const completion = body(frame);
        if (completion === BREAK) break;
        if (completion === RETURN) return completion;
      }
      return;
    };
  }

  private doStatement(node: Syntax): Exec {
    const body = this.loopBody(fieldOf(node, 'body') as Syntax);
    const condition = this.conditionOf(fieldOf(node, 'condition') as Syntax);
    return (frame) => {
      do {
        frame.runtime.spend();
        const completion = body(frame);
        if (completion === BREAK) break;
        if (completion === RETURN) return completion;
      } while (condition(frame));
      return;
    };
  }

  private forStatement(node: Syntax): Exec {
    const scope = new Scope();
    this.context.scopes.push(scope);
    let loop: Exec;
    try {
      const initNode = fieldOf(node, 'initializer');
      let init: Exec = doNothing;
      let initRecords = false;
      if (initNode?.type === 'declaration') {
        init = this.forInitDeclaration(initNode);
        initRecords = fieldsOf(initNode, 'declarator').some((d) => d.type === 'init_declarator');
      } else if (initNode) {
        const expr = this.compileExpression(initNode);
        init = this.fullExpression((frame) => (expr.run(frame), undefined));
        initRecords = true;
      }
      const conditionNode = fieldOf(node, 'condition');
      const condition = conditionNode ? this.conditionOf(conditionNode) : () => true;
      const updateNodes = fieldsOf(node, 'update');
      const updates = updateNodes.map((update) => this.compileExpression(update).run);
      const update = this.fullExpression<undefined>((frame) => {
        for (const run of updates) run(frame);
        return;
      });
      const body = this.loopBody(fieldOf(node, 'body') as Syntax, scope);
      const stepInit = this.recordsSteps && initRecords;
      const stepUpdate = this.recordsSteps && updates.length > 0;
      const { row } = node;
      loop = (frame) => {
        init(frame);
        if (stepInit) frame.runtime.steps.step(row);
        while (condition(frame)) {
          frame.runtime.spend();
          const completion = body(frame);
          if (completion === BREAK) break;
          if (completion === RETURN) return completion;
          update(frame);
          if (stepUpdate) frame.runtime.steps.step(row);
        }
        return;
      };
    } finally {
      this.context.popScope();
    }
    return this.withScopeExit(loop, scope);
  }

  /** The declaration that starts a `for` statement, which records no step of its own: the loop records one. */
  private forInitDeclaration(node: Syntax): Exec {
    const saved = this.recordsStepsOverride;
    this.recordsStepsOverride = false;
    try {
      return this.localDeclaration(node);
    } finally {
      this.recordsStepsOverride = saved;
    }
  }

  /** Turns off the steps of the statements compiled meanwhile, for the parts of a `for` header. */
  recordsStepsOverride: boolean | undefined;

  private rangeFor(node: Syntax): Exec {
    const scope = new Scope();
    this.context.scopes.push(scope);
    let loop: Exec;
    try {
      loop = this.rangeForLoop(node);
    } finally {
      this.context.popScope();
    }
    return this.withScopeExit(loop, scope);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- A range-based for loop combines its range, its iterators, and its variable.
  private rangeForLoop(node: Syntax): Exec {
    const rangeNode = fieldOf(node, 'right') as Syntax;
    const { row } = node;
    const range =
      rangeNode.type === 'initializer_list' ? this.braceArray(rangeNode) : this.compileExpression(rangeNode);
    // The range lives in a variable of the loop, as `auto&& __range = range;` holds it.
    const rangeType = range.type;
    const rangeLocal = this.context.declareLocal('\0range', rangeType, false);
    const rangeSlot = rangeLocal.slot;
    // A temporary range lives in the slot until the loop ends, as binding it to the reference extends its lifetime.
    const keepRange: Eval<void> = range.isLvalue
      ? (frame) => {
          frame.slots[rangeSlot] = range.run(frame) as Ptr;
        }
      : (frame) => {
          frame.slots[rangeSlot] = new Box(range.run(frame) as Value);
        };
    if (!range.isLvalue) {
      const destroy = this.destroyerOf(rangeType);
      if (destroy) this.context.scope.destructibles.set(rangeSlot, destroy);
    }
    const rangeRef: Expr = {
      type: rangeType,
      isLvalue: true,
      row,
      run: range.isLvalue
        ? (frame) => frame.slots[rangeSlot] as Ptr
        : (frame) => new Ptr(frame.slots[rangeSlot] as Box, 0),
    };
    let begin: Expr;
    let end: Expr;
    if (rangeType.kind === 'array') {
      begin = this.rvalue(rangeRef);
      end = this.pointerOffset(
        begin,
        {
          type: { kind: 'int', name: 'long' },
          isLvalue: false,
          row,
          run: () => BigInt(rangeType.length ?? 0),
          constant: BigInt(rangeType.length ?? 0),
        },
        1,
        row
      );
    } else if (rangeType.kind === 'class') {
      begin = this.callWith(this.member(rangeRef, 'begin', row), [], row);
      end = this.callWith(this.member(rangeRef, 'end', row), [], row);
    } else {
      return this.error(row, `範囲 for 文では、${typeName(rangeType)} 型の値の要素を順に取り出せません。`);
    }
    const iteratorLocal = this.context.declareLocal('\0begin', begin.type, false);
    const endLocal = this.context.declareLocal('\0end', end.type, false);
    const iterator: Expr = {
      type: begin.type,
      isLvalue: true,
      row,
      run: (frame) => new Ptr(frame.slots[iteratorLocal.slot] as Store, 0),
    };
    const endRef: Expr = {
      type: end.type,
      isLvalue: true,
      row,
      run: (frame) => new Ptr(frame.slots[endLocal.slot] as Store, 0),
    };
    const notDone = this.condition(this.binary('!=', iterator, endRef, row), row);
    const advance = this.increment(iterator, '++', true, row).run;
    const element = this.dereferenceOperator(iterator, row);
    const bodyScope = new Scope();
    this.context.scopes.push(bodyScope);
    let bind: Exec;
    let variableType: Type;
    let body: Exec;
    try {
      ({ bind, type: variableType } = this.rangeVariable(node, element));
      body = this.loopBody(fieldOf(node, 'body') as Syntax, bodyScope);
    } finally {
      this.context.popScope();
    }
    const iteration = this.withScopeExit((frame) => {
      bind(frame);
      if (this.recordsSteps) frame.runtime.steps.stepBinding(row, this.isAnswered(variableType));
      return body(frame);
    }, bodyScope);
    const beginRun = begin.run;
    const endRun = end.run;
    const initializeRange = range.isLvalue ? keepRange : this.fullExpression(keepRange);
    return this.fullExpression((frame) => {
      initializeRange(frame);
      frame.slots[iteratorLocal.slot] = new Box(beginRun(frame) as Value);
      frame.slots[endLocal.slot] = new Box(endRun(frame) as Value);
      while (notDone(frame)) {
        frame.runtime.spend();
        const completion = iteration(frame);
        if (completion === BREAK) break;
        if (completion === RETURN) return completion;
        advance(frame);
      }
      return;
    });
  }

  /** A temporary array holding the values of a braced list, for `for (int x : {1, 2, 3})`. */
  private braceArray(list: Syntax): Expr {
    const values = list.children.filter((child) => child.type !== 'comment');
    if (values.length === 0) return this.error(list.row, '範囲 for 文の {} には値を書いてください。');
    const elementType = this.deduceAuto(AUTO, this.compileExpression(values[0]), list.row);
    for (const value of values.slice(1)) {
      const candidate = this.deduceAuto(AUTO, this.compileExpression(value), value.row);
      if (!sameType(candidate, elementType))
        return this.error(value.row, '範囲 for 文の {} には同じ型の値を書いてください。');
    }
    const type: Type = { kind: 'array', of: withConst(elementType), length: values.length };
    const run = this.listInitializer({ ...type, of: elementType }, list, list.row);
    return { type, isLvalue: false, row: list.row, run };
  }

  /** Declares the variable of a range-based for loop, which each iteration binds to an element. */
  private rangeVariable(node: Syntax, element: Expr): { bind: Exec; type: Type } {
    const base = this.specifiedType(node, true);
    const declarator = fieldOf(node, 'declarator') as Syntax;
    const declared = this.applyDeclarator(base, declarator);
    const name = declared.name as string;
    if (declared.type.kind === 'reference') {
      const type = hasAuto(declared.type.to)
        ? referenceTo(this.deduceAutoReference(declared.type.to, element))
        : declared.type;
      const location = this.convert(element, type, node.row).run;
      const local = this.context.declareLocal(name, type, false);
      this.context.scope.names.set(name, { kind: 'local', local, isReference: true });
      return {
        bind: (frame) => {
          frame.slots[local.slot] = location(frame) as Ptr;
          return;
        },
        type: type.to,
      };
    }
    const type = this.deduceAuto(declared.type, element, node.row);
    const value = this.copyInitializer(type, element, node.row, false);
    const local = this.context.declareLocal(name, type, false);
    this.context.scope.names.set(name, { kind: 'local', local, isReference: false });
    const destroy = this.destroyerOf(type);
    if (destroy) this.context.scope.destructibles.set(local.slot, destroy);
    return {
      bind: this.fullExpression<undefined>((frame) => {
        frame.slots[local.slot] = new Box(value(frame));
        return;
      }),
      type,
    };
  }

  /** Whether learners write down a variable's value: numbers, characters, Booleans, and strings. */
  isAnswered(type: Type): boolean {
    return isArithmetic(type) || isLibraryClass(type, 'string');
  }

  private switchStatement(node: Syntax): Exec {
    const conditionClause = fieldOf(node, 'condition') as Syntax;
    const valueNode = fieldOf(conditionClause, 'value');
    if (!valueNode || valueNode.type === 'declaration')
      return this.unsupported(node.row, '条件の中の変数の宣言（switch (int x = f()) など）');
    const subject = this.rvalue(this.compileExpression(valueNode));
    if (!isInteger(subject.type))
      return this.error(node.row, `switch 文の () には整数を書いてください（${typeName(subject.type)}）。`);
    const promoted = this.arithmetic(
      '+',
      subject,
      { type: { kind: 'int', name: 'int' }, isLvalue: false, row: node.row, run: () => 0, constant: 0 },
      node.row
    ).type;
    const value = this.fullExpression(this.convert(subject, promoted, node.row).run);
    const body = fieldOf(node, 'body') as Syntax;
    return this.inScope(() => {
      this.context.switchDepth++;
      try {
        return this.compileSwitchBody(body, promoted, value);
      } finally {
        this.context.switchDepth--;
      }
    });
  }

  private compileSwitchBody(body: Syntax, promoted: Type, value: Eval<unknown>): Exec {
    const labels = new Map<string, number>();
    let defaultIndex: number | undefined;
    const statements: Exec[] = [];
    const uninitializedDeclarations: { index: number; execute: Exec }[] = [];
    let initializedBefore: Syntax | undefined;
    const compile = (nodes: readonly Syntax[]): void => {
      for (const node of nodes) {
        if (node.type === 'comment') continue;
        if (node.type !== 'case_statement') {
          const execute = this.compileStatement(node);
          if (node.type === 'declaration' && !this.hasSpecifier(node, 'static')) {
            if (this.initializes(node)) initializedBefore = node;
            else uninitializedDeclarations.push({ index: statements.length, execute });
          }
          statements.push(execute);
          continue;
        }
        if (initializedBefore) {
          this.error(
            node.row,
            `case の前の変数（${initializedBefore.text.split('\n')[0]}）の初期化を飛び越えて case に移れません。変数の宣言を {} で囲んでください。`
          );
        }
        const caseValue = fieldOf(node, 'value');
        if (caseValue) {
          const label = this.convert(this.compileExpression(caseValue), promoted, node.row);
          if (label.constant === undefined) this.error(node.row, 'case の値には定数を書いてください。');
          const key = String(label.constant);
          if (labels.has(key)) this.error(node.row, `case ${caseValue.text} が重複しています。`);
          labels.set(key, statements.length);
        } else {
          if (defaultIndex !== undefined) this.error(node.row, 'default が重複しています。');
          defaultIndex = statements.length;
        }
        compile(node.children.filter((child) => child.field !== 'value'));
      }
    };
    compile(body.type === 'compound_statement' ? body.children : [body]);
    return (frame) => {
      const key = String(value(frame) as number | bigint);
      const start = labels.get(key) ?? defaultIndex;
      if (start === undefined) return;
      for (const { index, execute } of uninitializedDeclarations) {
        if (index >= start) break;
        execute(frame);
      }
      for (let index = start; index < statements.length; index++) {
        const completion = statements[index](frame);
        if (completion === BREAK) return;
        if (completion !== undefined) return completion;
      }
      return;
    };
  }

  /** Whether a declaration initializes a variable, which a jump to a later `case` must not skip. */
  private initializes(declaration: Syntax): boolean {
    const type = fieldOf(declaration, 'type');
    const isClass = type !== undefined && !['primitive_type', 'sized_type_specifier'].includes(type.type);
    return fieldsOf(declaration, 'declarator').some((declarator) => declarator.type === 'init_declarator' || isClass);
  }

  private returnStatement(node: Syntax): Exec {
    const valueNode = node.children[0];
    const returnType = this.context.returnType;
    if (!valueNode) {
      if (returnType.kind !== 'void' && !this.context.fn?.isConstructor) {
        this.error(node.row, 'return 文に返す値を書いてください。');
      }
      return () => RETURN;
    }
    if (returnType.kind === 'void') {
      const expr = this.compileExpression(valueNode);
      if (expr.type.kind !== 'void') this.error(node.row, '戻り値の型が void の関数は値を返せません。');
      const run = this.fullExpression(expr.run);
      return (frame) => {
        run(frame);
        return RETURN;
      };
    }
    const value = this.returnValue(valueNode, returnType, node.row);
    const run = this.fullExpression(value);
    return (frame) => {
      frame.returnValue = run(frame);
      return RETURN;
    };
  }

  private returnValue(node: Syntax, returnType: Type, row: number): Eval<Value | Ptr> {
    if (node.type === 'initializer_list') {
      if (returnType.kind === 'reference') return this.error(row, '参照を返す関数は {...} を返せません。');
      this.context.noteReturn(undefined);
      return this.listInitializer(returnType, node, row);
    }
    const expr = this.compileExpression(node);
    if (returnType.kind === 'reference') {
      return this.convert(expr, returnType, row).run;
    }
    const local = this.returnedLocal(node, expr, returnType);
    this.context.noteReturn(local);
    if (!local) return this.copyInitializer(returnType, expr, row, false);
    const { slot } = local;
    const share: Eval<Value> = (frame) => {
      frame.nrvoSlot = slot;
      return (frame.slots[slot] as Box).value;
    };
    // An object that cannot be copied leaves the function as it is, as moving it would.
    if (returnType.kind === 'class' && returnType.cls.isNoncopyable) return share;
    const copy = this.copyInitializer(returnType, expr, row, false);
    const { namedReturns } = this.context;
    return (frame) => (namedReturns.has(local) ? share(frame) : copy(frame));
  }

  /** The local variable of the returned class type that a `return` names, which it may return without copying. */
  private returnedLocal(node: Syntax, expr: Expr, returnType: Type): LocalInfo | undefined {
    let name = node;
    while (name.type === 'parenthesized_expression' && name.children.length === 1) name = name.children[0];
    if (name.type !== 'identifier' || returnType.kind !== 'class') return undefined;
    if (expr.type.kind !== 'class' || expr.type.cls !== returnType.cls) return undefined;
    const entity = this.context.lookupLocal(name.text);
    return entity?.kind === 'local' && !entity.isReference ? entity.local : undefined;
  }

  private tryStatement(node: Syntax): Exec {
    if (fieldOf(node, 'body') === undefined) return this.error(node.row, 'try の後に {} を書いてください。');
    const body = this.compileBlock(fieldOf(node, 'body') as Syntax);
    const clauses = node.children.filter((child) => child.type === 'catch_clause');
    const handlers = clauses.map((clause, index) => {
      if (index < clauses.length - 1 && catchesAll(clause))
        this.error(clause.row, 'catch (...) は最後の catch にしてください。');
      return this.catchClause(clause);
    });
    if (handlers.length === 0) return this.error(node.row, 'try の後に catch を書いてください。');
    const matches = (exception: CppException): boolean => handlers.some((handler) => handler.matches(exception));
    return (frame) => {
      const { tryBlocks } = frame.runtime;
      tryBlocks.push(matches);
      let isActive = true;
      try {
        return body(frame);
      } catch (error) {
        if (!(error instanceof CppException)) throw error;
        tryBlocks.pop();
        isActive = false;
        const handler = handlers.find((candidate) => candidate.matches(error));
        if (!handler) throw error;
        return runHandler(frame, handler.run, error);
      } finally {
        if (isActive) tryBlocks.pop();
      }
    };
  }

  private catchClause(clause: Syntax): {
    matches: (error: CppException) => boolean;
    run: (frame: Frame, error: CppException) => Completion;
  } {
    const parameters = fieldOf(clause, 'parameters') as Syntax;
    const bodyNode = fieldOf(clause, 'body') as Syntax;
    const declarations = parameters.children.filter((child) => child.type !== 'comment');
    if (catchesAll(clause)) {
      const body = this.compileBlock(bodyNode);
      return { matches: () => true, run: (frame) => body(frame) };
    }
    if (declarations.length !== 1) return this.error(clause.row, 'catch の引数に型を1つ書いてください。');
    const [param] = declarations;
    const base = this.specifiedType(param);
    const declaratorNode = fieldOf(param, 'declarator');
    const declared = declaratorNode ? this.applyDeclarator(base, declaratorNode) : { name: undefined, type: base };
    const handlerType = declared.type;
    const caught = unqualified(nonReference(handlerType));
    if (caught.kind === 'void') this.error(clause.row, 'catch の型に void は使えません。');
    const incomplete = incompleteExceptionClass(caught);
    if (incomplete) this.error(clause.row, `まだ定義されていないクラス ${incomplete} は catch できません。`);
    if (caught.kind === 'class' && caught.cls.isAbstract && handlerType.kind !== 'reference') {
      this.error(clause.row, `${caught.cls.name} は抽象クラスなので、値として catch できません。`);
    }
    const scope = new Scope();
    this.context.scopes.push(scope);
    let body: Exec;
    let bind: (frame: Frame, error: CppException) => void = doNothing;
    try {
      if (declared.name) {
        const name = declared.name;
        if (handlerType.kind === 'reference') {
          const local = this.context.declareLocal(name, handlerType, false);
          scope.names.set(name, { kind: 'local', local, isReference: true });
          bind = (frame, error) => {
            frame.slots[local.slot] = error.location();
          };
        } else {
          const local = this.context.declareLocal(name, handlerType, false);
          scope.names.set(name, { kind: 'local', local, isReference: false });
          // A handler's variable is no candidate for returning without a copy (C++20 [class.copy.elision]).
          scope.returnSlots.delete(local);
          const copy = caught.kind === 'class' ? caught.cls : undefined;
          bind = (frame, error) => {
            const value = copy ? copy.operations?.copy(frame, error.value) : error.value;
            frame.slots[local.slot] = new Box(value as Value);
          };
          const destroy = this.destroyerOf(handlerType);
          if (destroy) scope.destructibles.set(local.slot, destroy);
        }
      }
      body = this.compileStatements(bodyNode.children);
    } finally {
      this.context.popScope();
    }
    const run = this.withScopeExit((frame) => {
      const { handling, tryBlocks } = frame.runtime;
      // A throw escaping the handler parameter initializer terminates, even when an outer handler matches.
      const outerHandlers = tryBlocks.splice(0);
      try {
        bind(frame, handling.at(-1) as CppException);
      } finally {
        tryBlocks.push(...outerHandlers);
      }
      return body(frame);
    }, scope);
    return { matches: (error) => exceptionMatches(handlerType, error.type), run: (frame) => run(frame) };
  }

  private throwStatement(node: Syntax): Exec {
    const valueNode = node.children[0];
    if (!valueNode) {
      return (frame) => {
        const current = frame.runtime.handling.at(-1);
        if (!current) throw new ProgramAbort('libc++abi: terminating');
        return frame.runtime.throwException(frame, current);
      };
    }
    const expr = this.compileExpression(valueNode);
    if (expr.type.kind === 'void') return this.error(node.row, '値を返さない関数（void）の結果は投げられません。');
    const type = expr.type.kind === 'array' ? ({ kind: 'pointer', to: expr.type.of } as Type) : unqualified(expr.type);
    const incomplete = incompleteExceptionClass(type);
    if (incomplete) this.error(node.row, `まだ定義されていないクラス ${incomplete} は投げられません。`);
    if (type.kind === 'class' && type.cls.isAbstract)
      this.error(node.row, `${type.cls.name} は抽象クラスなので投げられません。`);
    const value = this.fullExpression(this.copyInitializer(type, expr, node.row, false));
    return (frame) => frame.runtime.throwException(frame, new CppException(value(frame), type));
  }

  // Function bodies --------------------------------------------------------------------------------------------------

  /** Whether a type's objects need destruction (a user-provided destructor, a turtle, or such members). */
  needsDestruction(type: Type): boolean {
    return this.destroyerOf(type) !== undefined;
  }
}

function incompleteExceptionClass(type: Type): string | undefined {
  const object = type.kind === 'pointer' ? type.to : type;
  if (object.kind === 'class' && !object.cls.isComplete) return object.cls.name;
}

export function deducedType(pattern: Type, type: Type): Type {
  if (
    (pattern.kind === 'pointer' || pattern.kind === 'reference') &&
    (type.kind === 'pointer' || type.kind === 'reference')
  )
    return deducedType(pattern.to, type.to);
  return isConstType(pattern) ? withConst(type, false) : type;
}

function catchesAll(clause: Syntax): boolean {
  const parameters = fieldOf(clause, 'parameters');
  const tokens = parameters?.all.filter((parameter) => !['(', ')', 'comment'].includes(parameter.type));
  return tokens?.length === 1 && ['...', 'variadic_parameter'].includes(tokens[0].type);
}

/** Whether a handler of type `handler` catches an exception of type `thrown` (C++20 [except.handle]). */
function exceptionMatches(handler: Type, thrown: Type): boolean {
  const caught = nonReference(handler);
  if (sameType(caught, thrown, false)) return true;
  if (caught.kind === 'class' && thrown.kind === 'class') return isBaseAccessible(thrown.cls, caught.cls, undefined);
  if (caught.kind !== 'pointer' || (handler.kind === 'reference' && !isConstType(handler.to))) return false;
  if (thrown.kind === 'nullptr') return true;
  if (thrown.kind !== 'pointer') return false;
  const from = thrown.to;
  const to = caught.to;
  if (isConstType(from) && !isConstType(to)) return false;
  if (to.kind === 'void') return from.kind !== 'function';
  if (from.kind === 'class' && to.kind === 'class') return isBaseAccessible(from.cls, to.cls, undefined);
  return permitsQualificationConversion(from, to);
}

/** Runs a handler for an exception, which ends the exception unless the handler rethrows it. */
function runHandler(
  frame: Frame,
  run: (frame: Frame, exception: CppException) => Completion,
  exception: CppException
): Completion {
  frame.runtime.handling.push(exception);
  frame.pending.push(exception.value);
  exception.handlerCount++;
  let completion: Completion;
  try {
    completion = run(frame, exception);
  } catch (error) {
    exception.handlerCount--;
    if (error !== exception && error instanceof CppException) endException(frame, exception);
    throw error;
  } finally {
    frame.pending.pop();
    frame.runtime.handling.pop();
  }
  exception.handlerCount--;
  endException(frame, exception);
  return completion;
}

/**
 * Destroys an exception object when the last handler running for it exits other than by rethrowing it
 * (C++20 [except.throw]).
 */
function endException(frame: Frame, exception: CppException): void {
  if (exception.handlerCount > 0 || exception.isDestroyed) return;
  exception.isDestroyed = true;
  if (exception.type.kind === 'class') exception.type.cls.operations?.destroy?.(frame, exception.value);
  exception.endLifetime();
}

/** Ends a scope: destroys its objects, the last first, and makes its variables' storage unusable. */
export function endScope(
  frame: Frame,
  slots: readonly number[],
  destructibles: ReadonlyMap<number, (frame: Frame, value: Value) => void>
): void {
  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index];
    const store = frame.slots[slot];
    if (store instanceof Box && store.liveness === Liveness.Alive && frame.nrvoSlot !== slot) {
      if (store.value !== UNINIT) destructibles.get(slot)?.(frame, store.value);
      endLifetime(store);
    }
    frame.slots[slot] = undefined;
  }
}

function doNothing(): undefined {}

/**
 * Reads `f(x, y) = 0;` in a function body as an assignment to what a call returns. The grammar takes it for a
 * constructor declared pure virtual, which no function body can hold.
 */
function asZeroAssignment(node: Syntax): Syntax | undefined {
  const declarator = fieldOf(node, 'declarator');
  const clause = node.children.find((child) => child.type === 'pure_virtual_clause');
  if (fieldOf(node, 'type') || !clause || declarator?.type !== 'function_declarator') return undefined;
  const name = fieldOf(declarator, 'declarator');
  const parameters = fieldOf(declarator, 'parameters');
  if (name?.type !== 'identifier' || !parameters) return undefined;
  const args: Syntax[] = [];
  for (const parameter of parameters.children) {
    const type = fieldOf(parameter, 'type');
    if (
      parameter.type !== 'parameter_declaration' ||
      parameter.children.length !== 1 ||
      type?.type !== 'type_identifier'
    ) {
      return undefined;
    }
    args.push({ ...type, type: 'identifier', field: undefined });
  }
  const argumentList: Syntax = { ...parameters, type: 'argument_list', field: 'arguments', children: args, all: args };
  const callee: Syntax = { ...name, field: 'function' };
  const call: Syntax = {
    ...declarator,
    type: 'call_expression',
    field: 'left',
    children: [callee, argumentList],
    all: [callee, argumentList],
  };
  const zero: Syntax = { ...clause, type: 'number_literal', text: '0', field: 'right', children: [], all: [] };
  const equals: Syntax = { ...clause, type: '=', text: '=', isNamed: false, field: undefined, children: [], all: [] };
  const assignment: Syntax = {
    ...node,
    type: 'assignment_expression',
    field: undefined,
    children: [call, zero],
    all: [call, equals, zero],
  };
  return { ...node, type: 'expression_statement', children: [assignment], all: [assignment] };
}

/** Locates the member that the indices `path` lead to in the object a box holds. */
function memberAt(path: readonly number[]): (box: Box) => Ptr {
  return (box) => {
    let object = box.value as CObject;
    for (const index of path.slice(0, -1)) object = object.values[index] as CObject;
    return new Ptr(object, path.at(-1) as number);
  };
}
