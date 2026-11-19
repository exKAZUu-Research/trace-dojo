import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import { AssignmentCompiler } from './assignmentCompiler';
import type {
  Arguments as ArgumentsSyntax,
  Block,
  ClassDeclaration,
  ConstructorDeclaration,
  Expression,
  ExtensionDeclaration,
  FieldDeclaration,
  FormalParameter,
  FormalParameters,
  FunctionDeclaration,
  Library,
  MethodDeclaration,
  Span,
  TypeSyntax,
  VariableDeclaration,
} from './ast';
import type { CompiledFunction, FunctionSpec } from './callCompiler';
import {
  ClassInfo,
  type ConstructorImpl,
  type ConstructorInfo,
  type FieldMember,
  type Member,
  type MethodMember,
} from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import {
  type Declaration,
  type ExtensionInfo,
  type GlobalVariable,
  type LibraryEnv,
  type TopLevelFunction,
  type TypeAlias,
} from './environment';
import { SHORTED } from './expressionCompiler';
import { type DartThrow, Frame, type FunctionInfo, type Runtime, type TypeEnv } from './runtime';
import type { FunctionContext } from './scope';
import type { Exec, GenExec } from './statementCompiler';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  type InterfaceType,
  interfaceType,
  isNullable,
  isSubtype,
  isTop,
  NEVER,
  nonNullable,
  objectType,
  substitute,
  type TypeParam,
  TypeParam as TypeParamCtor,
  typeParamType,
  typeToString,
  VOID,
} from './types';
import {
  type Arguments,
  type Callable,
  Cell,
  DartClosure,
  DartObject,
  DartTypeValue,
  NO_ARGUMENTS,
  UNINITIALIZED,
  type Value,
} from './values';

/** The natives that `external` members of the interpreter's own libraries bind to, by `Class.member` or name. */
export type NativeTable = ReadonlyMap<string, Callable | ConstructorImpl>;

export interface CompileOptions {
  atomicRows?: ReadonlySet<number>;
}

/** Libraries compiled together, sharing one table of globals. */
export interface CompiledLibraries {
  libraries: Map<string, LibraryEnv>;
  globals: GlobalVariable[];
}

export interface CompiledProgram {
  main: TopLevelFunction;
  globals: GlobalVariable[];
  /** The globals the program itself declares, which traces show. */
  programGlobals: GlobalVariable[];
  mainTakesArguments: boolean;
}

const INITIALIZING = Symbol('initializing') as unknown as Value;

interface ClassWork {
  cls: ClassInfo;
  declaration: ClassDeclaration;
}

/** Compiles the declarations of a library: classes, members, constructors, extensions, and top-level members. */
export class Compiler extends AssignmentCompiler {
  private readonly classWork: ClassWork[] = [];
  private readonly extensionWork: { ext: ExtensionInfo; declaration: ExtensionDeclaration }[] = [];
  private readonly deferredBodies: (() => void)[] = [];
  private extensionCount = 0;

  constructor(
    library: LibraryEnv,
    isLibraryCode: boolean,
    atomicRows: ReadonlySet<number> | undefined,
    globals: GlobalVariable[],
    private readonly natives: NativeTable
  ) {
    super(library, isLibraryCode, atomicRows, globals);
  }

  // Phases

  /** Declares the library's top-level names, before any of them is resolved. */
  declareAll(syntax: Library): void {
    for (const declaration of syntax.declarations) {
      switch (declaration.kind) {
        case 'class': {
          const cls = new ClassInfo(
            declaration.name,
            declaration.classKind,
            this.isLibraryCode ? this.library.name : ''
          );
          cls.declaration = declaration;
          cls.modifiers = { ...declaration.modifiers };
          if (declaration.classKind === 'mixin') cls.modifiers.isAbstract = true;
          this.declareName(declaration.name, { kind: 'class', cls }, declaration);
          this.classWork.push({ cls, declaration });
          break;
        }
        case 'typeAlias': {
          const alias: TypeAlias = {
            name: declaration.name,
            typeParams: [],
            aliased: undefined,
            library: this.library.name,
          };
          this.declareName(declaration.name, { kind: 'alias', alias }, declaration);
          break;
        }
        case 'extension': {
          const ext: ExtensionInfo = {
            name: declaration.name,
            typeParams: [],
            onType: DYNAMIC,
            members: new Map(),
            setters: new Map(),
            staticMembers: new Map(),
            staticSetters: new Map(),
            library: this.library.name,
          };
          const key = declaration.name ?? `\0extension${this.extensionCount++}`;
          this.declareName(key, { kind: 'extension', ext }, declaration);
          this.extensionWork.push({ ext, declaration });
          break;
        }
        case 'function': {
          this.declareTopLevelFunction(declaration);
          break;
        }
        case 'variables': {
          // Variables are declared after the types they may use are resolved.
          break;
        }
      }
    }
  }

  private declareName(name: string, declaration: Declaration, span: Span): void {
    const existing = this.library.declarations.get(name);
    if (existing) {
      if (existing.kind === 'accessor' && declaration.kind === 'accessor') return;
      this.error(span, `${name} という名前は、既に宣言されています。`);
    }
    this.library.declarations.set(name, declaration);
  }

  private declareTopLevelFunction(declaration: FunctionDeclaration): void {
    const fn: TopLevelFunction = {
      name: declaration.name,
      type: functionType([], DYNAMIC),
      impl: undefined,
      row: declaration.row,
      library: this.library.name,
      isAtomic: false,
    };
    if (declaration.functionKind === 'function') {
      this.declareName(declaration.name, { kind: 'function', fn }, declaration);
      return;
    }
    const existing = this.library.declarations.get(declaration.name);
    if (existing && existing.kind !== 'accessor')
      this.error(declaration, `${declaration.name} という名前は、既に宣言されています。`);
    const accessor =
      existing?.kind === 'accessor' ? existing : { kind: 'accessor' as const, getter: undefined, setter: undefined };
    if (declaration.functionKind === 'getter') {
      if (accessor.getter) this.error(declaration, `getter ${declaration.name} は、既に宣言されています。`);
      accessor.getter = fn;
    } else {
      if (accessor.setter) this.error(declaration, `setter ${declaration.name} は、既に宣言されています。`);
      accessor.setter = fn;
    }
    this.library.declarations.set(declaration.name, accessor);
  }

