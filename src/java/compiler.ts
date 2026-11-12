import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import type {
  ArrayInitializer,
  Block,
  ClassDeclaration,
  CompilationUnit,
  ConstructorDeclaration,
  Expression,
  FieldDeclaration,
  InitializerBlock,
  MethodDeclaration,
  Span,
  VariableDeclarator,
} from './ast';
import type { Builtins } from './builtins';
import { anonymousDeclaration, type CompileOptions, type Eval, type Exec, type MethodContext } from './compilerBase';
import { memberBindings, methodView } from './conversions';
import { DeclarationCompiler, implicitModifiers } from './declarations';
import { checkDefiniteAssignment } from './definiteAssignment';
import { checkInitialization } from './initializationCheck';
import { localClassNamesOf } from './localClassNames';
import { canCompleteNormally } from './reachability';
import { type Frame, type Slot, UNASSIGNED } from './runtime';
import { isObjectCreation } from './stepRules';
import {
  asSuper,
  type ClassInfo,
  type ClassType,
  createClass,
  type FieldInfo,
  type JavaType,
  type MethodInfo,
  sameType,
  thisTypeOf,
  VOID,
} from './types';
import type { JavaObject, JavaString, Value } from './values';

export interface CompiledProgram {
  builtins: Builtins;
  classes: ClassInfo[];
  entryClass: ClassInfo;
  mainMethod: MethodInfo;
  /** For an instance `main`, the constructor that creates the object `main` runs on. */
  entryConstructor?: MethodInfo;
  /** The value of a constant variable, which exists before its class is initialized. */
  constantOf: (field: FieldInfo) => Value;
  /** The strings by text that the program's literals and constants evaluate to. */
  internedStrings: Map<string, JavaString>;
  /** The value of a static field's initializer when it is a constant expression. */
  initialConstantOf: (field: FieldInfo) => Value;
}

export function compileProgram(unit: CompilationUnit, options: CompileOptions = {}): CompiledProgram {
  return new Compiler(options).compile(unit);
}

class Compiler extends DeclarationCompiler {
  /** The binary names given to local and anonymous classes, which numbers the next ones as javac does. */
  private readonly localClassNames = new Set<string>();
  /** The binary names javac gives the local and anonymous classes in source order, by their declarations. */
  private readonly assignedLocalNames = new Map<object, string>();
  /** The local and anonymous classes compiled so far, by their declarations. */
  private readonly compiledLocalClasses = new Map<object, ClassInfo>();

  /**
   * The class a declaration already compiled to, which an instance initializer compiled for another constructor
   * creates again, when it reads no locals, which differ between the constructors.
   */
  private compiledWithoutCaptures(key: object): ClassInfo | undefined {
    const compiled = this.compiledLocalClasses.get(key);
    return compiled && this.localClasses.get(compiled)?.captures.length === 0 ? compiled : undefined;
  }

  /** A name for a local class that no class body declared in source, with the smallest number free for its name. */
  private nextLocalName(enclosing: ClassInfo, suffix: string): string {
    let number = 1;
    while (this.localClassNames.has(`${enclosing.binaryName}$${number}${suffix}`)) number++;
    const binaryName = `${enclosing.binaryName}$${number}${suffix}`;
    this.localClassNames.add(binaryName);
    return binaryName;
  }

  compile(unit: CompilationUnit): CompiledProgram {
    this.registerClasses(unit);
    this.resolveImports(unit.imports);
    const ordered = this.orderBySupertypes();
    this.checkSealing(ordered);
    for (const cls of ordered) this.withTypeScope(cls, () => this.declareMembers(cls));
    for (const cls of ordered) this.checkAbstractMethods(cls);
    for (const cls of ordered) this.withTypeScope(cls, () => this.compileBodies(cls));
    // An annotation no declaration claims would silently leave the steps authors meant to hide.
    for (const row of this.atomicRows) {
      if (!this.usedAtomicRows.has(row)) this.error({ row, endRow: row, start: 0, end: 0 }, misplacedAtomicMessage);
    }
    const { entryClass, mainMethod, entryConstructor } = this.findEntry(ordered, unit.classes);
    return {
      builtins: this.builtins,
      classes: ordered,
      entryClass,
      mainMethod,
      entryConstructor,
      constantOf: (field) => this.constantOf(field),
      internedStrings: this.internedStrings,
      initialConstantOf: (field) => this.initialConstantOf(field),
    };
  }

