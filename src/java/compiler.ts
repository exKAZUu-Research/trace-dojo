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
import { type CompileOptions, type Exec, type MethodContext } from './compilerBase';
import { memberBindings, methodView } from './conversions';
import { DeclarationCompiler } from './declarations';
import { checkDefiniteAssignment, checkInitialization } from './definiteAssignment';
import { canCompleteNormally } from './reachability';
import { type Frame, type Slot, UNASSIGNED } from './runtime';
import { isObjectCreation } from './stepRules';
import { asSuper, type ClassInfo, type FieldInfo, type MethodInfo, sameType, thisTypeOf, VOID } from './types';
import type { JavaObject, Value } from './values';

export interface CompiledProgram {
  builtins: Builtins;
  classes: ClassInfo[];
  entryClass: ClassInfo;
  mainMethod: MethodInfo;
  /** The value of a constant variable, which exists before its class is initialized. */
  constantOf: (field: FieldInfo) => Value;
  /** The value of a static field's initializer when it is a constant expression. */
  initialConstantOf: (field: FieldInfo) => Value;
}

export function compileProgram(unit: CompilationUnit, options: CompileOptions = {}): CompiledProgram {
  return new Compiler(options).compile(unit);
}

class Compiler extends DeclarationCompiler {
  compile(unit: CompilationUnit): CompiledProgram {
    this.registerClasses(unit);
    const ordered = this.orderBySupertypes();
    for (const cls of ordered) this.withTypeScope(cls, () => this.declareMembers(cls));
    for (const cls of ordered) this.checkAbstractMethods(cls);
    for (const cls of ordered) this.withTypeScope(cls, () => this.compileBodies(cls));
    // An annotation no declaration claims would silently leave the steps authors meant to hide.
    for (const row of this.atomicRows) {
      if (!this.usedAtomicRows.has(row)) this.error({ row, endRow: row, start: 0, end: 0 }, misplacedAtomicMessage);
    }
    const { entryClass, mainMethod } = this.findEntry(ordered, unit.classes);
    return {
      builtins: this.builtins,
      classes: ordered,
      entryClass,
      mainMethod,
      constantOf: (field) => this.constantOf(field),
      initialConstantOf: (field) => this.initialConstantOf(field),
    };
  }

  protected findEntry(
    ordered: ClassInfo[],
    declarations: ClassDeclaration[]
  ): { entryClass: ClassInfo; mainMethod: MethodInfo } {
    for (const declaration of declarations) {
      const cls = ordered.find((candidate) => candidate.declaration === declaration) as ClassInfo;
      const main = cls.methods.find(
        (method) =>
          method.name === 'main' &&
          method.isStatic &&
          method.returnType.kind === 'void' &&
          method.parameterTypes.length === 1 &&
          sameType(method.parameterTypes[0], {
            kind: 'array',
            element: this.builtins.stringClass.type,
          })
      );
      if (main) return { entryClass: cls, mainMethod: main };
    }
    return this.error(
      declarations[0] ?? { row: 0, endRow: 0, start: 0, end: 0 },
      'プログラムを始める部分が見つかりません。public static void main(String[] args) を確認してください。'
    );
  }

  protected compileBodies(cls: ClassInfo): void {
    const staticContext = { ...this.newContext(cls, true, VOID), initializes: 'static' as const };
    const staticInitializers = [
      ...this.compileEnumConstants(staticContext, cls),
      ...this.compileInitializers(staticContext, cls, true),
    ];
    // Definite assignment reads the constants that compiling the initializers records.
    checkInitialization({ ...this.initializationOf(cls, true), span: cls.declaration as ClassDeclaration });
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
      for (const constructor of cls.constructors) this.compileConstructor(cls, constructor);
    });
  }

  /** Compiles the creation of an enum's constants, which run before its other static initializers. */
  protected compileEnumConstants(context: MethodContext, cls: ClassInfo): ((frame: Frame) => void)[] {
    const constants = cls.staticFields.filter((field) => field.enumConstant);
    return constants.map((field, ordinal) => {
      const constant = field.enumConstant as NonNullable<FieldInfo['enumConstant']>;
      const args = constant.args.map((arg) => this.compileValue(context, arg));
      const constructor = this.selectMethod(
        constant,
        cls.constructors,
        args.map((arg) => arg.type),
        `コンストラクタ ${cls.name}`
      );
      this.checkThrown(context, constant, constructor.thrownTypes);
      const convertedArgs = args.map(
        (arg, index) => this.convert(arg, constructor.parameterTypes[index], 'invocation', constant.args[index]).run
      );
      const name = this.internedString(constant.name);
      // Traces leave enum constants out of the variables, so creating one shows only its constructor's steps.
      return (frame: Frame) => {
        const object = frame.runtime.allocateObject(frame, cls);
        object.enumConstant = { name, ordinal };
        frame.temporaries.push(object);
        try {
          this.invokeWithArguments(frame, constructor, object, convertedArgs, constant.row);
        } finally {
          frame.temporaries.pop();
        }
        frame.runtime.staticsOf(frame, cls)[field.slot] = object;
      };
    });
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
    checkDefiniteAssignment(member.parameters, member.body);
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

  protected compileConstructor(cls: ClassInfo, constructor: MethodInfo): void {
    const declaration = constructor.declaration as ConstructorDeclaration | undefined;
    const context = { ...this.newContext(cls, false, VOID, constructor.thrownTypes), initializes: 'instance' as const };
    for (const [index, parameter] of (declaration?.parameters ?? []).entries()) {
      this.declareLocal(context, parameter, parameter.name, constructor.parameterTypes[index]);
    }
    const explicitCall = declaration?.explicitCall;
    const callsThis = explicitCall?.target === 'this';
    const targetClass = callsThis ? cls : (cls.superclass as ClassInfo);
    // Arguments of an explicit constructor call may not refer to the object under construction.
    const argSyntax = explicitCall?.args ?? [];
    const args = argSyntax.map((arg) => this.compileValue({ ...context, isStatic: true }, arg));
    const targetBindings = memberBindings(
      callsThis ? thisTypeOf(cls) : asSuper(thisTypeOf(cls), targetClass),
      targetClass
    );
    const target = this.selectMethod(
      explicitCall ?? declaration ?? (cls.declaration as ClassDeclaration),
      targetClass.constructors
        .filter((candidate) => candidate !== constructor || !callsThis)
        .map((candidate) => methodView(candidate, targetBindings)),
      args.map((arg) => arg.type),
      `コンストラクタ ${targetClass.name}`
    );
    this.checkThrown(context, explicitCall ?? declaration ?? (cls.declaration as ClassDeclaration), target.thrownTypes);
    const convertedArgs = args.map(
      (arg, index) => this.convert(arg, target.parameterTypes[index], 'invocation', argSyntax[index]).run
    );
    // An implicit super() has no call in the source, so its frame is not a call that learners trace.
    const callRow = explicitCall?.row;
    // A constructor that delegates to this(...) leaves the initializers to the constructor it calls.
    const initializers = callsThis ? [] : this.compileInitializers(context, cls, false);
    const body = declaration ? this.compileBlock(context, declaration.body, false) : undefined;
    checkInitialization({
      ...this.initializationOf(cls, false),
      constructorDeclaration: declaration,
      span: declaration ?? (cls.declaration as ClassDeclaration),
    });
    constructor.code = {
      locals: context.locals,
      run: (frame) => {
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
      (member.kind === 'field' && member.modifiers.isStatic === isStatic) ||
      (member.kind === 'initializer' && member.isStatic === isStatic)
  );
}
