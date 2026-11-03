import type {
  ClassDeclaration,
  CompilationUnit,
  ConstructorDeclaration,
  FieldDeclaration,
  MethodDeclaration,
  Span,
  VariableDeclarator,
} from './ast';
import type { Builtins } from './builtins';
import { type CompileOptions, type MethodContext, sameParameters } from './compilerBase';
import { canCompleteNormally } from './reachability';
import { type Frame, type Slot, UNASSIGNED } from './runtime';
import { StatementCompiler } from './statementCompiler';
import {
  type ClassInfo,
  createClass,
  type FieldInfo,
  isReference,
  isWidening,
  type MethodInfo,
  sameType,
  VOID,
} from './types';
import { type JavaObject, type Value } from './values';

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

class Compiler extends StatementCompiler {
  compile(unit: CompilationUnit): CompiledProgram {
    for (const declaration of unit.classes) {
      if (this.classes.has(declaration.name) || this.builtins.classes.has(declaration.name)) {
        this.error(declaration, `クラス ${declaration.name} はすでに定義されています。`);
      }
      const cls = createClass(declaration.name, undefined, false);
      cls.declaration = declaration;
      cls.isAbstract = declaration.modifiers.isAbstract;
      this.classes.set(declaration.name, cls);
    }
    const ordered = this.orderBySuperclass(unit.classes);
    for (const cls of ordered) this.declareMembers(cls);
    for (const cls of ordered) this.checkAbstractMethods(cls);
    for (const cls of ordered) this.compileBodies(cls);
    // An annotation no statement records a step for would silently drop the step authors meant to show.
    for (const row of this.stepIdByRow.keys()) {
      if (!this.usedStepRows.has(row)) {
        this.error(
          { row, endRow: row, start: 0, end: 0 },
          '// step は、式文、初期値のある変数宣言やフィールド、return 文、for 文の行に付けてください。'
        );
      }
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

  protected orderBySuperclass(declarations: ClassDeclaration[]): ClassInfo[] {
    const ordered: ClassInfo[] = [];
    const visiting = new Set<ClassInfo>();
    const visit = (cls: ClassInfo): void => {
      if (ordered.includes(cls)) return;
      const declaration = cls.declaration as ClassDeclaration;
      if (visiting.has(cls)) this.error(declaration, `クラス ${cls.name} の継承が循環しています。`);
      visiting.add(cls);
      const superclass = this.resolveSuperclass(declaration);
      if (!superclass.isBuiltin) visit(superclass);
      cls.superclass = superclass;
      visiting.delete(cls);
      ordered.push(cls);
    };
    for (const declaration of declarations) visit(this.classes.get(declaration.name) as ClassInfo);
    return ordered;
  }

  protected resolveSuperclass(declaration: ClassDeclaration): ClassInfo {
    if (!declaration.superclass) return this.builtins.objectClass;
    const type = this.resolveType(declaration.superclass);
    if (type.kind !== 'class') this.error(declaration.superclass, 'クラス以外は継承できません。');
    const superclass = type.cls;
    if (superclass === this.builtins.stringClass || (superclass.isBuiltin && superclass.constructors.length === 0)) {
      this.error(declaration.superclass, `クラス ${superclass.name} は継承できません。`);
    }
    return superclass;
  }

  protected declareMembers(cls: ClassInfo): void {
    // Superclasses come first, so their instance fields are final by now.
    const superclass = cls.superclass as ClassInfo;
    cls.instanceFieldCount = superclass.instanceFieldCount;
    cls.instanceFields = [...superclass.instanceFields];
    for (const member of (cls.declaration as ClassDeclaration).members) {
      if (member.kind === 'field') this.declareField(cls, member);
      else if (member.kind === 'method') this.declareMethod(cls, member);
      else if (member.kind === 'constructor') this.declareConstructor(cls, member);
    }
    if (cls.constructors.length === 0) {
      cls.constructors.push({
        name: cls.name,
        owner: cls,
        parameterTypes: [],
        returnType: VOID,
        isStatic: false,
        isAbstract: false,
        isConstructor: true,
        access: (cls.declaration as ClassDeclaration).modifiers.access,
        thrownTypes: [],
      });
    }
  }

  protected declareField(cls: ClassInfo, member: FieldDeclaration): void {
    const type = this.resolveType(member.type);
    for (const declarator of member.declarators) {
      if (cls.fields.has(declarator.name)) {
        this.error(declarator, `フィールド ${declarator.name} はすでに定義されています。`);
      }
      const field: FieldInfo = {
        name: declarator.name,
        owner: cls,
        type: this.withDimensions(type, declarator.extraDimensions),
        isStatic: member.modifiers.isStatic,
        isFinal: member.modifiers.isFinal,
        access: member.modifiers.access,
        slot: member.modifiers.isStatic ? cls.staticFieldCount++ : cls.instanceFieldCount++,
        declaration: member,
      };
      cls.fields.set(declarator.name, field);
      if (field.isStatic) cls.staticFields.push(field);
      else cls.instanceFields.push(field);
    }
  }

  protected declareMethod(cls: ClassInfo, member: MethodDeclaration): void {
    const { isAbstract } = member.modifiers;
    if (isAbstract && !cls.isAbstract) {
      this.error(member, `抽象メソッド ${member.name} は抽象クラスの中にしか書けません。`);
    }
    if (isAbstract && member.body) this.error(member, `抽象メソッド ${member.name} には本体を書けません。`);
    if (!isAbstract && !member.body) this.error(member, `メソッド ${member.name} に本体がありません。`);
    const method: MethodInfo = {
      name: member.name,
      owner: cls,
      parameterTypes: member.parameters.map((parameter) => this.resolveType(parameter.type)),
      returnType: member.returnType ? this.resolveType(member.returnType) : VOID,
      isStatic: member.modifiers.isStatic,
      isAbstract,
      isConstructor: false,
      access: member.modifiers.access,
      thrownTypes: member.throwsTypes.map((type) => this.resolveThrowable(type)),
      declaration: member,
    };
    if (cls.methods.some((other) => other.name === method.name && sameParameters(other, method))) {
      this.error(member, `メソッド ${member.name} はすでに定義されています。`);
    }
    this.checkOverride(cls, method, member);
    cls.methods.push(method);
  }

  protected declareConstructor(cls: ClassInfo, member: ConstructorDeclaration): void {
    if (member.name !== cls.name) this.error(member, `メソッド ${member.name} に戻り値の型がありません。`);
    const constructor: MethodInfo = {
      name: cls.name,
      owner: cls,
      parameterTypes: member.parameters.map((parameter) => this.resolveType(parameter.type)),
      returnType: VOID,
      isStatic: false,
      isAbstract: false,
      isConstructor: true,
      access: member.modifiers.access,
      thrownTypes: member.throwsTypes.map((type) => this.resolveThrowable(type)),
      declaration: member,
    };
    if (cls.constructors.some((other) => sameParameters(other, constructor))) {
      this.error(member, `コンストラクタ ${cls.name} はすでに定義されています。`);
    }
    cls.constructors.push(constructor);
  }

  protected checkOverride(cls: ClassInfo, method: MethodInfo, declaration: MethodDeclaration): void {
    for (let ancestor = cls.superclass; ancestor; ancestor = ancestor.superclass) {
      const overridden = ancestor.methods.find((other) => other.name === method.name && sameParameters(other, method));
      if (!overridden || overridden.access === 'private') continue;
      if (overridden.isStatic !== method.isStatic) {
        this.error(declaration, `メソッド ${method.name} の static の有無が親クラスと異なります。`);
      }
      const returnsCompatible =
        sameType(overridden.returnType, method.returnType) ||
        (isReference(method.returnType) &&
          isWidening(method.returnType, overridden.returnType, this.builtins.objectClass));
      if (!returnsCompatible) {
        this.error(declaration, `メソッド ${method.name} の戻り値の型が親クラスと異なります。`);
      }
      if (accessRank(method.access) < accessRank(overridden.access)) {
        this.error(declaration, `メソッド ${method.name} の公開範囲を親クラスより狭くすることはできません。`);
      }
      return;
    }
  }

  protected checkAbstractMethods(cls: ClassInfo): void {
    if (cls.isAbstract) return;
    for (let ancestor: ClassInfo | undefined = cls; ancestor; ancestor = ancestor.superclass) {
      for (const method of ancestor.methods) {
        if (!method.isAbstract) continue;
        const implementation = this.findOverride(cls, method);
        if (implementation.isAbstract) {
          this.error(
            cls.declaration as ClassDeclaration,
            `クラス ${cls.name} は抽象メソッド ${method.name} を実装していません。`
          );
        }
      }
    }
  }

  protected findOverride(cls: ClassInfo, method: MethodInfo): MethodInfo {
    for (let current: ClassInfo | undefined = cls; current; current = current.superclass) {
      const found = current.methods.find(
        (other) => other.name === method.name && !other.isStatic && sameParameters(other, method)
      );
      if (found) return found;
    }
    return method;
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
    const staticContext = this.newContext(cls, true, VOID);
    const staticInitializers = this.compileInitializers(staticContext, cls, true);
    if (staticInitializers.length > 0) {
      const locals = staticContext.locals;
      cls.initializeStatics = (frame) => {
        frame.locals.push(...locals.map((): Slot => UNASSIGNED));
        frame.localInfos.push(...locals);
        for (const initializer of staticInitializers) initializer(frame);
      };
    }
    for (const method of cls.methods) this.compileMethod(cls, method);
    for (const constructor of cls.constructors) this.compileConstructor(cls, constructor);
  }

  /** Compiles the field initializers and initializer blocks of one kind in textual order. */
  protected compileInitializers(context: MethodContext, cls: ClassInfo, isStatic: boolean): ((frame: Frame) => void)[] {
    const initializers: ((frame: Frame) => void)[] = [];
    for (const member of (cls.declaration as ClassDeclaration).members) {
      if (member.kind === 'field' && member.modifiers.isStatic === isStatic) {
        initializers.push(...this.compileFieldInitializers(context, cls, member.declarators, member));
      } else if (member.kind === 'initializer' && member.isStatic === isStatic) {
        const body = this.compileBlock(context, member.body);
        initializers.push((frame) => {
          if (body(frame)) throw new Error('An initializer completed abruptly');
        });
      }
    }
    return initializers;
  }

  protected compileMethod(cls: ClassInfo, method: MethodInfo): void {
    const member = method.declaration as MethodDeclaration;
    if (!member.body) return;
    const context = this.newContext(cls, method.isStatic, method.returnType);
    for (const [index, parameter] of member.parameters.entries()) {
      this.declareLocal(context, parameter, parameter.name, method.parameterTypes[index]);
    }
    const body = this.compileBlock(context, member.body, false);
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
    const lastInitialized = declarators.findLast((declarator) => declarator.initializer);
    const stepId = lastInitialized ? this.stepIdOf(declaration) : undefined;
    return declarators.flatMap((declarator) => {
      if (!declarator.initializer) return [];
      const declaratorStepId = declarator === lastInitialized ? stepId : undefined;
      const field = cls.fields.get(declarator.name) as FieldInfo;
      const value = this.compileInitializer(context, declarator.initializer, field.type);
      const { slot } = field;
      return [
        (frame: Frame) => {
          const result = value(frame);
          const slots = field.isStatic ? frame.runtime.staticsOf(frame, cls) : (frame.thisObject as JavaObject).fields;
          slots[slot] = result;
          if (declaratorStepId !== undefined) frame.runtime.onStep?.(declaratorStepId);
        },
      ];
    });
  }

  protected compileConstructor(cls: ClassInfo, constructor: MethodInfo): void {
    const declaration = constructor.declaration as ConstructorDeclaration | undefined;
    const context = this.newContext(cls, false, VOID);
    for (const [index, parameter] of (declaration?.parameters ?? []).entries()) {
      this.declareLocal(context, parameter, parameter.name, constructor.parameterTypes[index]);
    }
    const explicitCall = declaration?.explicitCall;
    const callsThis = explicitCall?.target === 'this';
    const targetClass = callsThis ? cls : (cls.superclass as ClassInfo);
    // Arguments of an explicit constructor call may not refer to the object under construction.
    const args = (explicitCall?.args ?? []).map((arg) => this.compileValue({ ...context, isStatic: true }, arg));
    const target = this.selectMethod(
      explicitCall ?? declaration ?? (cls.declaration as ClassDeclaration),
      targetClass.constructors.filter((candidate) => candidate !== constructor || !callsThis),
      args.map((arg) => arg.type),
      `コンストラクタ ${targetClass.name}`
    );
    const convertedArgs = args.map((arg, index) => this.convert(arg, target.parameterTypes[index]).run);
    // An implicit super() has no call in the source, so its frame is not a call that learners trace.
    const callRow = explicitCall?.row;
    // A constructor that delegates to this(...) leaves the initializers to the constructor it calls.
    const initializers = callsThis ? [] : this.compileInitializers(context, cls, false);
    const body = declaration ? this.compileBlock(context, declaration.body, false) : undefined;
    constructor.code = {
      locals: context.locals,
      run: (frame) => {
        this.invokeWithArguments(frame, target, frame.thisObject, convertedArgs, callRow);
        for (const initializer of initializers) initializer(frame);
        body?.(frame);
        return;
      },
    };
  }
}

function accessRank(access: string): number {
  return { private: 0, package: 1, protected: 2, public: 3 }[access] ?? 0;
}