  /**
   * Finds the `main` method to launch as the JDK's launcher does (JEP 512): a non-private `main` that takes a
   * `String[]`, else one that takes nothing, either of which may be an instance method of a class with a non-private
   * constructor that takes nothing.
   */
  protected findEntry(
    ordered: ClassInfo[],
    declarations: ClassDeclaration[]
  ): { entryClass: ClassInfo; mainMethod: MethodInfo; entryConstructor?: MethodInfo } {
    const stringArray: JavaType = { kind: 'array', element: this.builtins.stringClass.type };
    for (const declaration of declarations) {
      const cls = ordered.find((candidate) => candidate.declaration === declaration) as ClassInfo;
      const candidates = cls.methods.filter(
        (method) => method.name === 'main' && method.returnType.kind === 'void' && method.access !== 'private'
      );
      const main =
        candidates.find(
          (method) => method.parameterTypes.length === 1 && sameType(method.parameterTypes[0], stringArray)
        ) ?? candidates.find((method) => method.parameterTypes.length === 0);
      if (!main) continue;
      if (main.isStatic) return { entryClass: cls, mainMethod: main };
      const entryConstructor = cls.constructors.find(
        (constructor) => constructor.parameterTypes.length === 0 && constructor.access !== 'private'
      );
      if (entryConstructor && !cls.isAbstract) return { entryClass: cls, mainMethod: main, entryConstructor };
    }
    return this.error(
      declarations[0] ?? { row: 0, endRow: 0, start: 0, end: 0 },
      'プログラムを始める部分が見つかりません。public static void main(String[] args) を確認してください。'
    );
  }

  protected compileBodies(cls: ClassInfo): void {
    if (cls.declaration) {
      const names = localClassNamesOf(cls.declaration as ClassDeclaration, cls.binaryName, this.localClassNames);
      for (const [key, name] of names) this.assignedLocalNames.set(key, name);
    }
    const staticContext = { ...this.newContext(cls, true, VOID), initializes: 'static' as const };
    const staticInitializers = [
      ...this.compileEnumConstants(staticContext, cls),
      ...this.compileInitializers(staticContext, cls, true),
    ];
    // Definite assignment reads the constants that compiling the initializers records.
    const notEffectivelyFinal = checkInitialization({
      ...this.initializationOf(cls, true),
      span: cls.declaration as ClassDeclaration,
    });
    this.checkCaptures(staticContext, notEffectivelyFinal);
    if (staticInitializers.length > 0) {
      const locals = staticContext.locals;
      cls.initializeStatics = (frame) => {
        frame.locals.push(...locals.map((): Slot => UNASSIGNED));
        frame.localInfos.push(...locals);
        for (const initializer of staticInitializers) initializer(frame);
      };
    }
    for (const method of cls.methods) {
      this.withInstanceTypeVariables(cls, !method.isStatic, () =>
        this.withTypeVariables(method.typeParameters ?? [], () => this.compileMethod(cls, method))
      );
    }
    this.withInstanceTypeVariables(cls, true, () => {
      for (const constructor of cls.constructors) {
        this.withTypeVariables(constructor.typeParameters ?? [], () => this.compileConstructor(cls, constructor));
      }
    });
  }

  /** Compiles the creation of an enum's constants, which run before its other static initializers. */
  protected compileEnumConstants(context: MethodContext, cls: ClassInfo): ((frame: Frame) => void)[] {
    const constants = cls.staticFields.filter((field) => field.enumConstant);
    return constants.map((field, ordinal) => {
      const constant = field.enumConstant as NonNullable<FieldInfo['enumConstant']>;
      const args = constant.args.map((arg) => this.compileArgument(context, arg));
      const constructor = this.selectMethod(
        constant,
        cls.constructors,
        args.map((arg) => arg.type),
        `コンストラクタ ${cls.name}`
      );
      this.checkThrown(context, constant, constructor.thrownTypes);
      const convertedArgs = this.convertArguments(context, constructor, args, constant.args);
      const name = this.internedString(constant.name);
      const { objectClass, objectConstructor } = this.enumConstantClass(context, cls, constant, constructor);
      // Traces leave enum constants out of the variables, so creating one shows only its constructor's steps.
      return (frame: Frame) => {
        const object = frame.runtime.allocateObject(frame, objectClass);
        object.enumConstant = { name, ordinal };
        frame.temporaries.push(object);
        try {
          this.invokeWithArguments(frame, objectConstructor, object, convertedArgs, constant.row);
        } finally {
          frame.temporaries.pop();
        }
        frame.runtime.staticsOf(frame, cls)[field.slot] = object;
      };
    });
  }

