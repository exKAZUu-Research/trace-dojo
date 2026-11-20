// code-gauge-allow-file fileNcss 986 -- One compiler phase per file; splitting it further would scatter the cases of one construct.
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import type {
  ClassDeclaration,
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
import type { FunctionSpec } from './callCompiler';
import {
  ClassInfo,
  type ConstructorImpl,
  type ConstructorInfo,
  type FieldMember,
  type Member,
  type MethodMember,
} from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { ConstructorCompiler, EMPTY_ENV } from './constructorCompiler';
import {
  type Declaration,
  type ExtensionInfo,
  type GlobalVariable,
  type LibraryEnv,
  type TopLevelFunction,
  type TypeAlias,
} from './environment';
import { type DartThrow, Frame, type FunctionInfo, type Runtime, type TypeEnv } from './runtime';
import { Flow, FunctionContext } from './scope';
import { type GenExec, inheritsCovariance } from './statementCompiler';
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
  objectType,
  substitute,
  type TypeParam,
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
export class Compiler extends ConstructorCompiler {
  private readonly classWork: ClassWork[] = [];
  private readonly extensionWork: { ext: ExtensionInfo; declaration: ExtensionDeclaration }[] = [];
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
          this.aliasWork.set(alias, declaration);
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
      // The SDK reports the later of the two declarations, whichever this compiler declared first.
      const existingRow = declarationRow(existing);
      const row = existingRow !== undefined && existingRow > span.row ? existingRow : span.row;
      this.error({ row }, `${name} という名前は、既に宣言されています。`);
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
  // code-gauge-allow functionCognitiveComplexity 19 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 35 -- One case per form of the construct, which reads best together.
  resolveAll(syntax: Library): void {
    this.pendingBoundChecks = [];
    for (const { cls, declaration } of this.classWork) {
      cls.typeParams.push(...this.declareTypeParamNames(declaration.typeParameters));
      this.pendingClassBounds.set(cls, declaration);
    }
    for (const [alias, declaration] of this.aliasWork) this.resolveAlias(alias, declaration);
    for (const { cls } of this.classWork) this.resolveClassBounds(cls);
    for (const work of this.classWork) this.resolveHeader(work);
    this.checkHierarchy();
    const boundChecks = this.pendingBoundChecks;
    this.pendingBoundChecks = undefined;
    for (const check of boundChecks) check();
    for (const work of this.orderedClassWork()) this.declareMembers(work);
    for (const { ext, declaration } of this.extensionWork) this.declareExtension(ext, declaration);
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'function') this.resolveTopLevelSignature(declaration);
    }
    // Every top-level variable is declared before any initializer compiles, as initializers may use later ones.
    const initializers: (() => void)[] = [];
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'variables') initializers.push(...this.declareTopLevelVariables(declaration));
    }
    for (const infer of this.fieldInferences) infer();
    this.fieldInferences.length = 0;
    for (const compile of initializers) compile();
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

  // code-gauge-allow functionCognitiveComplexity 25 -- Each branch is one of the cases Dart distinguishes for this construct.
  private resolveHeader(work: ClassWork): void {
    const { cls, declaration } = work;
    this.withTypeParams(cls.typeParams, () => {
      this.resolveSuperclass(work);
      if (declaration.mixins.length > 0) {
        let base = cls.superclass ?? objectType();
        for (const mixinSyntax of declaration.mixins) {
          const mixin = this.resolveSupertype(cls, mixinSyntax, 'mixin');
          if (mixin.cls.kind !== 'mixin' && mixin.cls.kind !== 'mixinClass' && !this.isLibraryCode) {
            this.error(mixinSyntax, `${mixin.cls.name} は mixin ではないので、with には書けません。`);
          }
          base = this.mixinApplication(base, mixin, cls, mixinSyntax);
        }
        cls.superclass = base;
      }
      cls.interfaces = declaration.interfaces.map((type) =>
        this.resolveSupertype(cls, type, '実装するインターフェース')
      );
      for (const [index, type] of cls.interfaces.entries()) {
        if (cls.interfaces.slice(0, index).some((other) => other.cls === type.cls)) {
          this.error(declaration.interfaces[index], `${type.cls.name} は、1 回しか implements に書けません。`);
        }
      }
      if (declaration.classKind === 'extensionType') {
        const parameter = declaration.primaryConstructor?.parameters.positional[0];
        if (!parameter?.type) this.error(declaration, '拡張型には、表す値の型を書いてください。');
        cls.representationType = this.resolveType(parameter.type as TypeSyntax);
        cls.representationName = parameter.name;
      }
    });
    registerSealedSubclass(cls);
  }

  private resolveSuperclass({ cls, declaration }: ClassWork): void {
    if (declaration.classKind === 'enum') {
      cls.superclass = interfaceType(coreTypes.enum);
    } else if (declaration.classKind === 'mixin') {
      cls.onTypes = declaration.onTypes.map((type) => this.resolveSupertype(cls, type, 'mixin の on の型'));
    } else if (declaration.classKind === 'extensionType') {
      cls.superclass = undefined;
    } else if (declaration.superclass) {
      cls.superclass = this.resolveSupertype(cls, declaration.superclass, 'スーパークラス');
      if (cls.superclass.cls.kind === 'mixin')
        this.error(
          declaration.superclass,
          `mixin ${cls.superclass.cls.name} は extends できません。with を使ってください。`
        );
    } else if (cls !== coreTypes.object && !(this.isLibraryCode && cls.name === 'Object')) {
      cls.superclass = objectType();
    }
  }

  private resolveSupertype(cls: ClassInfo, syntax: TypeSyntax, role: string): InterfaceType {
    const type = this.resolveType(syntax);
    if (type.kind !== 'interface' || type.nullable) {
      return this.error(syntax, `${typeToString(type)} は${role}にできません。`);
    }
    this.checkSubtypeAllowed(cls, type.cls, role, syntax);
    return type;
  }

  /** Rejects extending or implementing classes whose modifiers forbid it outside their library. */
  // code-gauge-allow functionCognitiveComplexity 18 -- Each class modifier restricts different subtype roles.
  private checkSubtypeAllowed(cls: ClassInfo, supercls: ClassInfo, role: string, span: Span): void {
    const name = supercls.name;
    if (!this.isLibraryCode && (supercls.kind === 'enum' || supercls === coreTypes.enum) && role !== 'mixin の on の型')
      this.error(span, `列挙型 ${name} は${role}にできません。`);
    // In its own library too, a subtype of a base or final class must keep others from implementing it.
    const { modifiers } = cls;
    if (
      (supercls.modifiers.isBase || supercls.modifiers.isFinal) &&
      !modifiers.isBase &&
      !modifiers.isFinal &&
      !modifiers.isSealed &&
      cls.kind !== 'enum' &&
      !this.isLibraryCode
    ) {
      this.error(
        span,
        `${name} は ${supercls.modifiers.isFinal ? 'final' : 'base'} なので、それを継承する ${cls.name} にも base・final・sealed のどれかを付けてください。`
      );
    }
    if (supercls.library === cls.library) return;
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
  }

  /** The class `superclass with mixin`, whose members are the mixin's. */
  private mixinApplication(
    superclass: InterfaceType,
    mixin: InterfaceType,
    owner: ClassInfo,
    span: Span
  ): InterfaceType {
    const application = new ClassInfo(`${superclass.cls.name} with ${mixin.cls.name}`, 'class', owner.library);
    application.typeParams.push(...owner.typeParams);
    application.superclass = superclass;
    application.interfaces = [mixin];
    application.mixinOf = mixin.cls;
    application.modifiers = { isAbstract: true, isSealed: false, isBase: false, isFinal: false, isInterface: false };
    (application as ClassInfo & { mixinArgs?: readonly DartType[] }).mixinArgs = mixin.args;
    this.pendingApplications.push({ application, mixin, span });
    return interfaceType(
      application,
      owner.typeParams.map((param) => typeParamType(param))
    );
  }

  private readonly pendingApplications: { application: ClassInfo; mixin: InterfaceType; span: Span }[] = [];

  private checkHierarchy(): void {
    // A mixin with `on` types applies only on a superclass that has them.
    for (const { application, mixin, span } of this.pendingApplications) {
      const base = application.superclass?.cls;
      for (const onType of mixin.cls.onTypes) {
        if (base && !base.isSubclassOf(onType.cls) && !this.isLibraryCode) {
          this.error(
            span,
            `${base.name} は ${onType.cls.name} を継承していないので、mixin ${mixin.cls.name} を使えません。`
          );
        }
      }
    }
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

  // code-gauge-allow functionCognitiveComplexity 23 -- Each kind of member declares itself differently.
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
      this.declareForwardingConstructors(application, mixin, slotMap);
      application.resetCaches();
    }
  }

  /**
   * A mixin application has a constructor for each generative constructor of its superclass, which initializes the
   * mixin's fields and passes its arguments on, as Dart's forwarding constructors do.
   */
  // code-gauge-allow functionCognitiveComplexity 29 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 36 -- One case per form of the construct, which reads best together.
  private declareForwardingConstructors(application: ClassInfo, mixin: ClassInfo, slotMap: Map<number, number>): void {
    const superclass = application.superclass as InterfaceType;
    const superMap = new Map(
      superclass.cls.typeParams.map((param, index) => [param, superclass.args[index] ?? DYNAMIC])
    );
    let initializeFields: ((runtime: Runtime, instance: DartObject) => void) | undefined;
    const fieldDeclarations =
      mixin.declaration?.members.filter(
        (member): member is FieldDeclaration => member.kind === 'field' && !member.isStatic && !member.isLate
      ) ?? [];
    if (fieldDeclarations.some((member) => member.variables.some((variable) => variable.initializer))) {
      this.deferredBodies.push(() => {
        const savedClass = this.currentClass;
        this.currentClass = mixin;
        try {
          this.withTypeParams(mixin.typeParams, () =>
            this.inTemporaryFunction(
              false,
              mixin,
              () => {
                const writes: { slot: number; run: Eval }[] = [];
                for (const member of fieldDeclarations) {
                  for (const variable of member.variables) {
                    if (!variable.initializer) continue;
                    const field = mixin.fields.find((candidate) => candidate.name === variable.name) as FieldMember;
                    const compiled = this.coerce(
                      this.compileExpression(variable.initializer, field.type),
                      field.type,
                      variable.initializer,
                      (from, to) => `${from} 型の値は、${to} 型のフィールド ${field.name} に代入できません。`
                    );
                    writes.push({ slot: slotMap.get(field.slot) ?? field.slot, run: compiled.run });
                  }
                }
                const fn = this.fn;
                initializeFields = (runtime, instance) => {
                  const frame = new Frame(runtime, fn.info, fn.slotCount, instance, [], EMPTY_ENV, undefined);
                  for (const { slot, run } of writes) instance.fields[slot] = run(frame);
                };
              },
              true
            )
          );
        } finally {
          this.currentClass = savedClass;
        }
      });
    }
    for (const [name, constructor] of superclass.cls.constructors) {
      if (constructor.kind !== 'generative') continue;
      const signature = substitute({ ...constructor.type, typeParams: [] }, superMap) as FunctionType;
      const superArgs = superclass.args;
      const params = application.typeParams;
      application.constructors.set(name, {
        name,
        owner: application,
        type: { ...signature, returnType: application.thisType },
        kind: 'generative',
        isConst: constructor.isConst,
        row: undefined,
        impl: (runtime, instance, args, typeArgs, callRow) => {
          initializeFields?.(runtime, instance as DartObject);
          const env = new Map(params.map((param, index) => [param, typeArgs[index] ?? DYNAMIC]));
          const resolved = superArgs.map((arg) => substitute(arg, env));
          return (constructor.impl as ConstructorImpl)(runtime, instance, args, resolved, callRow);
        },
      });
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

  // code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
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
    // Constructors initialize the representation as a field of a temporary object; see instantiateObject.
    const field: FieldMember = {
      kind: 'field',
      name,
      owner: cls,
      isStatic: false,
      isAbstract: false,
      row: declaration.row,
      type,
      isFinal: true,
      isLate: false,
      isConst: false,
      isCovariant: false,
      hasInitializer: false,
      slot: cls.fieldCount++,
    };
    cls.fields.push(field);
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

  // code-gauge-allow functionCognitiveComplexity 25 -- Static, late, final, abstract, and external fields differ.
  // code-gauge-allow functionNcss 33 -- Static, late, final, abstract, and external fields differ.
  private declareField(cls: ClassInfo, declaration: FieldDeclaration): void {
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    for (const variable of declaration.variables) {
      const { name } = variable;
      if (cls.members.has(name) || cls.staticMembers.has(name))
        this.error(variable, `${name} という名前は、このクラスで既に宣言されています。`);
      const { initializer } = variable;
      if (!declaredType) {
        // The initializer may use classes declared later, and the overridden field may itself be inferred, so the
        // type is found once every member is declared, superclasses first.
        this.fieldInferences.push(() => this.inferFieldType(cls, name, initializer, declaration.isStatic));
      }
      const type = declaredType ?? DYNAMIC;
      if (declaration.isStatic) {
        this.declareStaticField(cls, declaration, variable, type);
        continue;
      }
      if (declaration.isConst)
        this.error(variable, 'インスタンスのフィールドは const にできません。static const にしてください。');
      if (cls.kind === 'extensionType' && !declaration.isAbstract && !declaration.isExternal) {
        this.error(variable, '拡張型には、インスタンスのフィールドを宣言できません。');
      }
      // With a constructor of its own, the constructor reports the field, as the SDK does.
      const hasConstructor = cls.declaration?.members.some((member) => member.kind === 'constructor') === true;
      if (cls.kind === 'enum' && !declaration.isFinal && !hasConstructor)
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

  /**
   * Dart promotes a private final field only when no class of the library declares a concrete getter or a non-final
   * field of that name, which could make two reads differ.
   */
  protected isPromotableFieldName(name: string): boolean {
    for (const { cls } of this.classWork) {
      const member = cls.members.get(name);
      if (!member || member.isStatic) continue;
      if (member.kind === 'getter' && !member.isAbstract) return false;
      if (member.kind === 'field' && (!member.isFinal || member.isAbstract)) return false;
    }
    return true;
  }

  /** Infers the types of fields declared without one, once every class's members are declared. */
  private readonly fieldInferences: (() => void)[] = [];

  private inferFieldType(cls: ClassInfo, name: string, initializer: Expression | undefined, isStatic: boolean): void {
    const inherited = isStatic ? undefined : this.inheritedFieldType(cls, name);
    if (!inherited && !initializer) return;
    const savedClass = this.currentClass;
    this.currentClass = cls;
    let type: DartType;
    try {
      type =
        inherited ??
        this.withTypeParams(cls.typeParams, () => this.inferInitializerType(initializer as Expression, isStatic, cls));
    } finally {
      this.currentClass = savedClass;
    }
    for (const table of [cls.members, cls.setters, cls.staticMembers, cls.staticSetters]) {
      const member = table.get(name);
      if (member && member.kind !== 'method') member.type = type;
    }
    const field = cls.fields.find((candidate) => candidate.name === name);
    if (field) field.type = type;
    const staticField = cls.staticMembers.get(name);
    if (staticField?.kind === 'field') this.globals[staticField.slot].type = type;
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
    this.fn = new FunctionContext(undefined, info, {
      returnType: undefined,
      isGenerator: false,
      thisClass: cls,
      thisType: cls?.thisType,
      hasThis: !isStatic && !isInitializer && cls !== undefined,
      extensionOn: undefined,
      isInitializer,
      isConstructor: false,
    });
    this.flow = Flow.start();
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

  // code-gauge-allow functionParameterCount 7 -- The parameters are the parts a caller already holds; grouping them would only rename them.
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
      if (isConst) this.checkConstant(initializer, compiled);
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
    const getterImpl = isExternal ? this.native(`${cls.name}.${name}`, 'getter') : undefined;
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
      const setterImpl = isExternal ? this.native(`${cls.name}.${name}=`, 'setter') : undefined;
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
  // code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionNcss 39 -- One case per form of the construct, which reads best together.
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
        if (!initialize) return runtime.throwError('LateError', '', [`Field '${name}' has not been initialized.`]);
        const computed = initialize(runtime, object);
        if (field.isFinal && object.fields[slot] !== UNINITIALIZED) {
          runtime.throwError('LateError', '', [`Field '${name}' has been assigned during initialization.`]);
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
            runtime.throwError('LateError', '', [`Field '${name}' has already been initialized.`]);
          }
          object.fields[slot] = args.positional[0];
          return;
        },
      });
    }
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Methods, accessors, and operators, static or not.
  // code-gauge-allow functionNcss 33 -- Methods, accessors, and operators, static or not.
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
    const impl = declaration.isExternal ? this.externalMember(nativeKey, methodKind) : undefined;
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
        nativeParameterNames: declaration.isExternal
          ? declaration.parameters.positional.map((parameter) => parameter.name)
          : undefined,
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

  private externalMember(nativeKey: string, methodKind: MethodDeclaration['methodKind']): Callable {
    return this.native(
      nativeKey,
      methodKind === 'getter' || methodKind === 'setter' ? methodKind : 'method'
    ) as Callable;
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
  // code-gauge-allow functionCognitiveComplexity 22 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionNcss 36 -- One case per form of the construct, which reads best together.
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
    if (parameters.named.length > 1) type.namedOrder = parameters.named.map((parameter) => parameter.name);
    return { type, positionalTypes, namedTypes };
  }

  private overriddenSignature(cls: ClassInfo, declaration: MethodDeclaration): DartType | undefined {
    for (const supertype of cls.directSupertypes) {
      const resolved = this.interfaceMember(supertype, declaration.name, declaration.methodKind === 'setter');
      if (resolved) return resolved.type;
    }
    return undefined;
  }

  // code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionCognitiveComplexity 18 -- Each branch is one of the cases Dart distinguishes for this construct.
  // code-gauge-allow functionParameterCount 9 -- The parameters are the parts a caller already holds; grouping them would only rename them.
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
    const extension = owner instanceof ClassInfo ? undefined : owner;
    const savedClass = this.currentClass;
    const savedExtension = this.currentExtension;
    this.currentClass = extension ? undefined : cls;
    this.currentExtension = extension;
    const ownerParams = extension ? extension.typeParams : cls.typeParams;
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
            isSetter: declaration.methodKind === 'setter',
            returnType: type.returnType,
            contextReturnType: undefined,
            body,
            typeParams,
            kind: {
              returnType: type.returnType,
              isGenerator: body.modifier === 'sync*',
              thisClass: extension ? undefined : cls,
              thisType: extension ? undefined : cls.thisType,
              hasThis: !declaration.isStatic,
              extensionOn: extension ? extension.onType : cls.kind === 'extensionType' ? cls.thisType : undefined,
              isInitializer: false,
              isConstructor: false,
            },
            showsThis: !declaration.isStatic && !this.isLibraryCode,
            isClosure: false,
          } as FunctionSpec & { isClosure: boolean })
        )
      );
      const typeEnvFor = this.methodTypeEnv(extension ? undefined : cls, ownerParams, typeParams, declaration.isStatic);
      const runFunction = this.runFunction.bind(this);
      (member as MethodMember).impl = (runtime, receiver, args, typeArgs, callRow) =>
        runFunction(compiled, runtime, receiver, [], typeEnvFor(runtime, receiver, typeArgs), args, callRow);
    } finally {
      this.currentClass = savedClass;
      this.currentExtension = savedExtension;
    }
  }

  /**
   * The type environment a method runs in: an extension's type arguments come first among the call's, and a class's
   * come from the receiver.
   */
  private methodTypeEnv(
    ownerClass: ClassInfo | undefined,
    ownerParams: readonly TypeParam[],
    ownTypeParams: readonly TypeParam[],
    isStatic: boolean
  ): (runtime: Runtime, receiver: Value, typeArgs: readonly DartType[]) => TypeEnv {
    if (!ownerClass) {
      return (_runtime, _receiver, typeArgs) => {
        const env = new Map<TypeParam, DartType>();
        for (const [index, param] of ownerParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
        for (const [index, param] of ownTypeParams.entries())
          env.set(param, typeArgs[ownerParams.length + index] ?? DYNAMIC);
        return env;
      };
    }
    return (runtime, receiver, typeArgs) => {
      const typeEnv = isStatic ? new Map() : this.typeEnvOf(runtime, receiver, ownerClass);
      if (ownTypeParams.length === 0) return typeEnv;
      const env = new Map(typeEnv);
      for (const [index, param] of ownTypeParams.entries()) env.set(param, typeArgs[index] ?? DYNAMIC);
      return env;
    };
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
          const object = new DartObject(cls, resolvedArgs, newFields(cls));
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

  // Checks of whole classes

  private checkClass({ cls, declaration }: ClassWork): void {
    if (this.isLibraryCode) return;
    if (cls.kind === 'enum') this.checkEnumMembers(cls, declaration);
    for (const member of cls.members.values()) this.checkOverride(cls, member, false);
    for (const member of cls.setters.values()) this.checkOverride(cls, member, true);
    if (!cls.isAbstract && cls.kind !== 'mixin' && cls.kind !== 'extensionType')
      this.checkImplemented(cls, declaration);
  }

  private checkEnumMembers(cls: ClassInfo, declaration: ClassDeclaration): void {
    for (const member of declaration.members) {
      if (
        member.kind === 'constructor' &&
        member.constructorKind === 'generative' &&
        !member.isConst &&
        member.name !== '\0primaryBody'
      )
        this.error(member, '列挙型のコンストラクタは const にしてください。');
    }
    for (const name of ['index', 'hashCode', '==', 'values']) {
      const own = cls.members.get(name);
      if (!own) continue;
      const isObjectMember = name === 'hashCode' || name === '==';
      if (!isObjectMember)
        this.error({ row: own.row ?? declaration.row }, `列挙型には ${name} というメンバーを宣言できません。`);
      if (isObjectMember && !own.isAbstract)
        this.error({ row: own.row ?? declaration.row }, `列挙型では ${name} を上書きできません。`);
    }
  }

  /** A concrete class must implement every member of its interfaces, unless its noSuchMethod handles them. */
  private checkImplemented(cls: ClassInfo, declaration: ClassDeclaration): void {
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

  // code-gauge-allow functionCognitiveComplexity 22 -- Each branch is one of the cases Dart distinguishes for this construct.
  private checkOverride(cls: ClassInfo, member: Member, setter: boolean): void {
    if (member.isStatic) return;
    for (const supertype of cls.directSupertypes) {
      const inherited = this.interfaceMember(supertype, member.name, setter);
      if (!inherited || inherited.member === member) continue;
      const own = member.type;
      if (setter) {
        this.checkSetterOverride(cls, member, inherited.type);
        continue;
      }
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
        if (!this.isValidOverride(member, inherited.type as FunctionType)) {
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

  private checkSetterOverride(cls: ClassInfo, member: Member, inherited: DartType): void {
    const declaration = cls.declaration?.members.find(
      (candidate): candidate is MethodDeclaration =>
        candidate.kind === 'method' && candidate.methodKind === 'setter' && candidate.name === member.name
    );
    const covariant =
      (member.kind === 'field' && member.isCovariant) ||
      declaration?.parameters.positional[0]?.isCovariant ||
      inheritsCovariance(cls, member.name, '', 0, true);
    if (covariant && member.kind === 'field') member.isCovariant = true;
    if (isSubtype(inherited, member.type) || (covariant && isSubtype(member.type, inherited))) return;
    this.error(
      { row: member.row ?? 0 },
      `${cls.name}.${member.name} の setter の型 ${typeName(member.type)} は、継承した型 ${typeName(inherited)} に合いません。`
    );
  }

  private isValidOverride(member: MethodMember, inherited: FunctionType): boolean {
    const own = member.type;
    if (isSubtype(own, inherited)) return true;
    const { owner, name } = member;
    const declaration = owner.declaration?.members.find(
      (candidate): candidate is MethodDeclaration =>
        candidate.kind === 'method' && candidate.name === name && candidate.methodKind !== 'setter'
    );
    const relax = (
      type: DartType,
      other: DartType | undefined,
      parameter: FormalParameter | undefined,
      index?: number
    ): DartType => {
      if (
        other &&
        isSubtype(type, other) &&
        (parameter?.isCovariant || inheritsCovariance(owner, name, parameter?.name ?? '', index))
      )
        return other;
      return type;
    };
    const relaxed: FunctionType = {
      ...own,
      positional: own.positional.map((type, index) =>
        relax(type, inherited.positional[index], declaration?.parameters.positional[index], index)
      ),
      named: own.named.map((named) => {
        const other = inherited.named.find((candidate) => candidate.name === named.name);
        const parameter = declaration?.parameters.named.find((candidate) => candidate.name === named.name);
        return { ...named, type: relax(named.type, other?.type, parameter) };
      }),
    };
    return isSubtype(relaxed, inherited);
  }

  // Extensions

  // code-gauge-allow functionCognitiveComplexity 23 -- Each branch is one of the cases Dart distinguishes for this construct.
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
    if (declaration.isExternal) {
      const kind = declaration.functionKind === 'function' ? 'method' : declaration.functionKind;
      fn.impl = this.native(
        declaration.functionKind === 'setter' ? `${declaration.name}=` : declaration.name,
        kind
      ) as Callable;
    }
    (fn as TopLevelFunction & { typeParams?: TypeParam[] }).typeParams = typeParams;
  }

  // code-gauge-allow duplicateLines 24 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
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

  /** Declares a declaration's variables and returns the compilation of their initializers, to run once all are. */
  private declareTopLevelVariables(declaration: VariableDeclaration): (() => void)[] {
    const declaredType = declaration.type ? this.resolveType(declaration.type) : undefined;
    const initializers: (() => void)[] = [];
    for (const variable of declaration.variables) {
      if (declaration.isConst && !variable.initializer)
        this.error(variable, `const の ${variable.name} には初期値が必要です。`);
      const type = declaredType ?? DYNAMIC;
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
      if (!initializer) continue;
      if (!declaredType) this.inferTypeOnFirstUse(global, initializer);
      initializers.push(() => {
        void global.type;
        this.compileGlobalInitializer(global, initializer, declaration.isConst, undefined);
      });
    }
    return initializers;
  }

  /**
   * Infers a top-level variable's type from its initializer when something first needs it, so that initializers may
   * use variables declared after them, as Dart infers top-level variables in the order they depend on each other.
   */
  private inferTypeOnFirstUse(global: GlobalVariable, initializer: Expression): void {
    let state: 'pending' | 'inferring' | 'done' = 'pending';
    let inferred: DartType = DYNAMIC;
    Object.defineProperty(global, 'type', {
      configurable: true,
      enumerable: true,
      get: () => {
        if (state === 'inferring') {
          this.error(
            initializer,
            `${global.name} の型は、自分の初期値に依存しているので推論できません。型を書いてください。`
          );
        }
        if (state === 'pending') {
          state = 'inferring';
          inferred = this.inferInitializerType(initializer, true, undefined);
          state = 'done';
        }
        return inferred;
      },
      set: (value: DartType) => {
        inferred = value;
        state = 'done';
      },
    });
  }

  // Runtime glue the expression compilers call

  readGlobal(global: GlobalVariable): Eval {
    const { slot } = global;
    return (frame) => readGlobalValue(frame.runtime, this.globals[slot] ?? global);
  }

  tearOffFunction(fn: TopLevelFunction): Eval {
    return (frame) => {
      // Tear-offs of a top-level function are canonical, so `identical(f, f)` holds.
      const { tearOffs } = frame.runtime;
      const existing = tearOffs.get(fn);
      if (existing) return existing;
      const closure = new DartClosure(
        coreTypes.function,
        fn.type,
        (runtime, _receiver, args, typeArgs, callRow) =>
          (fn.impl as Callable)(runtime, undefined, args, typeArgs, callRow),
        undefined,
        [],
        { name: fn.name, origin: `Function '${fn.name}': static.` },
        fn
      );
      tearOffs.set(fn, closure);
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

  protected native(key: string, kind: 'method' | 'getter' | 'setter' = 'method'): Callable | ConstructorImpl {
    const found = this.natives.get(key);
    if (found) return found;
    if (!this.isLibraryCode) return missingExternal(key, kind);
    // A library member without a native fails only when a program calls it.
    return () => {
      throw new Error(`The interpreter has no native for ${key}`);
    };
  }
}

function declarationRow(declaration: Declaration): number | undefined {
  switch (declaration.kind) {
    case 'class': {
      return declaration.cls.declaration?.row;
    }
    case 'function': {
      return declaration.fn.row;
    }
    case 'variable': {
      return declaration.global.row;
    }
    default: {
      return undefined;
    }
  }
}

/**
 * An `external` member of the program, which the SDK compiles but which has no body, so calling it throws the
 * NoSuchMethodError the VM throws.
 */
function missingExternal(key: string, kind: 'method' | 'getter' | 'setter'): Callable {
  const dot = key.indexOf('.');
  const owner = dot === -1 ? undefined : key.slice(0, dot);
  const name = key.slice(dot + 1);
  return (runtime, _receiver, args) => {
    const shown = args.positional.map((value) => runtime.links.stringify(runtime, value)).join(', ');
    const call = kind === 'method' ? `${name}(${shown})` : name;
    const message = owner
      ? `NoSuchMethodError: No static ${kind} '${name}' declared in class '${owner}'.\nReceiver: ${owner}\nTried calling: ${call}`
      : `NoSuchMethodError: No top-level ${kind} '${name}' declared.\nReceiver: top-level\nTried calling: ${call}`;
    return runtime.throwError('NoSuchMethodError', '_withMessage', [message]);
  };
}

/**
 * The fields of a new object: a nullable field without an initializer starts as null, and the others are unset until
 * their initializers run, which traces show by leaving them out.
 */
function newFields(cls: ClassInfo): Value[] {
  const fields: Value[] = Array.from({ length: cls.fieldCount }, () => UNINITIALIZED);
  for (const current of cls.superclassChain()) {
    for (const field of current.fields) {
      if (!field.isLate && !field.hasInitializer && isNullable(field.type)) fields[field.slot] = undefined;
    }
  }
  return fields;
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
  const object = new DartObject(cls, typeArgs, newFields(cls));
  impl(runtime, object, args, typeArgs, callRow);
  // An extension type's value is its representation, which its constructor stores in the object's only field.
  if (cls.kind === 'extensionType') return object.fields[0];
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
  // A read during the global's own initialization runs the initializer again, as the VM does, which recursion of
  // the initializers turns into a StackOverflowError.
  if (value !== UNINITIALIZED && value !== INITIALIZING) return value;
  if (!global.initialize) {
    runtime.throwError('LateError', '', [`Field '${global.name}' has not been initialized.`]);
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
  objectType,
  type TypeAlias,
};

/** Records a class among the subclasses of the sealed classes it extends or implements, for exhaustiveness. */
function registerSealedSubclass(cls: ClassInfo): void {
  for (const supertype of cls.directSupertypes) {
    const supercls = supertype.cls;
    if (supercls.modifiers.isSealed && supercls.library === cls.library) supercls.subclasses.push(cls);
  }
  if (!cls.superclass?.cls.mixinOf) return;
  // Sealed classes count the class written in the source, not its mixin applications.
  let current: ClassInfo | undefined = cls.superclass.cls;
  while (current?.mixinOf) current = current.superclass?.cls;
  if (current?.modifiers.isSealed && current.library === cls.library && !current.subclasses.includes(cls))
    current.subclasses.push(cls);
}