  /** Resolves type aliases, class headers, member signatures, and top-level signatures, in that order. */
  resolveAll(syntax: Library): void {
    for (const declaration of syntax.declarations) {
      if (declaration.kind !== 'typeAlias') continue;
      const entry = this.library.declarations.get(declaration.name);
      if (entry?.kind !== 'alias') continue;
      const { alias } = entry;
      alias.typeParams.push(...this.declareTypeParams(declaration.typeParameters));
      alias.aliased = this.withTypeParams(alias.typeParams, () => this.resolveType(declaration.aliased));
    }
    for (const work of this.classWork) this.declareTypeParamsOf(work);
    for (const work of this.classWork) this.resolveHeader(work);
    this.checkHierarchy();
    for (const work of this.classWork) this.layoutClass(work.cls);
    for (const work of this.orderedClassWork()) this.declareMembers(work);
    for (const { ext, declaration } of this.extensionWork) this.declareExtension(ext, declaration);
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'function') this.resolveTopLevelSignature(declaration);
    }
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'variables') this.declareTopLevelVariables(declaration);
    }
    for (const work of this.classWork) this.checkClass(work);
  }

  /** Compiles every body. */
  compileAll(syntax: Library): void {
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'function') this.compileTopLevelFunction(declaration);
    }
    for (const { ext, declaration } of this.extensionWork) this.compileExtension(ext, declaration);
    for (const body of this.deferredBodies) body();
    this.deferredBodies.length = 0;
    if (this.atomicRows && !this.isLibraryCode) {
      for (const row of this.atomicRows) if (!this.usedAtomicRows.has(row)) this.error({ row }, misplacedAtomicMessage);
    }
  }

  // Classes

  private declareTypeParamsOf({ cls, declaration }: ClassWork): void {
    cls.typeParams.push(...declaration.typeParameters.map((parameter) => new TypeParamCtor(parameter.name)));
  }

  /** Classes ordered so that each comes after its superclass, mixins, and `on` types. */
  private orderedClassWork(): ClassWork[] {
    const ordered: ClassWork[] = [];
    const seen = new Set<ClassInfo>();
    const byClass = new Map(this.classWork.map((work) => [work.cls, work]));
    const visit = (work: ClassWork): void => {
      if (seen.has(work.cls)) return;
      seen.add(work.cls);
      for (const supertype of work.cls.directSupertypes) {
        const dependency = byClass.get(supertype.cls.mixinOf ?? supertype.cls) ?? byClass.get(supertype.cls);
        if (dependency) visit(dependency);
        let current: ClassInfo | undefined = supertype.cls;
        while (current?.mixinOf) {
          const mixin = byClass.get(current.mixinOf);
          if (mixin) visit(mixin);
          current = current.superclass?.cls;
        }
      }
      ordered.push(work);
    };
    for (const work of this.classWork) visit(work);
    return ordered;
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- The rules for superclasses, mixins, and interfaces of each kind of class.
  private resolveHeader({ cls, declaration }: ClassWork): void {
    this.withTypeParams(cls.typeParams, () => {
      for (const [index, parameter] of declaration.typeParameters.entries()) {
        if (parameter.bound) cls.typeParams[index].bound = this.resolveType(parameter.bound);
      }
      const resolveSuper = (syntax: TypeSyntax, role: string): InterfaceType => {
        const type = this.resolveType(syntax);
        if (type.kind !== 'interface' || type.nullable) {
          return this.error(syntax, `${typeToString(type)} は${role}にできません。`);
        }
        this.checkSubtypeAllowed(cls, type.cls, role, syntax);
        return type;
      };
      if (declaration.classKind === 'enum') {
        cls.superclass = interfaceType(coreTypes.enum);
      } else if (declaration.classKind === 'mixin') {
        cls.onTypes = declaration.onTypes.map((type) => resolveSuper(type, 'mixin の on の型'));
      } else if (declaration.classKind === 'extensionType') {
        cls.superclass = undefined;
      } else if (declaration.superclass) {
        cls.superclass = resolveSuper(declaration.superclass, 'スーパークラス');
        if (cls.superclass.cls.kind === 'mixin')
          this.error(
            declaration.superclass,
            `mixin ${cls.superclass.cls.name} は extends できません。with を使ってください。`
          );
      } else if (cls !== coreTypes.object && !(this.isLibraryCode && cls.name === 'Object')) {
        cls.superclass = objectType();
      }
      if (declaration.mixins.length > 0) {
        let base = cls.superclass ?? objectType();
        for (const mixinSyntax of declaration.mixins) {
          const mixin = resolveSuper(mixinSyntax, 'mixin');
          if (mixin.cls.kind !== 'mixin' && mixin.cls.kind !== 'mixinClass' && !this.isLibraryCode) {
            this.error(mixinSyntax, `${mixin.cls.name} は mixin ではないので、with には書けません。`);
          }
          base = this.mixinApplication(base, mixin, cls);
        }
        cls.superclass = base;
      }
      cls.interfaces = declaration.interfaces.map((type) => resolveSuper(type, '実装するインターフェース'));
      if (declaration.classKind === 'extensionType') {
        const parameter = declaration.primaryConstructor?.parameters.positional[0];
        if (!parameter?.type) this.error(declaration, '拡張型には、表す値の型を書いてください。');
        cls.representationType = this.resolveType(parameter.type as TypeSyntax);
        cls.representationName = parameter.name;
      }
    });
    for (const supertype of cls.directSupertypes) {
      const supercls = supertype.cls;
      if (supercls.modifiers.isSealed && supercls.library === cls.library) supercls.subclasses.push(cls);
    }
    if (cls.superclass?.cls.mixinOf) {
      // Sealed classes count the class written in the source, not its mixin applications.
      let current: ClassInfo | undefined = cls.superclass.cls;
      while (current?.mixinOf) current = current.superclass?.cls;
      if (current?.modifiers.isSealed && current.library === cls.library && !current.subclasses.includes(cls))
        current.subclasses.push(cls);
    }
  }

  /** Rejects extending or implementing classes whose modifiers forbid it outside their library. */
  private checkSubtypeAllowed(cls: ClassInfo, supercls: ClassInfo, role: string, span: Span): void {
    if (supercls.library === cls.library) return;
    const name = supercls.name;
    const isExtends = role === 'スーパークラス';
    const isImplements = role === '実装するインターフェース';
    if (
      ['int', 'double', 'num', 'bool', 'String', 'Null', 'Never', 'Record', 'Function'].includes(name) &&
      supercls.isLibrary &&
      !(name === 'Function' && isImplements)
    ) {
      this.error(span, `${name} は${role}にできません。`);
    }
    if (supercls.modifiers.isFinal || supercls.modifiers.isSealed)
      this.error(span, `${name} は final か sealed なので、このライブラリの外では${role}にできません。`);
    if (supercls.modifiers.isInterface && isExtends)
      this.error(span, `${name} は interface なので、このライブラリの外では extends できません。`);
    if (supercls.modifiers.isBase && isImplements)
      this.error(span, `${name} は base なので、このライブラリの外では implements できません。`);
    if (
      (supercls.modifiers.isBase || supercls.modifiers.isFinal) &&
      !cls.modifiers.isBase &&
      !cls.modifiers.isFinal &&
      !cls.modifiers.isSealed &&
      isExtends
    ) {
      this.error(
        span,
        `${name} は base なので、それを継承する ${cls.name} にも base・final・sealed のどれかを付けてください。`
      );
    }
  }

  /** The class `superclass with mixin`, whose members are the mixin's. */
  private mixinApplication(superclass: InterfaceType, mixin: InterfaceType, owner: ClassInfo): InterfaceType {
    const application = new ClassInfo(`${superclass.cls.name} with ${mixin.cls.name}`, 'class', owner.library);
    application.typeParams.push(...owner.typeParams);
    application.superclass = superclass;
    application.interfaces = [mixin];
    application.mixinOf = mixin.cls;
    application.modifiers = { isAbstract: true, isSealed: false, isBase: false, isFinal: false, isInterface: false };
    (application as ClassInfo & { mixinArgs?: readonly DartType[] }).mixinArgs = mixin.args;
    this.pendingApplications.push({ application, mixin });
    return interfaceType(
      application,
      owner.typeParams.map((param) => typeParamType(param))
    );
  }

  private readonly pendingApplications: { application: ClassInfo; mixin: InterfaceType }[] = [];

  private checkHierarchy(): void {
    for (const { cls, declaration } of this.classWork) {
      const seen = new Set<ClassInfo>();
      let current: ClassInfo | undefined = cls;
      while (current) {
        if (seen.has(current)) this.error(declaration, `クラス ${cls.name} の継承が循環しています。`);
        seen.add(current);
        current = current.superclass?.cls;
      }
    }
  }

  /** Lays out an object's fields: the superclass's first, then those the class declares. */
  private layoutClass(cls: ClassInfo, laidOut = new Set<ClassInfo>()): void {
    if (laidOut.has(cls)) return;
    laidOut.add(cls);
    const superclass = cls.superclass?.cls;
    if (superclass) this.layoutClass(superclass, laidOut);
    void superclass;
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Each kind of member declares itself differently.
  private declareMembers({ cls, declaration }: ClassWork): void {
    this.currentClass = cls;
    try {
      this.withTypeParams(cls.typeParams, () => {
        this.applyPendingMixins(cls);
        cls.fieldCount = cls.superclass?.cls.fieldCount ?? 0;
        if (declaration.classKind === 'extensionType') this.declareRepresentation(cls, declaration);
        if (declaration.primaryConstructor && declaration.classKind !== 'extensionType') {
          this.declarePrimaryConstructorFields(cls, declaration);
        }
        for (const member of declaration.members) {
          if (member.kind === 'field') this.declareField(cls, member);
          else if (member.kind === 'method') this.declareMethod(cls, member);
        }
        if (declaration.classKind === 'enum') this.declareEnumValues(cls, declaration);
        for (const member of declaration.members)
          if (member.kind === 'constructor') this.declareConstructor(cls, member);
        if (declaration.primaryConstructor) this.declarePrimaryConstructor(cls, declaration);
        if (
          cls.constructors.size === 0 &&
          declaration.classKind !== 'mixin' &&
          declaration.classKind !== 'extensionType'
        ) {
          this.declareDefaultConstructor(cls, declaration);
        }
      });
    } finally {
      this.currentClass = undefined;
    }
    cls.resetCaches();
  }

  /** Copies a mixin's members into the applications that use it, once the mixin's own members are declared. */
  private applyPendingMixins(cls: ClassInfo): void {
    let current = cls.superclass?.cls;
    const applications: ClassInfo[] = [];
    while (current?.mixinOf) {
      applications.unshift(current);
      current = current.superclass?.cls;
    }
    for (const application of applications) {
      if (application.members.size > 0 || application.fieldCount > 0) continue;
      const mixin = application.mixinOf as ClassInfo;
      application.fieldCount = application.superclass?.cls.fieldCount ?? 0;
      const mixinArgs = (application as ClassInfo & { mixinArgs?: readonly DartType[] }).mixinArgs ?? [];
      const map = new Map(mixin.typeParams.map((param, index) => [param, mixinArgs[index] ?? DYNAMIC]));
      const slotMap = new Map<number, number>();
      for (const field of mixin.fields) {
        const copy: FieldMember = {
          ...field,
          owner: application,
          type: substitute(field.type, map),
          slot: application.fieldCount++,
        };
        slotMap.set(field.slot, copy.slot);
        application.fields.push(copy);
      }
      for (const [name, member] of mixin.members)
        application.members.set(name, this.copyMixinMember(member, application, map, slotMap));
      for (const [name, member] of mixin.setters)
        application.setters.set(name, this.copyMixinMember(member, application, map, slotMap));
      (application as ClassInfo & { mixinFieldSlots?: Map<number, number> }).mixinFieldSlots = slotMap;
      application.resetCaches();
    }
  }

  private copyMixinMember(
    member: Member,
    application: ClassInfo,
    map: Map<TypeParam, DartType>,
    slotMap: Map<number, number>
  ): Member {
    if (member.kind === 'field') {
      return {
        ...member,
        owner: application,
        type: substitute(member.type, map),
        slot: slotMap.get(member.slot) ?? member.slot,
      };
    }
    const copy = { ...member, owner: application, type: substitute(member.type, map) } as Member;
    // The copy runs the mixin's code, which may be compiled after the application is declared.
    if ('impl' in copy) {
      const original = member as MethodMember;
      (copy as MethodMember).impl = (runtime, receiver, args, typeArgs, callRow) =>
        (original.impl as Callable)(runtime, receiver, args, typeArgs, callRow);
    }
    return copy;
  }

  private declareRepresentation(cls: ClassInfo, declaration: ClassDeclaration): void {
    const name = cls.representationName as string;
    const type = cls.representationType as DartType;
    const getter: Member = {
      kind: 'getter',
      name,
      owner: cls,
      isStatic: false,
      isAbstract: false,
      row: declaration.row,
      type,
      impl: (_runtime, receiver) => receiver,
    };
    cls.members.set(name, getter);
  }

  private declarePrimaryConstructorFields(cls: ClassInfo, declaration: ClassDeclaration): void {
    const primary = declaration.primaryConstructor as NonNullable<ClassDeclaration['primaryConstructor']>;
    for (const parameter of [...primary.parameters.positional, ...primary.parameters.named]) {
      if (
        parameter.binding !== 'plain' ||
        (!parameter.isFinal && !(parameter as FormalParameter & { isVar?: boolean }).isVar)
      )
        continue;
      if (!parameter.type) this.error(parameter, `フィールド ${parameter.name} の型を書いてください。`);
      this.declareField(cls, {
        ...parameter,
        kind: 'field',
        isStatic: false,
        isFinal: parameter.isFinal,
        isConst: false,
        isLate: false,
        isCovariant: false,
        isExternal: false,
        isAbstract: false,
        type: parameter.type,
        variables: [{ ...parameter, name: parameter.name, initializer: undefined }],
        annotations: [],
      });
    }
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Static, late, final, abstract, and external fields differ.
  private declareField(cls: ClassInfo, declaration: FieldDeclaration): void {
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    for (const variable of declaration.variables) {
      const { name } = variable;
      if (cls.members.has(name) || cls.staticMembers.has(name))
        this.error(variable, `${name} という名前は、このクラスで既に宣言されています。`);
      let type = declaredType;
      type ??=
        this.inheritedFieldType(cls, name) ??
        (variable.initializer ? this.inferInitializerType(variable.initializer, declaration.isStatic, cls) : DYNAMIC);
      if (declaration.isStatic) {
        this.declareStaticField(cls, declaration, variable, type);
        continue;
      }
      if (declaration.isConst)
        this.error(variable, 'インスタンスのフィールドは const にできません。static const にしてください。');
      if (cls.kind === 'extensionType' && !declaration.isAbstract && !declaration.isExternal) {
        this.error(variable, '拡張型には、インスタンスのフィールドを宣言できません。');
      }
      if (cls.kind === 'enum' && !declaration.isFinal)
        this.error(variable, '列挙型のフィールドは final にしてください。');
      if (declaration.isAbstract || declaration.isExternal) {
        this.declareAbstractField(cls, name, type, declaration.isFinal, variable.row, declaration.isExternal);
        continue;
      }
      const slot = cls.fieldCount++;
      const field: FieldMember = {
        kind: 'field',
        name,
        owner: cls,
        isStatic: false,
        isAbstract: false,
        row: variable.row,
        type,
        isFinal: declaration.isFinal,
        isLate: declaration.isLate,
        isConst: false,
        isCovariant: declaration.isCovariant,
        hasInitializer: variable.initializer !== undefined,
        slot,
      };
      cls.fields.push(field);
      if (declaration.isLate) {
        this.declareLateField(cls, field, variable.initializer);
        continue;
      }
      cls.members.set(name, field);
      if (!declaration.isFinal) cls.setters.set(name, field);
    }
  }

  /** A field without a type takes the type of the member it overrides, as Dart infers. */
  private inheritedFieldType(cls: ClassInfo, name: string): DartType | undefined {
    for (const supertype of cls.directSupertypes) {
      const resolved = this.interfaceMember(supertype, name, false);
      if (resolved && resolved.member.kind !== 'method') return resolved.type;
    }
    return undefined;
  }

  /** The type of a field's or variable's initializer, compiled ahead of the body to infer the declaration's type. */
  private inferInitializerType(initializer: Expression, isStatic: boolean, cls: ClassInfo | undefined): DartType {
    const compiled = this.inTemporaryFunction(isStatic, cls, () => this.compileExpression(initializer));
    if (compiled.type.kind === 'null') return DYNAMIC;
    return compiled.type;
  }

  /** Runs `run` in a function context of its own, as initializers compile outside any function. */
  private inTemporaryFunction<T>(
    isStatic: boolean,
    cls: ClassInfo | undefined,
    run: () => T,
    isInitializer = false
  ): T {
    const savedFn = this.fn;
    const savedFlow = this.flow;
    const savedRecords = this.recordsSteps;
    const info = this.newFunctionInfo('initializer', undefined, false);
    this.fn = new FunctionContextCtor(undefined, info, {
      returnType: undefined,
      isGenerator: false,
      thisClass: cls,
      thisType: cls?.thisType,
      hasThis: !isStatic && !isInitializer && cls !== undefined,
      extensionOn: undefined,
      isInitializer,
      isConstructor: false,
    });
    this.flow = FlowCtor.start();
    try {
      return run();
    } finally {
      this.fn = savedFn;
      this.flow = savedFlow;
      this.recordsSteps = savedRecords;
    }
  }

  private declareStaticField(
    cls: ClassInfo,
    declaration: FieldDeclaration,
    variable: FieldDeclaration['variables'][number],
    type: DartType
  ): void {
    if (declaration.isConst && !variable.initializer)
      this.error(variable, `const の ${variable.name} には初期値が必要です。`);
    if (
      !variable.initializer &&
      !declaration.isLate &&
      !isNullable(type) &&
      !this.isLibraryCode &&
      !declaration.isExternal
    ) {
      this.error(variable, `null にならない static なフィールド ${variable.name} には、初期値が必要です。`);
    }
    const global = this.newGlobal(
      variable.name,
      `${cls.name}.${variable.name}`,
      type,
      declaration,
      variable.initializer !== undefined,
      cls,
      variable.row
    );
    const field: FieldMember = {
      kind: 'field',
      name: variable.name,
      owner: cls,
      isStatic: true,
      isAbstract: false,
      row: variable.row,
      type,
      isFinal: declaration.isFinal || declaration.isConst,
      isLate: declaration.isLate,
      isConst: declaration.isConst,
      isCovariant: false,
      hasInitializer: variable.initializer !== undefined,
      slot: global.slot,
    };
    cls.staticMembers.set(variable.name, field);
    if (!field.isFinal || declaration.isLate) cls.staticSetters.set(variable.name, field);
    const { initializer } = variable;
    if (initializer) {
      this.deferredBodies.push(() => {
        this.currentClass = cls;
        try {
          this.withTypeParams([], () => this.compileGlobalInitializer(global, initializer, declaration.isConst, cls));
        } finally {
          this.currentClass = undefined;
        }
      });
    }
  }

  private newGlobal(
    name: string,
    displayName: string,
    type: DartType,
    declaration: { isFinal: boolean; isConst: boolean; isLate: boolean },
    hasInitializer: boolean,
    owner: ClassInfo | undefined,
    row: number
  ): GlobalVariable {
    const global: GlobalVariable = {
      name,
      displayName,
      type,
      slot: this.globals.length,
      isFinal: declaration.isFinal || declaration.isConst,
      isConst: declaration.isConst,
      isLate: declaration.isLate,
      hasInitializer,
      initialize: undefined,
      initialValue: hasInitializer ? undefined : declaration.isLate ? undefined : { value: undefined },
      library: this.library.name,
      row: this.isLibraryCode ? undefined : row,
      owner,
    };
    this.globals.push(global);
    return global;
  }

  /** Compiles a global's initializer, which runs the first time the global is read. */
  private compileGlobalInitializer(
    global: GlobalVariable,
    initializer: Expression,
    isConst: boolean,
    cls: ClassInfo | undefined
  ): void {
    this.inTemporaryFunction(true, cls, () => {
      const info = this.fn.info;
      info.name = global.displayName;
      let compiled = this.withConstContext(isConst, () => this.compileExpression(initializer, global.type));
      if (isConst && !compiled.isConst)
        this.error(initializer, `const の ${global.name} の初期値は、定数でなければなりません。`);
      compiled = this.coerce(
        compiled,
        global.type,
        initializer,
        (from, to) => `${from} 型の値は、${to} 型の ${global.name} に代入できません。`
      );
      if (compiled.constValue && (compiled.isConst || isPrimitiveConstant(compiled)))
        global.initialValue = { value: compiled.constValue.value };
      const { run } = compiled;
      const fn = this.fn;
      global.initialize = (runtime) => {
        const frame = new Frame(runtime, info, fn.slotCount, undefined, [], new Map(), undefined);
        runtime.enter(frame);
        try {
          return run(frame);
        } finally {
          runtime.exit(frame);
        }
      };
    });
  }

  private declareAbstractField(
    cls: ClassInfo,
    name: string,
    type: DartType,
    isFinal: boolean,
    row: number,
    isExternal: boolean
  ): void {
    const getterImpl = isExternal ? this.native(`${cls.name}.${name}`) : undefined;
    cls.members.set(name, {
      kind: 'getter',
      name,
      owner: cls,
      isStatic: false,
      isAbstract: !isExternal,
      row,
      type,
      impl: getterImpl as Callable | undefined,
    });
    if (!isFinal) {
      const setterImpl = isExternal ? this.native(`${cls.name}.${name}=`) : undefined;
      cls.setters.set(name, {
        kind: 'setter',
        name,
        owner: cls,
        isStatic: false,
        isAbstract: !isExternal,
        row,
        type,
        impl: setterImpl as Callable | undefined,
      });
    }
  }

  /** A late field reads and writes its slot through accessors that check whether it has been initialized. */
  private declareLateField(cls: ClassInfo, field: FieldMember, initializer: Expression | undefined): void {
    const { slot, name } = field;
    const getter: Member = {
      kind: 'getter',
      name,
      owner: cls,
      isStatic: false,
      isAbstract: false,
      row: field.row,
      type: field.type,
      impl: (runtime, receiver) => {
        const object = receiver as DartObject;
        const value = object.fields[slot];
        if (value !== UNINITIALIZED) return value;
        const initialize = lateInit;
        if (!initialize)
          return runtime.throwError('LateInitializationError', '', [`Field '${name}' has not been initialized.`]);
        const computed = initialize(runtime, object);
        if (field.isFinal && object.fields[slot] !== UNINITIALIZED) {
          runtime.throwError('LateInitializationError', '', [
            `Field '${name}' has been assigned during initialization.`,
          ]);
        }
        object.fields[slot] = computed;
        return computed;
      },
    };
    let lateInit: ((runtime: Runtime, receiver: DartObject) => Value) | undefined;
    if (initializer) {
      this.deferredBodies.push(() => {
        this.currentClass = cls;
        try {
          this.withTypeParams(cls.typeParams, () =>
            this.inTemporaryFunction(false, cls, () => {
              const compiled = this.coerce(
                this.compileExpression(initializer, field.type),
                field.type,
                initializer,
                (from, to) => `${from} 型の値は、${to} 型のフィールド ${name} に代入できません。`
              );
              const fn = this.fn;
              const { run } = compiled;
              lateInit = (runtime, receiver) => {
                const frame = new Frame(
                  runtime,
                  fn.info,
                  fn.slotCount,
                  receiver,
                  [],
                  this.typeEnvOf(runtime, receiver, cls),
                  undefined
                );
                runtime.enter(frame);
                try {
                  return run(frame);
                } finally {
                  runtime.exit(frame);
                }
              };
            })
          );
        } finally {
          this.currentClass = undefined;
        }
      });
    }
    cls.members.set(name, getter);
    if (!field.isFinal || !initializer) {
      cls.setters.set(name, {
        kind: 'setter',
        name,
        owner: cls,
        isStatic: false,
        isAbstract: false,
        row: field.row,
        type: field.type,
        impl: (runtime, receiver, args) => {
          const object = receiver as DartObject;
          if (field.isFinal && object.fields[slot] !== UNINITIALIZED) {
            runtime.throwError('LateInitializationError', '', [`Field '${name}' has already been initialized.`]);
          }
          object.fields[slot] = args.positional[0];
          return;
        },
      });
    }
  }

  // code-gauge-allow functionCognitiveComplexity 40 -- Methods, accessors, and operators, static or not.
  private declareMethod(cls: ClassInfo, declaration: MethodDeclaration, owner: ClassInfo | ExtensionInfo = cls): void {
    const typeParams = this.declareTypeParams(declaration.typeParameters);
    const isExtension = !(owner instanceof ClassInfo);
    const { type, positionalTypes, namedTypes } = this.withTypeParams(typeParams, () =>
      this.signatureOf(
        declaration.parameters,
        declaration.returnType,
        typeParams,
        isExtension ? undefined : cls,
        declaration
      )
    );
    const { name, methodKind } = declaration;
    const isAbstract = !declaration.body && !declaration.isExternal;
    if (isAbstract && !isExtension && !cls.isAbstract && cls.kind !== 'enum' && !this.isLibraryCode) {
      this.error(declaration, `${cls.name} は抽象クラスではないので、本体のないメンバー ${name} は書けません。`);
    }
    if (methodKind === 'operator' && declaration.isStatic) this.error(declaration, '演算子は static にできません。');
    this.checkOperatorArity(declaration);
    const nativeKey = `${isExtension ? (owner as ExtensionInfo).name : cls.name}.${methodKind === 'setter' ? `${name}=` : name}`;
    const impl = declaration.isExternal ? (this.native(nativeKey) as Callable) : undefined;
    let member: Member;
    if (methodKind === 'getter') {
      member = {
        kind: 'getter',
        name,
        owner: cls,
        isStatic: declaration.isStatic,
        isAbstract,
        row: declaration.row,
        type: type.returnType,
        impl,
      };
    } else if (methodKind === 'setter') {
      if (declaration.parameters.positional.length !== 1 || declaration.parameters.named.length > 0) {
        this.error(declaration, 'setter の引数は 1 つにしてください。');
      }
      member = {
        kind: 'setter',
        name,
        owner: cls,
        isStatic: declaration.isStatic,
        isAbstract,
        row: declaration.row,
        type: positionalTypes[0] ?? DYNAMIC,
        impl,
      };
    } else {
      member = {
        kind: 'method',
        name,
        owner: cls,
        isStatic: declaration.isStatic,
        isAbstract,
        row: declaration.row,
        type,
        impl,
        isOperator: methodKind === 'operator',
      };
    }
    const target = isExtension ? (owner as ExtensionInfo) : cls;
    const table =
      methodKind === 'setter'
        ? declaration.isStatic
          ? target.staticSetters
          : target.setters
        : declaration.isStatic
          ? target.staticMembers
          : target.members;
    if (table.has(name)) this.error(declaration, `${name} という名前は、既に宣言されています。`);
    if (
      !isExtension &&
      methodKind !== 'setter' &&
      (declaration.isStatic ? cls.members.has(name) : cls.staticMembers.has(name))
    ) {
      this.error(declaration, `${name} という名前は、既に宣言されています。`);
    }
    table.set(name, member);
    if (declaration.body) {
      const body = declaration.body;
      this.deferredBodies.push(() =>
        this.compileMethodBody(cls, owner, declaration, member, typeParams, positionalTypes, namedTypes, type, body)
      );
    }
  }

  private checkOperatorArity(declaration: MethodDeclaration): void {
    if (declaration.methodKind !== 'operator') return;
    const count = declaration.parameters.positional.length;
    const expected = declaration.name === '[]=' ? 2 : declaration.name === '~' || declaration.name === 'unary-' ? 0 : 1;
    if (
      count !== expected ||
      declaration.parameters.named.length > 0 ||
      declaration.parameters.requiredCount !== count
    ) {
      this.error(
        declaration,
        `演算子 ${declaration.name === 'unary-' ? '-' : declaration.name} の引数の数が正しくありません。`
      );
    }
  }

  /** The function type of a signature, inferring omitted types from the member it overrides. */
  signatureOf(
    parameters: FormalParameters,
    returnTypeSyntax: TypeSyntax | undefined,
    typeParams: TypeParam[],
    cls?: ClassInfo,
    declaration?: MethodDeclaration
  ): { type: FunctionType; positionalTypes: DartType[]; namedTypes: Map<string, DartType> } {
    const overridden =
      cls && declaration && !declaration.isStatic ? this.overriddenSignature(cls, declaration) : undefined;
    const positionalTypes = parameters.positional.map((parameter, index) => {
      if (parameter.type) return this.resolveType(parameter.type);
      if (overridden?.kind === 'function') return overridden.positional[index] ?? DYNAMIC;
      if (overridden && declaration?.methodKind === 'setter') return overridden;
      return DYNAMIC;
    });
    const namedTypes = new Map(
      parameters.named.map((parameter) => {
        if (parameter.type) return [parameter.name, this.resolveType(parameter.type)];
        const inherited =
          overridden?.kind === 'function'
            ? overridden.named.find((named) => named.name === parameter.name)?.type
            : undefined;
        return [parameter.name, inherited ?? DYNAMIC];
      })
    );
    let returnType: DartType;
    if (returnTypeSyntax) returnType = this.resolveType(returnTypeSyntax);
    else if (declaration?.methodKind === 'setter') returnType = VOID;
    else if (overridden?.kind === 'function') returnType = overridden.returnType;
    else if (overridden && declaration?.methodKind === 'getter') returnType = overridden;
    else if (declaration?.methodKind === 'operator' && declaration.name === '[]=') returnType = VOID;
    else returnType = DYNAMIC;
    const type = functionType(positionalTypes, returnType, {
      requiredCount: parameters.requiredCount,
      named: parameters.named.map((parameter) => ({
        name: parameter.name,
        type: namedTypes.get(parameter.name) ?? DYNAMIC,
        isRequired: parameter.isRequired,
      })),
      typeParams,
    });
    return { type, positionalTypes, namedTypes };
  }

  private overriddenSignature(cls: ClassInfo, declaration: MethodDeclaration): DartType | undefined {
    for (const supertype of cls.directSupertypes) {
      const resolved = this.interfaceMember(supertype, declaration.name, declaration.methodKind === 'setter');
      if (resolved) return resolved.type;
    }
    return undefined;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Compiles one member's body with what its kind needs.
  private compileMethodBody(
    cls: ClassInfo,
    owner: ClassInfo | ExtensionInfo,
    declaration: MethodDeclaration,
    member: Member,
    typeParams: TypeParam[],
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>,
    type: FunctionType,
    body: NonNullable<MethodDeclaration['body']>
  ): void {
    const isExtension = !(owner instanceof ClassInfo);
    const savedClass = this.currentClass;
    const savedExtension = this.currentExtension;
    this.currentClass = isExtension ? undefined : cls;
    this.currentExtension = isExtension ? (owner as ExtensionInfo) : undefined;
    const ownerParams = isExtension ? (owner as ExtensionInfo).typeParams : cls.typeParams;
    try {
      const compiled = this.withTypeParams(ownerParams, () =>
        this.withTypeParams(typeParams, () =>
          this.compileFunction({
            name: declaration.name,
            span: declaration,
            headerEndRow: declaration.headerEndRow,
            parameters: declaration.parameters,
            positionalTypes,
            namedTypes,
            returnType: type.returnType,
            contextReturnType: undefined,
            body,
            typeParams,
            kind: {
              returnType: type.returnType,
              isGenerator: body.modifier === 'sync*',
              thisClass: isExtension ? undefined : cls,
              thisType: isExtension ? undefined : cls.kind === 'extensionType' ? cls.thisType : cls.thisType,
              hasThis: !declaration.isStatic,
              extensionOn: isExtension
                ? (owner as ExtensionInfo).onType
                : cls.kind === 'extensionType'
                  ? cls.thisType
                  : undefined,
              isInitializer: false,
              isConstructor: false,
            },
            showsThis: !declaration.isStatic && !this.isLibraryCode,
            isClosure: false,
          } as FunctionSpec & { isClosure: boolean })
        )
      );
      const ownTypeParams = typeParams;
      const classParams = ownerParams;
      const runFunction = this.runFunction.bind(this);
      const ownerClass = isExtension ? undefined : cls;
      (member as MethodMember).impl = (runtime, receiver, args, typeArgs, callRow) => {
        let typeEnv: TypeEnv;
        if (isExtension) {
          const env = new Map<TypeParam, DartType>();
          for (const [index, param] of classParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
          for (const [index, param] of ownTypeParams.entries())
            env.set(param, typeArgs[classParams.length + index] ?? DYNAMIC);
          typeEnv = env;
        } else {
          typeEnv = declaration.isStatic ? new Map() : this.typeEnvOf(runtime, receiver, ownerClass as ClassInfo);
          if (ownTypeParams.length > 0) {
            const env = new Map(typeEnv);
            for (const [index, param] of ownTypeParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
            typeEnv = env;
          }
        }
        return runFunction(compiled, runtime, receiver, [], typeEnv, args, callRow);
      };
      if (compiled.fn.info.isAtomic && !this.isLibraryCode) void 0;
    } finally {
      this.currentClass = savedClass;
      this.currentExtension = savedExtension;
    }
  }

  /** The class type parameters of a receiver, as an instance of the class whose method runs. */
  typeEnvOf(runtime: Runtime, receiver: Value, cls: ClassInfo): TypeEnv {
    if (cls.typeParams.length === 0) return EMPTY_ENV;
    if (cls.kind === 'extensionType') return EMPTY_ENV;
    const runtimeType = runtime.runtimeTypeOf(receiver);
    const instance = runtimeType.kind === 'interface' ? asInstanceOf(runtimeType, cls) : undefined;
    return new Map(cls.typeParams.map((param, index) => [param, instance?.args[index] ?? DYNAMIC]));
  }

  // Enums

  private declareEnumValues(cls: ClassInfo, declaration: ClassDeclaration): void {
    const names = new Set<string>();
    const values: GlobalVariable[] = [];
    for (const [index, constant] of declaration.enumConstants.entries()) {
      if (names.has(constant.name)) this.error(constant, `列挙型の値 ${constant.name} が重複しています。`);
      if (constant.name === 'values' || constant.name === 'index')
        this.error(constant, `列挙型の値に ${constant.name} という名前は付けられません。`);
      names.add(constant.name);
      const global = this.newGlobal(
        constant.name,
        `${cls.name}.${constant.name}`,
        cls.thisType,
        { isFinal: true, isConst: true, isLate: false },
        true,
        cls,
        constant.row
      );
      const field: FieldMember & { isEnumValue: boolean } = {
        kind: 'field',
        name: constant.name,
        owner: cls,
        isStatic: true,
        isAbstract: false,
        row: constant.row,
        type: cls.thisType,
        isFinal: true,
        isLate: false,
        isConst: true,
        isCovariant: false,
        hasInitializer: true,
        slot: global.slot,
        isEnumValue: true,
      };
      cls.staticMembers.set(constant.name, field);
      values.push(global);
      this.deferredBodies.push(() => this.compileEnumConstant(cls, constant, index, global));
    }
    const listType = interfaceType(coreTypes.list, [cls.thisType]);
    const valuesGlobal = this.newGlobal(
      'values',
      `${cls.name}.values`,
      listType,
      { isFinal: true, isConst: true, isLate: false },
      true,
      cls,
      declaration.row
    );
    valuesGlobal.initialize = (runtime) => {
      const elements = values.map((global) => readGlobalValue(runtime, global));
      return runtime.links.newList(runtime, cls.thisType, elements, false, true);
    };
    cls.staticMembers.set('values', {
      kind: 'field',
      name: 'values',
      owner: cls,
      isStatic: true,
      isAbstract: false,
      row: declaration.row,
      type: listType,
      isFinal: true,
      isLate: false,
      isConst: true,
      isCovariant: false,
      hasInitializer: true,
      slot: valuesGlobal.slot,
    });
    cls.enumValues = [];
  }

  private compileEnumConstant(
    cls: ClassInfo,
    constant: NonNullable<ClassDeclaration['enumConstants']>[number],
    index: number,
    global: GlobalVariable
  ): void {
    this.currentClass = cls;
    try {
      this.inTemporaryFunction(true, cls, () => {
        const constructor = cls.constructors.get(constant.constructorName ?? '');
        if (!constructor)
          this.error(
            constant,
            `列挙型 ${cls.name} に${constant.constructorName ? ` ${constant.constructorName} という` : '名前のない'}コンストラクタがありません。`
          );
        const args = constant.arguments ?? { ...at(constant), positional: [], named: [], order: [] };
        const typeArgs = constant.typeArguments?.map((argument) => this.resolveType(argument));
        const signature = typeArgs
          ? (substitute(
              { ...constructor.type, typeParams: [] },
              new Map(cls.typeParams.map((param, at) => [param, typeArgs[at]]))
            ) as FunctionType)
          : { ...constructor.type, typeParams: cls.typeParams };
        const bound = this.withConstContext(true, () =>
          this.bindArguments(signature, args, undefined, constant, undefined)
        );
        const resolvedArgs = typeArgs ?? bound.staticTypeArgs;
        const fn = this.fn;
        const { name } = constant;
        global.initialize = (runtime) => {
          const frame = new Frame(runtime, fn.info, fn.slotCount, undefined, [], new Map(), undefined);
          const object = new DartObject(
            cls,
            resolvedArgs,
            Array.from({ length: cls.fieldCount }, () => UNINITIALIZED)
          );
          object.native = { index: BigInt(index), name, values: () => [] };
          const evaluated = bound.args(frame);
          (constructor.impl as ConstructorImpl)(runtime, object, evaluated, resolvedArgs, undefined);
          return object;
        };
      });
    } finally {
      this.currentClass = undefined;
    }
  }

  // Constructors

  // code-gauge-allow functionCognitiveComplexity 40 -- The kinds of constructors and their parameters.
  private declareConstructor(cls: ClassInfo, declaration: ConstructorDeclaration): void {
    if (declaration.name === '\0primaryBody') return;
    if (declaration.className !== undefined && declaration.className !== cls.name) {
      this.error(declaration, `コンストラクタの名前は、クラスの名前 ${cls.name} で始めてください。`);
    }
    const name = declaration.name ?? '';
    if (cls.constructors.has(name))
      this.error(declaration, `コンストラクタ ${cls.name}${name ? `.${name}` : ''} は、既に宣言されています。`);
    if (name && (cls.staticMembers.has(name) || cls.members.has(name)))
      this.error(declaration, `${name} という名前は、既に宣言されています。`);
    if (cls.kind === 'mixin') this.error(declaration, 'mixin にはコンストラクタを書けません。');
    if (cls.kind === 'enum' && declaration.constructorKind === 'generative' && !declaration.isConst) {
      this.error(declaration, '列挙型のコンストラクタは const にしてください。');
    }
    const { positionalTypes, namedTypes } = this.constructorParameterTypes(cls, declaration.parameters, declaration);
    const type = functionType(positionalTypes, cls.thisType, {
      requiredCount: declaration.parameters.requiredCount,
      named: declaration.parameters.named.map((parameter) => ({
        name: parameter.name,
        type: namedTypes.get(parameter.name) ?? DYNAMIC,
        isRequired: parameter.isRequired,
      })),
    });
    const nativeKey = `${cls.name}.${name || 'new'}`;
    const constructor: ConstructorInfo = {
      name,
      owner: cls,
      type,
      kind: declaration.constructorKind,
      isConst: declaration.isConst,
      row: declaration.row,
      impl: declaration.isExternal ? (this.native(nativeKey) as ConstructorImpl) : undefined,
    };
    cls.constructors.set(name, constructor);
    if (!declaration.isExternal) {
      this.deferredBodies.push(() =>
        this.compileConstructor(cls, constructor, declaration, positionalTypes, namedTypes)
      );
    }
  }

  /** The types of a constructor's parameters: declared, the field's for `this.x`, or the superclass's for `super.x`. */
  private constructorParameterTypes(
    cls: ClassInfo,
    parameters: FormalParameters,
    span: Span
  ): { positionalTypes: DartType[]; namedTypes: Map<string, DartType> } {
    const typeOf = (parameter: FormalParameter, position: number | undefined): DartType => {
      if (parameter.type) return this.resolveType(parameter.type);
      if (parameter.binding === 'this') {
        const field = cls.fields.find((candidate) => candidate.name === parameter.name);
        if (!field)
          return this.error(
            parameter,
            `this.${parameter.name} の ${parameter.name} は、このクラスのフィールドではありません。`
          );
        return field.type;
      }
      if (parameter.binding === 'super') return this.superParameterType(cls, parameter, position, span);
      return DYNAMIC;
    };
    const positionalTypes = parameters.positional.map((parameter, index) => typeOf(parameter, index));
    const namedTypes = new Map(parameters.named.map((parameter) => [parameter.name, typeOf(parameter, undefined)]));
    return { positionalTypes, namedTypes };
  }

  private superParameterType(
    cls: ClassInfo,
    parameter: FormalParameter,
    position: number | undefined,
    span: Span
  ): DartType {
    void span;
    const superclass = cls.superclass;
    const declaration = cls.declaration?.members.find(
      (member): member is ConstructorDeclaration =>
        member.kind === 'constructor' &&
        [...member.parameters.positional, ...member.parameters.named].includes(parameter)
    );
    const superCall = declaration?.initializers.find((initializer) => initializer.kind === 'super');
    const superName = superCall?.kind === 'super' ? (superCall.name ?? '') : '';
    const target = superclass?.cls.constructors.get(superName);
    if (!superclass || !target) return DYNAMIC;
    const map = new Map(superclass.cls.typeParams.map((param, index) => [param, superclass.args[index] ?? DYNAMIC]));
    const signature = substitute(target.type, map) as FunctionType;
    if (position === undefined) return signature.named.find((named) => named.name === parameter.name)?.type ?? DYNAMIC;
    const superPositional =
      declaration?.parameters.positional.filter((candidate) => candidate.binding === 'super') ?? [];
    const superIndex = superPositional.indexOf(parameter);
    return signature.positional[superIndex] ?? DYNAMIC;
  }

  private declarePrimaryConstructor(cls: ClassInfo, declaration: ClassDeclaration): void {
    const primary = declaration.primaryConstructor as NonNullable<ClassDeclaration['primaryConstructor']>;
    const name = primary.name ?? '';
    if (cls.kind === 'extensionType') {
      const representation = cls.representationType as DartType;
      cls.constructors.set(name, {
        name,
        owner: cls,
        type: functionType([representation], cls.thisType),
        kind: 'factory',
        isConst: primary.isConst,
        row: primary.row,
        impl: (_runtime, _instance, args) => args.positional[0],
      });
      return;
    }
    const parameters: FormalParameters = {
      ...primary.parameters,
      positional: primary.parameters.positional.map((parameter) =>
        isFieldParameter(parameter) ? { ...parameter, binding: 'this' as const } : parameter
      ),
      named: primary.parameters.named.map((parameter) =>
        isFieldParameter(parameter) ? { ...parameter, binding: 'this' as const } : parameter
      ),
    };
    const bodyDeclaration = declaration.members.find(
      (member): member is ConstructorDeclaration => member.kind === 'constructor' && member.name === '\0primaryBody'
    );
    const constructorDeclaration: ConstructorDeclaration = {
      ...primary,
      kind: 'constructor',
      constructorKind: 'generative',
      className: cls.name,
      name: primary.name,
      isConst: primary.isConst,
      isExternal: false,
      parameters,
      initializers: bodyDeclaration?.initializers ?? [],
      body: bodyDeclaration?.body,
      redirectTarget: undefined,
      annotations: [],
      headerEndRow: primary.row,
    };
    this.declareConstructor(cls, constructorDeclaration);
  }

  private declareDefaultConstructor(cls: ClassInfo, declaration: ClassDeclaration): void {
    const constructorDeclaration: ConstructorDeclaration = {
      row: declaration.row,
      column: declaration.column,
      start: declaration.start,
      end: declaration.end,
      kind: 'constructor',
      constructorKind: 'generative',
      className: cls.name,
      name: undefined,
      isConst: cls.kind === 'enum',
      isExternal: false,
      parameters: {
        ...spanOnly(declaration),
        positional: [],
        requiredCount: 0,
        named: [],
      },
      initializers: [],
      body: undefined,
      redirectTarget: undefined,
      annotations: [],
      headerEndRow: declaration.row,
    };
    this.declareConstructor(cls, constructorDeclaration);
  }

  // code-gauge-allow functionCognitiveComplexity 60 -- The parts of a generative constructor run in Dart's order.
  private compileConstructor(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    const savedClass = this.currentClass;
    this.currentClass = cls;
    try {
      this.withTypeParams(cls.typeParams, () => {
        if (declaration.constructorKind === 'redirectingFactory') {
          this.compileRedirectingFactory(cls, constructor, declaration);
          return;
        }
        if (declaration.constructorKind === 'factory') {
          this.compileFactory(cls, constructor, declaration, positionalTypes, namedTypes);
          return;
        }
        this.compileGenerative(cls, constructor, declaration, positionalTypes, namedTypes);
      });
    } finally {
      this.currentClass = savedClass;
    }
  }

  private compileFactory(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    if (!declaration.body) return this.error(declaration, 'ファクトリコンストラクタには本体が必要です。');
    const compiled = this.compileFunction({
      name: cls.name + (constructor.name ? `.${constructor.name}` : ''),
      span: declaration,
      headerEndRow: declaration.headerEndRow,
      parameters: declaration.parameters,
      positionalTypes,
      namedTypes,
      returnType: cls.thisType,
      contextReturnType: undefined,
      body: declaration.body,
      typeParams: [],
      kind: {
        returnType: cls.thisType,
        isGenerator: false,
        thisClass: cls,
        thisType: cls.thisType,
        hasThis: false,
        extensionOn: undefined,
        isInitializer: false,
        isConstructor: false,
      },
      showsThis: false,
      isClosure: false,
    } as FunctionSpec & { isClosure: boolean });
    const params = cls.typeParams;
    constructor.impl = (runtime, _instance, args, typeArgs, callRow) =>
      this.runFunction(
        compiled,
        runtime,
        undefined,
        [],
        new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC])),
        args,
        callRow
      );
  }

  private compileRedirectingFactory(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration
  ): void {
    const target = declaration.redirectTarget as NonNullable<ConstructorDeclaration['redirectTarget']>;
    const type = this.resolveType(target.type, { allowRaw: true });
    if (type.kind !== 'interface') return this.error(declaration, 'リダイレクト先には、クラスを書いてください。');
    const targetConstructor = type.cls.constructors.get(target.name ?? '');
    if (!targetConstructor)
      return this.error(
        declaration,
        `${type.cls.name} に${target.name ? ` ${target.name} という` : '名前のない'}コンストラクタがありません。`
      );
    if (
      !isSubtype(substitute(type, new Map()), cls.thisType) &&
      !(type.args.length === 0 && type.cls.isSubclassOf(cls))
    ) {
      this.error(declaration, `${type.cls.name} は ${cls.name} のサブタイプではないので、リダイレクト先にできません。`);
    }
    const targetArgs = type.args;
    const params = cls.typeParams;
    constructor.impl = (runtime, _instance, args, typeArgs, callRow) => {
      const env = new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
      const resolvedArgs = targetArgs.length > 0 ? targetArgs.map((arg) => substitute(arg, env)) : [...typeArgs];
      return this.instantiate(runtime, type.cls, targetConstructor, resolvedArgs, args, callRow);
    };
  }

  /** Creates an object with a constructor: allocates it for a generative one, or lets a factory make it. */
  instantiate(
    runtime: Runtime,
    cls: ClassInfo,
    constructor: ConstructorInfo,
    typeArgs: readonly DartType[],
    args: Arguments,
    callRow: number | undefined
  ): Value {
    return instantiateObject(runtime, cls, constructor, typeArgs, args, callRow);
  }

  // code-gauge-allow functionCognitiveComplexity 60 -- Field initializers, initializing formals, the initializer list, the superclass's constructor, and the body.
  private compileGenerative(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    declaration: ConstructorDeclaration,
    positionalTypes: DartType[],
    namedTypes: Map<string, DartType>
  ): void {
    const redirect = declaration.initializers.find((initializer) => initializer.kind === 'this');
    if (redirect && (declaration.initializers.length > 1 || declaration.body)) {
      this.error(redirect, 'this(...) にリダイレクトするコンストラクタには、ほかの初期化子や本体は書けません。');
    }
    const parameters = declaration.parameters;
    const spec: FunctionSpec & { isClosure: boolean } = {
      name: cls.name + (constructor.name ? `.${constructor.name}` : ''),
      span: declaration,
      headerEndRow: declaration.headerEndRow,
      parameters,
      positionalTypes,
      namedTypes,
      returnType: VOID,
      contextReturnType: undefined,
      body: declaration.body ?? {
        ...spanOnly(declaration),
        kind: 'block',
        block: { ...spanOnly(declaration), kind: 'block', statements: [] },
        modifier: 'sync',
      },
      typeParams: [],
      kind: {
        returnType: VOID,
        isGenerator: false,
        thisClass: cls,
        thisType: cls.thisType,
        hasThis: true,
        extensionOn: undefined,
        isInitializer: false,
        isConstructor: true,
      },
      showsThis: !this.isLibraryCode,
      isClosure: false,
    };
    if (declaration.body?.kind === 'expression')
      this.error(declaration.body, 'コンストラクタには => の本体は書けません。');
    // The initializers compile in the constructor's own context, before its body, with `this` unavailable.
    let prologue: ((frame: Frame) => void) | undefined;
    const initializedFields = new Set<string>();
    const compiled = this.compileFunctionWithPrologue(spec, () => {
      prologue = this.compileConstructorPrologue(cls, declaration, initializedFields);
    });
    this.checkFieldsInitialized(cls, declaration, initializedFields, redirect !== undefined);
    const params = cls.typeParams;
    const info = compiled.fn.info;
    constructor.impl = (runtime, instance, args, typeArgs, callRow) => {
      const typeEnv: TypeEnv =
        params.length === 0 ? EMPTY_ENV : new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
      const frame = new Frame(runtime, info, compiled.fn.slotCount, instance, [], typeEnv, callRow);
      runtime.enter(frame);
      try {
        compiled.bind(frame, args);
        prologue?.(frame);
        compiled.run(frame);
      } finally {
        runtime.exit(frame);
      }
      return;
    };
  }

  /**
   * Compiles a function whose parameters are in scope for `prologue`, as a constructor's initializer list is, before
   * its body.
   */
  private compileFunctionWithPrologue(
    spec: FunctionSpec & { isClosure: boolean },
    prologue: () => void
  ): CompiledFunction {
    const original = this.compileStatements.bind(this);
    let used = false;
    this.compileStatementsHook = () => {
      if (used) return;
      used = true;
      prologue();
    };
    try {
      return this.compileFunction(spec);
    } finally {
      this.compileStatementsHook = undefined;
      void original;
    }
  }

  /** Runs once, before the first statements of the next function body compile, to compile a constructor's initializers. */
  protected compileStatementsHook: (() => void) | undefined;

  protected override compileBlock(block: Block, clear = true): Exec {
    const hook = this.compileStatementsHook;
    if (hook) {
      this.compileStatementsHook = undefined;
      const { hasThis, isInitializer } = this.fn.kind;
      this.fn.kind.hasThis = false;
      this.fn.kind.isInitializer = true;
      try {
        hook();
      } finally {
        this.fn.kind.hasThis = hasThis;
        this.fn.kind.isInitializer = isInitializer;
      }
    }
    return super.compileBlock(block, clear);
  }

  // code-gauge-allow functionCognitiveComplexity 60 -- The initializer list's entries and the implicit super().
  private compileConstructorPrologue(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initializedFields: Set<string>
  ): (frame: Frame) => void {
    const steps: ((frame: Frame) => void)[] = [];
    const redirect = declaration.initializers.find((initializer) => initializer.kind === 'this');
    if (!redirect) steps.push(...this.compileFieldInitializers(cls, initializedFields));
    // Initializing formals.
    for (const parameter of [...declaration.parameters.positional, ...declaration.parameters.named]) {
      if (parameter.binding !== 'this') continue;
      const field = cls.fields.find((candidate) => candidate.name === parameter.name);
      if (!field)
        return this.error(
          parameter,
          `this.${parameter.name} の ${parameter.name} は、このクラスのフィールドではありません。`
        );
      if (initializedFields.has(field.name) && field.isFinal)
        this.error(parameter, `final のフィールド ${field.name} は、もう初期化されています。`);
      const variable = this.findLocal(parameter.name);
      if (!variable) continue;
      const parameterType = variable.type;
      if (!isSubtype(parameterType, field.type)) {
        this.error(
          parameter,
          `${typeName(parameterType)} 型の引数は、${typeName(field.type)} 型のフィールド ${field.name} に代入できません。`
        );
      }
      initializedFields.add(field.name);
      const { slot } = variable;
      const fieldSlot = field.slot;
      steps.push((frame) => {
        (frame.receiver as DartObject).fields[fieldSlot] = (frame.locals[slot] as Cell).v;
      });
      // Inside the initializer list and the body, the name refers to the parameter, which is final.
    }
    let superCall = false;
    for (const initializer of declaration.initializers) {
      switch (initializer.kind) {
        case 'field': {
          const field = cls.fields.find((candidate) => candidate.name === initializer.name);
          if (!field) return this.error(initializer, `${initializer.name} は、このクラスのフィールドではありません。`);
          if (initializedFields.has(field.name))
            this.error(initializer, `フィールド ${field.name} は、もう初期化されています。`);
          initializedFields.add(field.name);
          const value = this.coerce(
            this.compileExpression(initializer.value, field.type),
            field.type,
            initializer.value,
            (from, to) => `${from} 型の値は、${to} 型のフィールド ${field.name} に代入できません。`
          );
          const { run } = value;
          const fieldSlot = field.slot;
          steps.push((frame) => {
            (frame.receiver as DartObject).fields[fieldSlot] = run(frame);
          });
          break;
        }
        case 'assert': {
          this.compileCondition(initializer.condition);
          break;
        }
        case 'super':
        case 'this': {
          if (initializer !== declaration.initializers.at(-1)) {
            this.error(initializer, `${initializer.kind}(...) は、初期化子の最後に書いてください。`);
          }
          superCall = true;
          steps.push(
            this.compileDelegation(
              cls,
              declaration,
              initializer.kind,
              initializer.name,
              initializer.arguments,
              initializer
            )
          );
          break;
        }
      }
    }
    if (!superCall && cls.superclass && cls.kind !== 'extensionType') {
      steps.push(
        this.compileDelegation(
          cls,
          declaration,
          'super',
          undefined,
          { ...at(declaration), positional: [], named: [], order: [] },
          declaration,
          true
        )
      );
    }
    return (frame) => {
      for (const step of steps) step(frame);
    };
  }

  /** The initializers of the fields a class declares, one step per declaration as Java's are. */
  private compileFieldInitializers(cls: ClassInfo, initializedFields: Set<string>): ((frame: Frame) => void)[] {
    const declaration = cls.declaration;
    if (!declaration) return [];
    const result: ((frame: Frame) => void)[] = [];
    for (const member of declaration.members) {
      if (member.kind !== 'field' || member.isStatic || member.isLate || member.isAbstract || member.isExternal)
        continue;
      const runs: { slot: number; run: Eval }[] = [];
      const initialized: Compiled[] = [];
      for (const variable of member.variables) {
        if (!variable.initializer) continue;
        const field = cls.fields.find((candidate) => candidate.name === variable.name) as FieldMember;
        initializedFields.add(field.name);
        const compiled = this.coerce(
          this.compileExpression(variable.initializer, field.type),
          field.type,
          variable.initializer,
          (from, to) => `${from} 型の値は、${to} 型のフィールド ${field.name} に代入できません。`
        );
        initialized.push(compiled);
        runs.push({ slot: field.slot, run: compiled.run });
      }
      if (runs.length === 0) continue;
      const exec = (frame: Frame): undefined => {
        for (const { slot, run } of runs) (frame.receiver as DartObject).fields[slot] = run(frame);
        return undefined;
      };
      const stepped = this.withStep(
        member,
        exec,
        initialized.every((compiled) => compiled.creates === true)
      );
      result.push((frame) => {
        stepped(frame);
      });
    }
    return result;
  }

  /** The call of the superclass's constructor or of another constructor of the class, in an initializer list. */
  private compileDelegation(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    kind: 'super' | 'this',
    name: string | undefined,
    argsSyntax: ArgumentsSyntax,
    span: Span,
    isImplicit = false
  ): (frame: Frame) => void {
    const targetType = kind === 'super' ? (cls.superclass as InterfaceType) : cls.thisType;
    const target = targetType.cls.constructors.get(name ?? '');
    if (!target) {
      if (isImplicit) {
        return this.error(
          span,
          `スーパークラス ${targetType.cls.name} には、引数のない名前のないコンストラクタがありません。super(...) を書いてください。`
        );
      }
      return this.error(
        span,
        `${targetType.cls.name} に${name ? ` ${name} という` : '名前のない'}コンストラクタがありません。`
      );
    }
    if (target.kind !== 'generative')
      this.error(
        span,
        `${targetType.cls.name}${name ? `.${name}` : ''} はファクトリコンストラクタなので、${kind}(...) では呼び出せません。`
      );
    const map = new Map(targetType.cls.typeParams.map((param, index) => [param, targetType.args[index] ?? DYNAMIC]));
    const signature = substitute({ ...target.type, typeParams: [] }, map) as FunctionType;
    // `super.x` parameters pass their arguments on: positional ones before the written arguments, named ones by name.
    const superPositional =
      kind === 'super' ? declaration.parameters.positional.filter((parameter) => parameter.binding === 'super') : [];
    const superNamed =
      kind === 'super' ? declaration.parameters.named.filter((parameter) => parameter.binding === 'super') : [];
    if (superPositional.length > 0 && argsSyntax.positional.length > 0) {
      this.error(span, 'super. の引数を使うときは、super(...) に位置で渡す引数を書けません。');
    }
    const passed: ArgumentsSyntax = {
      ...argsSyntax,
      positional: [
        ...superPositional.map((parameter): Expression => ({
          ...spanOnly(parameter),
          kind: 'identifier',
          name: parameter.name,
        })),
        ...argsSyntax.positional,
      ],
      named: [
        ...superNamed.map((parameter) => ({
          ...spanOnly(parameter),
          name: parameter.name,
          value: { ...spanOnly(parameter), kind: 'identifier' as const, name: parameter.name },
        })),
        ...argsSyntax.named,
      ],
      order: [],
    };
    passed.order = [
      ...passed.positional.map((_, index) => ({ kind: 'positional' as const, index })),
      ...passed.named.map((_, index) => ({ kind: 'named' as const, index })),
    ];
    const bound = this.bindArguments(signature, passed, undefined, span, undefined);
    const typeArgs = this.runtimeTypes(targetType.args);
    const row = isImplicit || this.isLibraryCode ? undefined : span.row;
    const targetClass = targetType.cls;
    return (frame) => {
      const impl = target.impl as ConstructorImpl;
      impl(frame.runtime, frame.receiver as DartObject, bound.args(frame), typeArgs(frame), row);
      void targetClass;
    };
  }

  private checkFieldsInitialized(
    cls: ClassInfo,
    declaration: ConstructorDeclaration,
    initialized: Set<string>,
    isRedirecting: boolean
  ): void {
    if (isRedirecting || this.isLibraryCode) return;
    for (const field of cls.fields) {
      if (initialized.has(field.name) || field.isLate || field.hasInitializer) continue;
      if (field.isFinal) {
        this.error(declaration, `final のフィールド ${field.name} が、コンストラクタで初期化されていません。`);
      }
      if (!isNullable(field.type) && field.type.kind !== 'dynamic') {
        this.error(declaration, `null にならないフィールド ${field.name} が、コンストラクタで初期化されていません。`);
      }
    }
  }

  // Checks of whole classes

  // code-gauge-allow functionCognitiveComplexity 40 -- Abstract members, overrides, and class modifiers.
  private checkClass({ cls, declaration }: ClassWork): void {
    if (this.isLibraryCode) return;
    if (cls.kind === 'enum') {
      for (const name of ['index', 'hashCode', '==', 'values']) {
        const own = cls.members.get(name);
        if (own && name !== 'hashCode' && name !== '==')
          this.error({ row: own.row ?? declaration.row }, `列挙型には ${name} というメンバーを宣言できません。`);
        if (own && (name === 'hashCode' || name === '==') && !own.isAbstract)
          this.error({ row: own.row ?? declaration.row }, `列挙型では ${name} を上書きできません。`);
      }
    }
    for (const member of [...cls.members.values(), ...cls.setters.values()]) this.checkOverride(cls, member);
    if (!cls.isAbstract && cls.kind !== 'mixin' && cls.kind !== 'extensionType') {
      const hasNoSuchMethod = cls.implementation('noSuchMethod')?.owner !== coreTypes.object;
      for (const name of cls.interfaceMemberNames()) {
        const isSetter = name.endsWith('=') && name !== '==' && name !== '[]=';
        const memberName = isSetter ? name.slice(0, -1) : name;
        const implementation = isSetter ? cls.setterImplementation(memberName) : cls.implementation(memberName);
        if (implementation || hasNoSuchMethod) continue;
        const declared = cls.interfaceMember(memberName, isSetter);
        if (!declared) continue;
        this.error(declaration, `${cls.name} には、${declared.owner.name}.${name} の実装がありません。`);
      }
    }
  }

  private checkOverride(cls: ClassInfo, member: Member): void {
    if (member.isStatic) return;
    for (const supertype of cls.directSupertypes) {
      const inherited = this.interfaceMember(supertype, member.name, member.kind === 'setter');
      if (!inherited || inherited.member === member) continue;
      const own = member.kind === 'field' || member.kind === 'getter' ? member.type : member.type;
      if (member.kind === 'method' && inherited.member.kind !== 'method') {
        this.error(
          { row: member.row ?? 0 },
          `${cls.name}.${member.name} はメソッドなので、getter やフィールドの ${inherited.member.owner.name}.${member.name} を上書きできません。`
        );
      }
      if (member.kind !== 'method' && member.kind !== 'setter' && inherited.member.kind === 'method') {
        this.error(
          { row: member.row ?? 0 },
          `${cls.name}.${member.name} は getter かフィールドなので、メソッドの ${inherited.member.owner.name}.${member.name} を上書きできません。`
        );
      }
      if (member.kind === 'method' && inherited.member.kind === 'method') {
        if (!this.isValidOverride(own as FunctionType, inherited.type as FunctionType)) {
          this.error(
            { row: member.row ?? 0 },
            `${cls.name}.${member.name}（${typeToString(own)}）は、${inherited.member.owner.name}.${member.name}（${typeToString(inherited.type)}）の正しい上書きではありません。`
          );
        }
      } else if (
        member.kind !== 'setter' &&
        inherited.member.kind !== 'setter' &&
        inherited.member.kind !== 'method' &&
        !isSubtype(own, inherited.type)
      ) {
        {
          this.error(
            { row: member.row ?? 0 },
            `${cls.name}.${member.name} の型 ${typeName(own)} は、${inherited.member.owner.name}.${member.name} の型 ${typeName(inherited.type)} に合いません。`
          );
        }
      }
    }
  }

  /** Whether a method's signature may override another's, allowing covariant parameters as Dart does for fields. */
  private isValidOverride(own: FunctionType, inherited: FunctionType): boolean {
    if (isSubtype(own, inherited)) return true;
    // Parameters marked covariant (or of a generic class's type parameters) may narrow; check the rest.
    const relaxed: FunctionType = {
      ...own,
      positional: own.positional.map((type, index) =>
        inherited.positional[index] && isSubtype(type, inherited.positional[index]) ? inherited.positional[index] : type
      ),
      named: own.named.map((named) => {
        const other = inherited.named.find((candidate) => candidate.name === named.name);
        return other && isSubtype(named.type, other.type) ? { ...named, type: other.type } : named;
      }),
    };
    // Dart also checks that narrowed parameters are covariant; this checker accepts them, erring toward running.
    return isSubtype(relaxed, inherited);
  }

  // Extensions

  private declareExtension(ext: ExtensionInfo, declaration: ExtensionDeclaration): void {
    ext.typeParams.push(...this.declareTypeParams(declaration.typeParameters));
    this.withTypeParams(ext.typeParams, () => {
      ext.onType = this.resolveType(declaration.onType);
      const holder = new ClassInfo(ext.name ?? 'extension', 'class', this.library.name);
      for (const member of declaration.members) {
        if (member.kind === 'constructor') this.error(member, '拡張にはコンストラクタを書けません。');
        if (member.kind === 'field') {
          if (!member.isStatic) this.error(member, '拡張には、インスタンスのフィールドを宣言できません。');
          this.declareField(holder, member);
          for (const [name, value] of holder.staticMembers) ext.staticMembers.set(name, value);
          for (const [name, value] of holder.staticSetters) ext.staticSetters.set(name, value);
          continue;
        }
        if (member.kind === 'method') this.declareMethod(holder, member, ext);
      }
    });
  }

  private compileExtension(ext: ExtensionInfo, declaration: ExtensionDeclaration): void {
    void ext;
    void declaration;
  }

  // Top-level functions and variables

  private resolveTopLevelSignature(declaration: FunctionDeclaration): void {
    const entry = this.library.declarations.get(declaration.name);
    const fn =
      entry?.kind === 'function'
        ? entry.fn
        : entry?.kind === 'accessor'
          ? declaration.functionKind === 'getter'
            ? entry.getter
            : entry.setter
          : undefined;
    if (!fn) return;
    const typeParams = this.declareTypeParams(declaration.typeParameters);
    const { type } = this.withTypeParams(typeParams, () =>
      this.signatureOf(declaration.parameters, declaration.returnType, typeParams)
    );
    fn.type = declaration.functionKind === 'setter' && !declaration.returnType ? { ...type, returnType: VOID } : type;
    if (declaration.isExternal) fn.impl = this.native(declaration.name) as Callable;
    (fn as TopLevelFunction & { typeParams?: TypeParam[] }).typeParams = typeParams;
  }

  private compileTopLevelFunction(declaration: FunctionDeclaration): void {
    const entry = this.library.declarations.get(declaration.name);
    const fn =
      entry?.kind === 'function'
        ? entry.fn
        : entry?.kind === 'accessor'
          ? declaration.functionKind === 'getter'
            ? entry.getter
            : entry.setter
          : undefined;
    if (!fn || !declaration.body) return;
    const typeParams = (fn as TopLevelFunction & { typeParams?: TypeParam[] }).typeParams ?? [];
    const body = declaration.body;
    const compiled = this.withTypeParams(typeParams, () => {
      const positionalTypes = [...fn.type.positional];
      const namedTypes = new Map(fn.type.named.map((named) => [named.name, named.type]));
      return this.compileFunction({
        name: declaration.name,
        span: declaration,
        headerEndRow: declaration.headerEndRow,
        parameters: declaration.parameters,
        positionalTypes,
        namedTypes,
        returnType: fn.type.returnType,
        contextReturnType: undefined,
        body,
        typeParams,
        kind: {
          returnType: fn.type.returnType,
          isGenerator: body.modifier === 'sync*',
          thisClass: undefined,
          thisType: undefined,
          hasThis: false,
          extensionOn: undefined,
          isInitializer: false,
          isConstructor: false,
        },
        showsThis: false,
        isClosure: false,
      } as FunctionSpec & { isClosure: boolean });
    });
    fn.isAtomic = compiled.fn.info.isAtomic;
    fn.impl = (runtime, _receiver, args, typeArgs, callRow) => {
      const typeEnv: TypeEnv =
        typeParams.length === 0
          ? EMPTY_ENV
          : new Map(typeParams.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
      return this.runFunction(compiled, runtime, undefined, [], typeEnv, args, callRow);
    };
  }

  private declareTopLevelVariables(declaration: VariableDeclaration): void {
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    for (const variable of declaration.variables) {
      if (declaration.isConst && !variable.initializer)
        this.error(variable, `const の ${variable.name} には初期値が必要です。`);
      const type =
        declaredType ??
        (variable.initializer ? this.inferInitializerType(variable.initializer, true, undefined) : DYNAMIC);
      if (!variable.initializer && !declaration.isLate && !isNullable(type) && type.kind !== 'dynamic') {
        this.error(variable, `null にならない変数 ${variable.name} には、初期値が必要です。`);
      }
      const global = this.newGlobal(
        variable.name,
        variable.name,
        type,
        declaration,
        variable.initializer !== undefined,
        undefined,
        variable.row
      );
      this.declareName(variable.name, { kind: 'variable', global }, variable);
      const { initializer } = variable;
      if (initializer) this.compileGlobalInitializer(global, initializer, declaration.isConst, undefined);
    }
  }

  // Runtime glue the expression compilers call

  readGlobal(global: GlobalVariable): Eval {
    const { slot } = global;
    return (frame) => readGlobalValue(frame.runtime, this.globals[slot] ?? global);
  }

  tearOffFunction(fn: TopLevelFunction): Eval {
    let closure: DartClosure | undefined;
    return (frame) => {
      closure ??= new DartClosure(
        coreTypes.function,
        fn.type,
        (runtime, _receiver, args, typeArgs, callRow) =>
          (fn.impl as Callable)(runtime, undefined, args, typeArgs, callRow),
        undefined,
        [],
        { name: fn.name, origin: `Function '${fn.name}': static.` },
        fn
      );
      void frame;
      return closure;
    };
  }

  typeLiteralValue(cls: ClassInfo, span: Span): Compiled {
    void span;
    const type = interfaceType(
      cls,
      cls.typeParams.map(() => DYNAMIC)
    );
    return { type: interfaceType(coreTypes.type), run: () => new DartTypeValue(coreTypes.type, type), isConst: true };
  }

  constructSymbol(frame: Frame, name: string): Value {
    return frame.runtime.links.construct(frame.runtime, 'Symbol', '', [name]);
  }

  constructObject(
    cls: ClassInfo,
    constructor: ConstructorInfo,
    typeArgs: (frame: Frame) => DartType[],
    args: (frame: Frame) => Arguments,
    span: Span,
    isConst: boolean
  ): Eval {
    const row = this.callRow(span);
    const create: Eval = (frame) => {
      const resolvedArgs = typeArgs(frame);
      const evaluated = args(frame);
      return this.instantiate(frame.runtime, cls, constructor, resolvedArgs, evaluated, row);
    };
    if (!isConst) return create;
    return this.canonicalized(create);
  }

  canonicalized(build: Eval): Eval {
    return (frame) => {
      const cache = frame.runtime.constantSites;
      const existing = cache.get(build);
      if (existing !== undefined || cache.has(build)) return existing;
      const value = frame.runtime.links.canonicalize(frame.runtime, build(frame));
      cache.set(build, value);
      return value;
    };
  }

  protected onlyCalls(expression: Expression, compiled: Compiled): boolean {
    if (expression.kind === 'assign') return expression.operator === '=' && compiled.creates === true;
    if (expression.kind === 'cascade') return false;
    return expression.kind === 'call' || expression.kind === 'new';
  }

  newThrow(frame: Frame, value: Value): unknown {
    return frame.runtime.links.newThrow(frame.runtime, value);
  }

  stackTraceValue(frame: Frame, error: DartThrow): Value {
    return frame.runtime.links.stackTraceOf(frame.runtime, error);
  }

  makeSyncStarIterable(frame: Frame, elementType: DartType, body: GenExec): Value {
    return frame.runtime.links.syncStarIterable(frame, elementType, body);
  }

  private native(key: string): Callable | ConstructorImpl {
    const found = this.natives.get(key);
    if (found) return found;
    // A library member without a native fails only when a program calls it.
    return () => {
      throw new Error(`The interpreter has no native for ${key}`);
    };
  }

  static readonly unused = [NEVER, nonNullable, isTop, NO_ARGUMENTS, SHORTED] as const;
}

const EMPTY_ENV: TypeEnv = new Map();

function spanOnly(span: Span): Span {
  return { row: span.row, column: span.column, start: span.start, end: span.end };
}

function isFieldParameter(parameter: FormalParameter): boolean {
  return (
    parameter.binding === 'plain' &&
    (parameter.isFinal || (parameter as FormalParameter & { isVar?: boolean }).isVar === true)
  );
}

/** Creates an object with a constructor: allocates it for a generative one, or lets a factory make it. */
export function instantiateObject(
  runtime: Runtime,
  cls: ClassInfo,
  constructor: ConstructorInfo,
  typeArgs: readonly DartType[],
  args: Arguments,
  callRow: number | undefined
): Value {
  const impl = constructor.impl as ConstructorImpl;
  if (constructor.kind !== 'generative') return impl(runtime, undefined, args, typeArgs, callRow);
  runtime.allocate(cls.fieldCount + 1);
  // Fields are unset until their initializers run, which traces show by leaving them out.
  const object = new DartObject(
    cls,
    typeArgs,
    Array.from({ length: cls.fieldCount }, () => UNINITIALIZED)
  );
  impl(runtime, object, args, typeArgs, callRow);
  return object;
}

function isPrimitiveConstant(compiled: Compiled): boolean {
  const value = compiled.constValue?.value;
  return compiled.isConst && (value === undefined || typeof value !== 'object');
}

/** Reads a global, initializing it on first use as Dart does for top-level variables and static fields. */
export function readGlobalValue(runtime: Runtime, global: GlobalVariable): Value {
  const cell = runtime.globals[global.slot];
  const value = cell.v;
  if (value !== UNINITIALIZED && value !== INITIALIZING) return value;
  if (value === INITIALIZING) {
    runtime.throwError('_MessageError', '', [`Reading static variable '${global.name}' during its initialization`]);
  }
  if (!global.initialize) {
    runtime.throwError('LateInitializationError', '', [`Field '${global.name}' has not been initialized.`]);
  }
  cell.v = INITIALIZING;
  try {
    const initialized = global.initialize(runtime);
    cell.v = initialized;
    return initialized;
  } catch (error) {
    cell.v = UNINITIALIZED;
    throw error;
  }
}

/** Creates the cells of the globals for a run, with the values known before it starts. */
export function initialGlobals(globals: GlobalVariable[]): Cell[] {
  return globals.map(
    (global) =>
      new Cell(
        global.initialValue && (global.isConst || !global.initialize || isPrimitive(global.initialValue.value))
          ? global.initialValue.value
          : UNINITIALIZED
      )
  );
}

function isPrimitive(value: Value): boolean {
  return value === undefined || typeof value !== 'object';
}

export {
  type ClassDeclaration,
  type ExtensionInfo,
  type FunctionContext,
  type FunctionInfo,
  type GlobalVariable,
  type MethodMember,
  NO_ARGUMENTS,
  objectType,
  type TypeAlias,
};

import { Flow as FlowCtor, FunctionContext as FunctionContextCtor } from './scope';