  /** The class of an enum constant's object: the enum, or the anonymous subclass that the constant's body declares. */
  protected enumConstantClass(
    context: MethodContext,
    cls: ClassInfo,
    constant: NonNullable<FieldInfo['enumConstant']>,
    constructor: MethodInfo
  ): { objectClass: ClassInfo; objectConstructor: MethodInfo } {
    if (!constant.body) return { objectClass: cls, objectConstructor: constructor };
    const declaration = anonymousDeclaration(constant, constant.body);
    const subclass = this.compileLocalClass(context, declaration, {
      superConstructor: constructor,
      base: cls.type as ClassType,
    });
    return { objectClass: subclass, objectConstructor: subclass.constructors[0] };
  }

  /** The blank final fields and the initializers of one kind, which assign those fields first. */
  protected initializationOf(
    cls: ClassInfo,
    isStatic: boolean
  ): { blankFinals: string[]; initializers: (Block | Expression | ArrayInitializer)[] } {
    const members = initializingMembersOf(cls, isStatic);
    return {
      blankFinals: members.flatMap((member) =>
        member.kind === 'field' && member.modifiers.isFinal
          ? member.declarators.filter((declarator) => !declarator.initializer).map((declarator) => declarator.name)
          : []
      ),
      initializers: members.flatMap((member): (Block | Expression | ArrayInitializer)[] => {
        if (member.kind === 'initializer') return [member.body];
        return member.declarators.flatMap((declarator) => (declarator.initializer ? [declarator.initializer] : []));
      }),
    };
  }

  /** Compiles the field initializers and initializer blocks of one kind in textual order. */
  protected compileInitializers(context: MethodContext, cls: ClassInfo, isStatic: boolean): ((frame: Frame) => void)[] {
    return initializingMembersOf(cls, isStatic).flatMap((member) => {
      if (member.kind === 'field') return this.compileFieldInitializers(context, cls, member.declarators, member);
      const body = this.compileBlock({ ...context, isInitializerBlock: true }, member.body);
      return [
        (frame: Frame) => {
          if (body(frame)) throw new Error('An initializer completed abruptly');
        },
      ];
    });
  }

  protected compileMethod(cls: ClassInfo, method: MethodInfo): void {
    const member = method.declaration as MethodDeclaration | undefined;
    if (!member?.body) return;
    const context = this.newContext(cls, method.isStatic, method.returnType, method.thrownTypes);
    for (const [index, parameter] of member.parameters.entries()) {
      this.declareLocal(context, parameter, parameter.name, method.parameterTypes[index]);
    }
    const body = this.compileBlock(context, member.body, false);
    this.checkCaptures(context, checkDefiniteAssignment(member.parameters, member.body));
    if (method.returnType.kind !== 'void' && canCompleteNormally(member.body)) {
      this.error({ ...member.body, row: member.body.endRow }, `メソッド ${method.name} に return 文がありません。`);
    }
    method.code = {
      locals: context.locals,
      run: (frame) => {
        const completion = body(frame);
        return completion?.kind === 'return' ? completion.value : undefined;
      },
    };
  }

  protected compileFieldInitializers(
    context: MethodContext,
    cls: ClassInfo,
    declarators: VariableDeclarator[],
    declaration: Span
  ): ((frame: Frame) => void)[] {
    const fieldOf = (declarator: VariableDeclarator): FieldInfo => cls.fields.get(declarator.name) as FieldInfo;
    // Learners see a static field's constant initial value before its class initializes, so assigning it shows nothing.
    const shown = declarators.filter((declarator) => {
      const field = fieldOf(declarator);
      return declarator.initializer && !(field.isStatic && this.initialConstantOf(field) !== undefined);
    });
    const onlyCalls = shown.every(({ initializer }) => initializer !== undefined && isObjectCreation(initializer));
    const initializers = declarators.flatMap((declarator): Exec[] => {
      if (!declarator.initializer) return [];
      const field = fieldOf(declarator);
      const value = this.compileInitializer(context, declarator.initializer, field.type);
      const { slot } = field;
      return [
        (frame) => {
          const result = value(frame);
          const slots = field.isStatic ? frame.runtime.staticsOf(frame, cls) : (frame.thisObject as JavaObject).fields;
          slots[slot] = result;
          return;
        },
      ];
    });
    if (initializers.length === 0) return [];
    const initializeAll: Exec = (frame) => {
      for (const initialize of initializers) initialize(frame);
      return;
    };
    // The declaration records one step after all its declarators, as a local declaration does.
    const run = shown.length > 0 ? this.withStep(declaration, initializeAll, onlyCalls) : initializeAll;
    return [(frame: Frame) => void run(frame)];
  }

  /** Compiles the this(...) or super(...) call that starts a constructor, implicitly super() when none is written. */
  protected explicitConstructorCall(
    context: MethodContext,
    cls: ClassInfo,
    constructor: MethodInfo,
    declaration: ConstructorDeclaration | undefined
  ): { target: MethodInfo; convertedArgs: Eval[] } {
    const explicitCall = declaration?.explicitCall;
    const callsThis = explicitCall?.target === 'this';
    const targetClass = callsThis ? cls : (cls.superclass as ClassInfo);
    // Arguments of an explicit constructor call may not refer to the object under construction.
    const argSyntax = explicitCall?.args ?? [];
    const args = argSyntax.map((arg) =>
      this.compileArgument({ ...context, isStatic: true, isBeforeConstructorCall: true }, arg)
    );
    const targetBindings = memberBindings(
      callsThis ? thisTypeOf(cls) : asSuper(thisTypeOf(cls), targetClass),
      targetClass
    );
    const span = explicitCall ?? declaration ?? (cls.declaration as ClassDeclaration);
    const target = this.selectMethod(
      span,
      targetClass.constructors
        .filter((candidate) => candidate !== constructor || !callsThis)
        .map((candidate) => methodView(candidate, targetBindings)),
      args.map((arg) => arg.type),
      `コンストラクタ ${targetClass.name}`
    );
    this.checkThrown(context, span, target.thrownTypes);
    return {
      target,
      convertedArgs: this.convertArguments(
        { ...context, isStatic: true, isBeforeConstructorCall: true },
        target,
        args,
        argSyntax
      ),
    };
  }

  /** An anonymous class's constructor passes its arguments on to the superclass constructor that its creation chose. */
  protected forwardingCall(
    context: MethodContext,
    constructor: MethodInfo,
    target: MethodInfo
  ): { target: MethodInfo; convertedArgs: Eval[] } {
    const span = constructor.owner.declaration as ClassDeclaration;
    const convertedArgs = constructor.parameterTypes.map((type, index): Eval => {
      // A name no source can write cannot clash with the program's variables.
      const slot = this.declareLocal(context, span, `\u0000${index}`, type);
      return (frame) => frame.locals[slot] as Value;
    });
    this.checkThrown(context, span, target.thrownTypes);
    return { target, convertedArgs };
  }

  /** Declares and compiles a class written inside a method body, with the classes nested in it. */
  // code-gauge-allow functionCognitiveComplexity 23 -- Registering, declaring, and compiling a local class and its nested classes share their state.
  // code-gauge-allow functionNcss 44 -- Registering, declaring, and compiling a local class and its nested classes share their state.
  protected compileLocalClass(
    context: MethodContext,
    declaration: ClassDeclaration,
    anonymous?: { superConstructor: MethodInfo | undefined; base: ClassType }
  ): ClassInfo {
    const { kind, name } = declaration;
    if (!anonymous) this.checkLocalClassDeclaration(declaration);
    const scope = this.localTypeScopes.at(-1) as Map<string, ClassInfo>;
    const key = anonymous ? declaration.members : declaration;
    const compiled = this.compiledWithoutCaptures(key);
    if (compiled) {
      if (!anonymous) scope.set(name, compiled);
      return compiled;
    }
    const binaryName = this.assignedLocalNames.get(key) ?? this.nextLocalName(context.cls, anonymous ? '' : name);
    const cls = createClass(anonymous ? binaryName : name, undefined, false);
    cls.kind = kind;
    cls.declaration = declaration;
    cls.enclosing = context.cls;
    cls.binaryName = binaryName;
    this.compiledLocalClasses.set(key, cls);
    // An anonymous class is final too.
    Object.assign(cls, implicitModifiers(declaration), anonymous && { isFinal: true });
    // Local interfaces and enums are static, so they neither belong to an instance nor read the method's locals.
    const isStatic = kind !== 'class' || declaration.isRecord === true;
    cls.hasOuterInstance = !isStatic && !context.isStatic;
    if (!isStatic) this.localClasses.set(cls, { definingContext: context, captures: [] });
    if (anonymous) this.anonymousBases.set(cls, anonymous.base);
    else scope.set(name, cls);
    const first = this.declaredClasses.length;
    this.declaredClasses.push(cls);
    for (const member of declaration.members) {
      if (member.kind === 'class' || member.kind === 'interface' || member.kind === 'enum') {
        this.registerClass(member, cls);
      }
    }
    const ordered = this.orderBySupertypes(this.declaredClasses.slice(first));
    for (const declared of ordered) this.withTypeScope(declared, () => this.declareMembers(declared));
    const superConstructor = anonymous?.superConstructor;
    if (superConstructor) {
      cls.constructors = [
        {
          ...superConstructor,
          name: cls.name,
          owner: cls,
          access: 'package',
          isVarargs: false,
          varargsStart: undefined,
          declaration: undefined,
          native: undefined,
          code: undefined,
          declared: undefined,
          forwardsTo: superConstructor.declared ?? superConstructor,
        },
      ];
    }
    for (const declared of ordered) this.checkAbstractMethods(declared);
    for (const declared of ordered) this.withTypeScope(declared, () => this.compileBodies(declared));
    return cls;
  }

  private checkLocalClassDeclaration(declaration: ClassDeclaration): void {
    const { modifiers, name } = declaration;
    if (modifiers.access !== 'package' || modifiers.isStatic) {
      this.error(
        declaration,
        `メソッドの中で宣言するクラス ${name} には、public や private や static を付けられません。`
      );
    }
    if (this.localTypeScopes.some((types) => types.has(name))) {
      this.error(declaration, `クラス ${name} はすでに定義されています。`);
    }
  }

  protected compileConstructor(cls: ClassInfo, constructor: MethodInfo): void {
    const declaration = constructor.declaration as ConstructorDeclaration | undefined;
    const context = { ...this.newContext(cls, false, VOID, constructor.thrownTypes), initializes: 'instance' as const };
    for (const [index, parameter] of (declaration?.parameters ?? []).entries()) {
      this.declareLocal(context, parameter, parameter.name, constructor.parameterTypes[index]);
    }
    // The prologue's locals and local classes stay in scope for the explicit constructor call and the body.
    this.localTypeScopes.push(new Map());
    try {
      this.compileConstructorCode(cls, constructor, declaration, context);
    } finally {
      this.localTypeScopes.pop();
    }
  }

  private compileConstructorCode(
    cls: ClassInfo,
    constructor: MethodInfo,
    declaration: ConstructorDeclaration | undefined,
    context: MethodContext
  ): void {
    const returned = declaration?.prologue && findReturn(declaration.prologue);
    if (returned) this.error(returned, 'super(...) や this(...) の呼び出しより前には return 文を書けません。');
    const prologue =
      declaration?.prologue &&
      this.compileStatements({ ...context, isStatic: true, isBeforeConstructorCall: true }, declaration.prologue);
    const { target, convertedArgs } = constructor.forwardsTo
      ? this.forwardingCall(context, constructor, constructor.forwardsTo)
      : this.explicitConstructorCall(context, cls, constructor, declaration);
    const explicitCall = declaration?.explicitCall;
    const callsThis = explicitCall?.target === 'this';
    // An implicit super() has no call in the source, so its frame is not a call that learners trace.
    const callRow = explicitCall?.row;
    // A constructor that delegates to this(...) leaves the initializers to the constructor it calls.
    const initializers = callsThis ? [] : this.compileInitializers(context, cls, false);
    const body = declaration ? this.compileBlock(context, declaration.body, false) : undefined;
    const notEffectivelyFinal = checkInitialization({
      ...this.initializationOf(cls, false),
      constructorDeclaration: declaration,
      span: declaration ?? (cls.declaration as ClassDeclaration),
    });
    this.checkCaptures(context, notEffectivelyFinal);
    constructor.code = {
      locals: context.locals,
      run: (frame) => {
        prologue?.(frame);
        this.invokeWithArguments(frame, target.declared ?? target, frame.thisObject, convertedArgs, callRow);
        for (const initializer of initializers) initializer(frame);
        body?.(frame);
        return;
      },
    };
  }
}

/** The field declarations and initializer blocks of one kind, in the textual order in which they run. */
function initializingMembersOf(cls: ClassInfo, isStatic: boolean): (FieldDeclaration | InitializerBlock)[] {
  return (cls.declaration as ClassDeclaration).members.filter(
    (member): member is FieldDeclaration | InitializerBlock =>
      // An interface's fields are implicitly static.
      (member.kind === 'field' && (member.modifiers.isStatic || cls.kind === 'interface') === isStatic) ||
      (member.kind === 'initializer' && member.isStatic === isStatic)
  );
}

/**
 * The first `return` statement among `nodes`, outside the lambdas and classes written there, whose own bodies may
 * return.
 */
function findReturn(nodes: unknown): Span | undefined {
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const found = findReturn(node);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof nodes !== 'object' || nodes === null) return undefined;
  const node = nodes as { kind?: string; body?: unknown };
  if (node.kind === 'return') return node as unknown as Span;
  if (node.kind === 'lambda' || node.kind === 'localClass') return undefined;
  return findReturn(
    Object.entries(node)
      .filter(([key]) => !(node.kind === 'new' && key === 'body'))
      .map(([, value]) => value)
  );
}
