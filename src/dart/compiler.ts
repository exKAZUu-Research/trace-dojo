// code-gauge-allow-file fileNcss 1000 -- Keep declaration checks alongside the declarations and signatures they use.
import { misplacedAtomicMessage } from '../interpreter/traceAnnotations';
import type {
  ClassDeclaration,
  Expression,
  ExtensionDeclaration,
  FieldDeclaration,
  FormalParameter,
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
  memberTypeIn,
  type MethodMember,
  sourceMemberName,
} from './classes';
import { at, type Compiled, type Eval, typeName } from './compilerBase';
import { EMPTY_ENV } from './constructorCompiler';
import {
  type Declaration,
  type ExtensionInfo,
  type GlobalVariable,
  type LibraryEnv,
  type TopLevelFunction,
  type TypeAlias,
} from './environment';
import { eraseExtensionTypes, eraseFunctionType } from './eraseExtensionTypes';
import { initializeField, lateFieldGetter, lateFieldSetter } from './lateFields';
import { markCovariantParameters, MemberCompiler } from './memberCompiler';
import { checkRepresentationCycles } from './representationCycles';
import { Frame, type FunctionInfo, type Runtime, type TypeEnv } from './runtime';
import { type FunctionContext, primaryParameterInInitializer } from './scope';
import { type GenExec, inheritsCovariance } from './statementCompiler';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  functionType,
  instantiateToBounds,
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
import { type Arguments, type Callable, Cell, DartClosure, DartObject, UNINITIALIZED, type Value } from './values';

/** The natives that `external` members of the interpreter's own libraries bind to, by `Class.member` or name. */
export type NativeTable = ReadonlyMap<string, Callable | ConstructorImpl>;

export interface CompileOptions {
  atomicRows?: ReadonlySet<number>;
}

export interface CompiledProgram {
  main: TopLevelFunction;
  globals: GlobalVariable[];
  recordFieldNames: ReadonlySet<string>;
  /** The globals the program itself declares, which traces show. */
  programGlobals: GlobalVariable[];
  mainTakesArguments: boolean;
}

interface ClassWork {
  cls: ClassInfo;
  declaration: ClassDeclaration;
}

/** Compiles the declarations of a library: classes, members, constructors, extensions, and top-level members. */
export class Compiler extends MemberCompiler {
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
            declaration,
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
    checkRepresentationCycles(this.classWork, (span, name) =>
      this.error(span, `拡張型 ${name} が、表現型を通して自分自身に依存しています。`)
    );
    this.checkHierarchy();
    const boundChecks = this.pendingBoundChecks;
    this.pendingBoundChecks = undefined;
    for (const check of boundChecks) check();
    const orderedClasses = this.orderedClassWork();
    for (const work of orderedClasses) this.declareMembers(work);
    for (const { ext, declaration } of this.extensionWork) this.declareExtension(ext, declaration);
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'function') this.resolveTopLevelSignature(declaration);
    }
    this.compileGlobalInitializers(syntax, orderedClasses);
  }

  private compileGlobalInitializers(syntax: Library, classes: readonly ClassWork[]): void {
    // Every top-level variable is declared before any initializer compiles, as initializers may use later ones.
    const initializers: (() => void)[] = [];
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'variables') initializers.push(...this.declareTopLevelVariables(declaration));
    }
    const resolveFields = this.fieldInferences.map(({ cls, variable }) => this.prepareFieldInference(cls, variable));
    for (const { cls } of classes) {
      for (const constructor of cls.constructors.values()) void constructor.type;
    }
    this.checkDeferredFunctionTypeAnnotations();
    for (const resolve of resolveFields) resolve();
    this.fieldInferences.length = 0;
    for (const work of classes) this.checkClass(work);
    if (!this.isLibraryCode) {
      for (const { application, span } of this.pendingApplications) this.checkMemberOverrides(application, span);
    }
    for (const compile of initializers) compile();
  }

  /** Compiles every body. */
  compileAll(syntax: Library): void {
    this.checkDeclarationAnnotations(syntax, this.classWork, this.extensionWork);
    for (const declaration of syntax.declarations) {
      if (declaration.kind === 'function') this.compileTopLevelFunction(declaration);
    }
    for (const body of this.deferredBodies) body();
    this.deferredBodies.length = 0;
    this.checkConstructorRedirects();
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
      for (const supertype of work.cls.directSupertypes) visitType(supertype.cls);
      ordered.push(work);
    };
    const visitType = (cls: ClassInfo): void => {
      const declared = byClass.get(cls);
      if (declared) visit(declared);
      else if (cls.mixinOf) {
        visitType(cls.mixinOf);
        if (cls.superclass) visitType(cls.superclass.cls);
      }
    };
    for (const work of this.classWork) visit(work);
    return ordered;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Each branch is one of the cases Dart distinguishes for this construct.
  private resolveHeader(work: ClassWork): void {
    const { cls, declaration } = work;
    this.withTypeParams(cls.typeParams, () => {
      this.resolveSuperclass(work);
      this.resolveMixins(work);
      if (cls.kind === 'mixinClass' && cls.superclass?.cls !== coreTypes.object)
        this.error(
          declaration.mixins[0] ?? declaration.superclass ?? declaration,
          'mixin class のスーパークラスは Object でなければなりません。'
        );
      const interfaces = declaration.interfaces.map((type) =>
        this.resolveSupertype(cls, type, '実装するインターフェース')
      );
      for (const [index, type] of interfaces.entries()) {
        if (interfaces.slice(0, index).some((other) => other.cls === type.cls)) {
          this.error(declaration.interfaces[index], `${type.cls.name} は、1 回しか implements に書けません。`);
        }
      }
      cls.interfaces.push(...interfaces);
      if (declaration.classKind === 'extensionType') {
        const parameter = declaration.primaryConstructor?.parameters.positional[0];
        if (!parameter?.type) this.error(declaration, '拡張型には、表す値の型を書いてください。');
        cls.representationType = this.inDeclarationScope(cls, undefined, () =>
          this.resolveType(parameter.type as TypeSyntax)
        );
        cls.representationName = parameter.name;
      }
    });
    if (cls.kind !== 'extensionType') registerSealedSubclass(cls);
  }

  private resolveMixins({ cls, declaration }: ClassWork): void {
    if (declaration.mixins.length === 0) return;
    let base = cls.superclass ?? objectType();
    for (const [index, syntax] of declaration.mixins.entries()) {
      const mixin = this.resolveSupertype(cls, syntax, 'mixin');
      if (mixin.cls.kind !== 'mixin' && mixin.cls.kind !== 'mixinClass' && !this.isLibraryCode)
        this.error(syntax, `${mixin.cls.name} は mixin ではないので、with には書けません。`);
      const named = declaration.namedMixinApplication === true && index === declaration.mixins.length - 1;
      base = this.mixinApplication(base, mixin, cls, syntax, named);
    }
    if (!declaration.namedMixinApplication) cls.superclass = base;
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
    const type = this.resolveTypeWithoutAnnotations(syntax);
    if (type.kind !== 'interface' || type.nullable) {
      return this.error(syntax, `${typeToString(type)} は${role}にできません。`);
    }
    if (cls.kind === 'extensionType') {
      if (type.cls === coreTypes.function || type.cls === coreTypes.record)
        this.error(syntax, `${typeToString(type)} は${role}にできません。`);
    } else if (type.cls.kind === 'extensionType') {
      this.error(syntax, `拡張型 ${type.cls.name} は${role}にできません。`);
    } else {
      this.checkSubtypeAllowed(cls, type.cls, role, syntax);
    }
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
    span: Span,
    named: boolean
  ): InterfaceType {
    const application = named
      ? owner
      : new ClassInfo(`${superclass.cls.name} with ${mixin.cls.name}`, 'class', owner.library);
    if (!named) {
      application.typeParams.push(...owner.typeParams);
      application.modifiers = { isAbstract: true, isSealed: false, isBase: false, isFinal: false, isInterface: false };
    }
    application.superclass = superclass;
    application.interfaces = [mixin];
    application.mixinOf = mixin.cls;
    (application as ClassInfo & { mixinArgs?: readonly DartType[] }).mixinArgs = mixin.args;
    this.pendingApplications.push({ application, mixin, span });
    return interfaceType(
      application,
      owner.typeParams.map((param) => typeParamType(param))
    );
  }

  private readonly pendingApplications: { application: ClassInfo; mixin: InterfaceType; span: Span }[] = [];

  private checkHierarchy(): void {
    this.checkSuperclassCycles();
    for (const { application, mixin, span } of this.pendingApplications) {
      if (application.superclass && !this.isLibraryCode)
        this.checkMixinConstraints(application.superclass, mixin, span);
    }
    for (const { cls, declaration } of this.classWork) {
      const conflict = this.isLibraryCode ? undefined : cls.conflictingSupertype();
      if (conflict)
        this.error(
          declaration,
          `${cls.name} は ${typeToString(conflict.first)} と ${typeToString(conflict.second)} の両方を実装できません。`
        );
      if (cls.representationType)
        this.checkRepresentationInterfaces(cls, cls.representationType, declaration.interfaces);
    }
  }

  private checkSuperclassCycles(): void {
    const visiting = new Set<ClassInfo>();
    const checked = new Set<ClassInfo>();
    const visit = (cls: ClassInfo, span: Span): void => {
      if (checked.has(cls)) return;
      if (visiting.has(cls)) this.error(span, `クラス ${cls.name} の継承が循環しています。`);
      visiting.add(cls);
      for (const parent of cls.directSupertypes) visit(parent.cls, parent.cls.declaration ?? span);
      visiting.delete(cls);
      checked.add(cls);
    };
    for (const { cls, declaration } of this.classWork) visit(cls, declaration);
  }

  // code-gauge-allow functionCognitiveComplexity 24 -- Each kind of member declares itself differently.
  private declareMembers({ cls, declaration }: ClassWork): void {
    this.currentClass = cls;
    try {
      this.withTypeParams(cls.typeParams, () => {
        this.applyPendingMixins(cls);
        if (!declaration.namedMixinApplication) cls.fieldCount = cls.superclass?.cls.fieldCount ?? 0;
        if (declaration.classKind === 'extensionType') this.declareRepresentation(cls, declaration);
        if (declaration.primaryConstructor && declaration.classKind !== 'extensionType') {
          this.declarePrimaryConstructorFields(cls, declaration);
        }
        for (const member of declaration.members) {
          if (member.kind !== 'constructor') this.declareAccessibleMember(cls, member, cls);
        }
        if (declaration.classKind === 'enum') this.declareEnumValues(cls, declaration);
        for (const member of declaration.members)
          if (member.kind === 'constructor') this.declareConstructor(cls, member);
        if (declaration.primaryConstructor) this.declarePrimaryConstructor(cls, declaration);
        if (
          needsImplicitConstructor(cls) &&
          declaration.classKind !== 'mixin' &&
          declaration.classKind !== 'extensionType' &&
          !declaration.namedMixinApplication
        ) {
          this.declareDefaultConstructor(cls, declaration);
        }
      });
    } finally {
      this.currentClass = undefined;
    }
    cls.resetCaches();
  }

  private declareAccessibleMember(
    cls: ClassInfo,
    member: FieldDeclaration | MethodDeclaration,
    owner: ClassInfo | ExtensionInfo
  ): void {
    const declarations = member.kind === 'field' ? member.variables : [member];
    for (const declaration of declarations) {
      this.checkEnclosingMemberName(owner, declaration.name, declaration);
      if (!(owner instanceof ClassInfo) || owner.kind === 'extensionType')
        this.checkExtensionMemberName(declaration.name, declaration);
    }
    this.withTypeParams(
      owner.typeParams,
      () => {
        if (member.kind === 'field') this.declareField(cls, member);
        else this.declareMethod(cls, member, owner);
      },
      member.isStatic
    );
  }

  private checkExtensionMemberName(name: string, span: Span): void {
    if (coreTypes.object.members.has(name) || coreTypes.object.setters.has(name))
      this.error(span, `拡張のメンバー ${name} は Object のメンバーと重複しています。`);
  }

  /** Copies a mixin's members into the applications that use it, once the mixin's own members are declared. */
  private applyPendingMixins(cls: ClassInfo): void {
    let current = cls.mixinOf ? cls : cls.superclass?.cls;
    const applications: ClassInfo[] = [];
    while (current?.mixinOf) {
      applications.unshift(current);
      current = current.superclass?.cls;
    }
    for (const application of applications) {
      if (application.mixinMembersApplied) continue;
      application.mixinMembersApplied = true;
      const mixin = application.mixinOf as ClassInfo;
      application.fieldCount = application.superclass?.cls.fieldCount ?? 0;
      const mixinArgs = (application as ClassInfo & { mixinArgs?: readonly DartType[] }).mixinArgs ?? [];
      const map = new Map(mixin.typeParams.map((param, index) => [param, mixinArgs[index] ?? DYNAMIC]));
      const fieldsByOriginalSlot = new Map<number, FieldMember>();
      for (const field of mixin.fields) {
        const copy: FieldMember = {
          ...field,
          owner: application,
          type: substitute(field.type, map),
          slot: application.fieldCount++,
        };
        fieldsByOriginalSlot.set(field.slot, copy);
        application.fields.push(copy);
      }
      for (const [name, member] of mixin.members)
        application.members.set(name, this.copyMixinMember(member, application, map, fieldsByOriginalSlot));
      for (const [name, member] of mixin.setters)
        application.setters.set(name, this.copyMixinMember(member, application, map, fieldsByOriginalSlot));
      this.declareForwardingConstructors(application, mixin, fieldsByOriginalSlot);
      application.resetCaches();
    }
  }

  /**
   * A mixin application has a constructor for each generative constructor of its superclass, which initializes the
   * mixin's fields and passes its arguments on, as Dart's forwarding constructors do.
   */
  // code-gauge-allow functionCognitiveComplexity 30 -- Constructor forwarding and mixin field initialization share the slot mapping.
  // code-gauge-allow functionNcss 44 -- Constructor forwarding and mixin field initialization share the slot mapping.
  private declareForwardingConstructors(
    application: ClassInfo,
    mixin: ClassInfo,
    fieldsByOriginalSlot: ReadonlyMap<number, FieldMember>
  ): void {
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
                    writes.push({ slot: fieldsByOriginalSlot.get(field.slot)?.slot ?? field.slot, run: compiled.run });
                  }
                }
                const fn = this.fn;
                initializeFields = (runtime, instance) => {
                  const env = this.typeEnvOf(runtime, instance, mixin);
                  const frame = new Frame(runtime, fn.info, fn.slotCount, instance, [], env, undefined);
                  runtime.enter(frame);
                  try {
                    for (const { slot, run } of writes) instance.fields[slot] = run(frame);
                  } finally {
                    runtime.exit(frame);
                  }
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
      const superArgs = superclass.args;
      const params = application.typeParams;
      let type: FunctionType | undefined;
      application.constructors.set(name, {
        name,
        owner: application,
        forwardedFrom: constructor.forwardedFrom ?? constructor.owner,
        get type() {
          return (type ??= {
            ...(substitute({ ...constructor.type, typeParams: [] }, superMap) as FunctionType),
            returnType: application.thisType,
          });
        },
        kind: 'generative',
        isConst: constructor.isConst && mixin.fields.length === 0,
        row: undefined,
        get defaults() {
          return constructor.defaults;
        },
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
    fieldsByOriginalSlot: ReadonlyMap<number, FieldMember>
  ): Member {
    if (member.kind === 'field') return fieldsByOriginalSlot.get(member.slot) as FieldMember;
    const copy = { ...member, owner: application, type: substitute(member.type, map) } as Member;
    const late = this.lateFieldAccessors.get(member);
    if (late) {
      const field = fieldsByOriginalSlot.get(late.field.slot) as FieldMember;
      (copy as MethodMember).impl = late.bind(field);
      this.lateFieldAccessors.set(copy, { field, bind: late.bind });
      return copy;
    }
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
    this.checkEnclosingMemberName(cls, name, declaration);
    this.checkExtensionMemberName(name, declaration);
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
      if (parameter.binding !== 'plain' || (!parameter.isFinal && !parameter.isVar)) continue;
      if (!parameter.type) this.error(parameter, `フィールド ${parameter.name} の型を書いてください。`);
      this.declareAccessibleMember(
        cls,
        {
          ...parameter,
          kind: 'field',
          isStatic: false,
          isFinal: parameter.isFinal,
          isConst: false,
          isLate: false,
          isCovariant: parameter.isCovariant,
          isExternal: false,
          isAbstract: false,
          type: parameter.type,
          variables: [{ ...parameter, name: parameter.name, initializer: undefined }],
          annotations: [],
        },
        cls
      );
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
      if (!declaredType && !declaration.isStatic) {
        this.fieldInferences.push({ cls, variable });
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
      const field = this.backingField(member);
      if (field ? !field.isFinal || field.isAbstract : member.kind === 'getter' && !member.isAbstract) return false;
    }
    return true;
  }

  protected backingField(member: Member): FieldMember | undefined {
    return member.kind === 'field' ? member : this.lateFieldAccessors.get(member)?.field;
  }

  private readonly fieldInferences: { cls: ClassInfo; variable: FieldDeclaration['variables'][number] }[] = [];

  private prepareFieldInference(cls: ClassInfo, variable: FieldDeclaration['variables'][number]): () => void {
    const { name, initializer } = variable;
    const infer = this.memoizeTypeInference(name, variable, () => {
      const inherited = this.inheritedFieldType(cls, name);
      if (inherited || !initializer) return inherited ?? DYNAMIC;
      return this.inDeclarationScope(cls, undefined, () =>
        this.withIsolatedTypes(() =>
          this.withTypeParams(cls.typeParams, () => this.inferInitializerType(initializer, false, cls))
        )
      );
    });
    const resolve = this.bindInferredFieldType(cls, name, infer);
    const resolveApplications: (() => void)[] = [];
    for (const { application, mixin } of this.pendingApplications) {
      if (mixin.cls !== cls) continue;
      const map = new Map(cls.typeParams.map((param, index) => [param, mixin.args[index] ?? DYNAMIC]));
      resolveApplications.push(this.bindInferredFieldType(application, name, () => substitute(infer(), map)));
    }
    return () => {
      resolve();
      for (const resolveApplication of resolveApplications) resolveApplication();
    };
  }

  private bindInferredFieldType(cls: ClassInfo, name: string, infer: () => DartType): () => void {
    const members = [cls.members.get(name), cls.setters.get(name), cls.fields.find((field) => field.name === name)];
    const targets = new Set(members.filter((member) => member !== undefined && member.kind !== 'method'));
    for (const target of targets) {
      Object.defineProperty(target, 'type', { get: infer });
    }
    return () => {
      const type = infer();
      for (const target of targets) {
        Object.defineProperty(target, 'type', { value: type, writable: true });
      }
    };
  }

  /** A field without a type takes the type of the member it overrides, as Dart infers. */
  private inheritedFieldType(cls: ClassInfo, name: string): DartType | undefined {
    const member = cls.inheritedInterfaceMember(this.runtimeMemberName(name), false);
    return member && member.kind !== 'method' ? memberTypeIn(cls.thisType, member) : undefined;
  }

  /** The type of a field's or variable's initializer, compiled ahead of the body to infer the declaration's type. */
  private inferInitializerType(initializer: Expression, isStatic: boolean, cls: ClassInfo | undefined): DartType {
    const compiled = this.inTemporaryFunction(isStatic, cls, () => {
      if (!isStatic && cls) this.declarePrimaryParametersForInference(cls);
      return this.compileExpression(initializer);
    });
    if (compiled.type.kind === 'null') return DYNAMIC;
    return compiled.type;
  }

  /** Declares the primary constructor's parameters, typed as its signature types them, as its field initializers see them. */
  private declarePrimaryParametersForInference(cls: ClassInfo): void {
    const primary = cls.declaration?.primaryConstructor;
    const signature = primary && cls.constructors.get(primary.name ?? '')?.type;
    if (!primary || !signature) return;
    const typed = [
      ...primary.parameters.positional.map((parameter, index) => [parameter, signature.positional[index]] as const),
      ...primary.parameters.named.map(
        (parameter) =>
          [parameter, signature.named.find((named) => named.name === parameter.argumentName)?.type] as const
      ),
    ];
    for (const [parameter, type] of typed) {
      const variable = this.declareLocal(parameter, parameter.name, type ?? DYNAMIC, {
        isFinal: false,
        isLate: false,
        isConst: false,
        isParameter: true,
        hasInitializer: true,
      });
      this.fn.scopes.at(-1)?.names.set(parameter.name, primaryParameterInInitializer(variable));
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
    if (!variable.initializer && !declaration.isLate && !this.isLibraryCode && !declaration.isExternal) {
      if (declaration.isFinal)
        this.error(variable, `final の static なフィールド ${variable.name} には、初期値が必要です。`);
      else if (!isNullable(type))
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
      if (!declaration.type) {
        this.inferTypeOnFirstUse(global, initializer, () => {
          field.type = this.inferInitializerType(initializer, true, cls);
          return field.type;
        });
      }
      this.deferredBodies.push(() => {
        this.inGlobalTypeScope(global, () =>
          this.compileGlobalInitializer(global, initializer, declaration.isConst, cls)
        );
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
  // code-gauge-allow duplicateLines 16 -- Global and late initializers use different receiver environments.
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

  private readonly lateFieldAccessors = new WeakMap<
    Member,
    { field: FieldMember; bind: (field: FieldMember) => Callable }
  >();

  // code-gauge-allow duplicateLines 16 -- Late and global initializers use different receiver environments.
  private declareLateField(cls: ClassInfo, field: FieldMember, initializer: Expression | undefined): void {
    const { name } = field;
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
    this.installLateFieldAccessor(cls, field, 'getter', (mapped) => lateFieldGetter(mapped, () => lateInit));
    if (!field.isFinal || !initializer) this.installLateFieldAccessor(cls, field, 'setter', lateFieldSetter);
  }

  private installLateFieldAccessor(
    cls: ClassInfo,
    field: FieldMember,
    kind: 'getter' | 'setter',
    bind: (field: FieldMember) => Callable
  ): void {
    const accessor = {
      name: field.name,
      owner: cls,
      isStatic: false,
      isAbstract: false,
      row: field.row,
      type: field.type,
      impl: bind(field),
    };
    const member: Member =
      kind === 'setter' ? { ...accessor, kind, isCovariant: field.isCovariant } : { ...accessor, kind };
    (kind === 'getter' ? cls.members : cls.setters).set(field.name, member);
    this.lateFieldAccessors.set(member, { field, bind });
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- Methods, accessors, and operators, static or not.
  // code-gauge-allow functionNcss 33 -- Methods, accessors, and operators, static or not.
  private declareMethod(cls: ClassInfo, declaration: MethodDeclaration, owner: ClassInfo | ExtensionInfo = cls): void {
    const typeParams = this.withoutFunctionTypeAnnotations(() => this.declareTypeParams(declaration.typeParameters));
    const isExtension = !(owner instanceof ClassInfo);
    const canBeAbstract = !declaration.isStatic && !isExtension && cls.kind !== 'extensionType';
    if (!canBeAbstract) this.checkCovariantFormals(declaration.parameters);
    const { type, positionalTypes, namedTypes } = this.withTypeParams(typeParams, () =>
      this.signatureOf(declaration.parameters, declaration.returnType, typeParams, {
        cls: isExtension ? undefined : cls,
        declaration,
      })
    );
    const { name, methodKind } = declaration;
    const isAbstract = !declaration.body && !declaration.isExternal;
    if (isAbstract && !canBeAbstract && !this.isLibraryCode) {
      this.error(declaration, `${cls.name}.${name} に本体がありません。`);
    }
    if (methodKind === 'operator' && declaration.isStatic) this.error(declaration, '演算子は static にできません。');
    this.checkOperatorSignature(declaration, type.returnType);
    const nativeKey = `${isExtension ? (owner as ExtensionInfo).name : cls.name}.${methodKind === 'setter' ? `${name}=` : name}`;
    const impl = declaration.isExternal ? this.externalMember(nativeKey, methodKind) : undefined;
    const member = this.declaredMember(cls, declaration, type, positionalTypes[0], impl, isAbstract);
    if (!isExtension && !member.isStatic && (member.kind === 'method' || member.kind === 'setter'))
      markCovariantParameters(cls, member, declaration.parameters);
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
    if (!isExtension && !member.isStatic && member.kind !== 'getter')
      member.forwarding = {
        bind: undefined,
        positionalNames: declaration.parameters.positional.map((param) => param.name),
      };
    if (declaration.body || member.forwarding) {
      this.deferredBodies.push(() =>
        this.compileMethodBody(cls, owner, declaration, member, typeParams, positionalTypes, namedTypes, type)
      );
    }
  }

  private externalMember(nativeKey: string, methodKind: MethodDeclaration['methodKind']): Callable {
    return this.native(
      nativeKey,
      methodKind === 'getter' || methodKind === 'setter' ? methodKind : 'method'
    ) as Callable;
  }

  private checkOperatorSignature(declaration: MethodDeclaration, returnType: DartType): void {
    if (declaration.methodKind !== 'operator') return;
    const count = declaration.parameters.positional.length;
    const writesIndex = declaration.name === '[]=';
    if (writesIndex && returnType.kind !== 'void')
      this.error(declaration, '演算子 []= の戻り値の型には void を書くか、省略してください。');
    const expected = writesIndex ? 2 : declaration.name === '~' || declaration.name === 'unary-' ? 0 : 1;
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

  // Enums

  // code-gauge-allow functionNcss 31 -- Validate and register enum values in declaration order.
  private declareEnumValues(cls: ClassInfo, declaration: ClassDeclaration): void {
    const valuesMember = cls.staticMembers.get('values') ?? cls.members.get('values') ?? cls.setters.get('values');
    if (valuesMember)
      this.error({ row: valuesMember.row ?? declaration.row }, '列挙型には values というメンバーを宣言できません。');
    const names = new Set<string>();
    const values: GlobalVariable[] = [];
    const enumType = interfaceType(cls, instantiateToBounds(cls.typeParams));
    for (const [index, constant] of declaration.enumConstants.entries()) {
      this.checkEnclosingMemberName(cls, constant.name, constant);
      if (names.has(constant.name)) this.error(constant, `列挙型の値 ${constant.name} が重複しています。`);
      if (constant.name === 'values' || constant.name === 'index')
        this.error(constant, `列挙型の値に ${constant.name} という名前は付けられません。`);
      names.add(constant.name);
      const global = this.newGlobal(
        constant.name,
        `${cls.name}.${constant.name}`,
        enumType,
        { isFinal: true, isConst: true, isLate: false },
        true,
        cls,
        constant.row
      );
      const field: FieldMember = {
        kind: 'field',
        name: constant.name,
        owner: cls,
        isStatic: true,
        isAbstract: false,
        row: constant.row,
        get type() {
          return global.type;
        },
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
      this.inferTypeOnFirstUse(global, constant, () => this.compileEnumConstant(cls, constant, index, global));
      this.deferredBodies.push(() => {
        void global.type;
      });
    }
    const listType = interfaceType(coreTypes.list, [enumType]);
    const valuesGlobal = this.newGlobal(
      'values',
      `${cls.name}.values`,
      listType,
      { isFinal: true, isConst: true, isLate: false },
      true,
      cls,
      declaration.row
    );
    const elementType = eraseExtensionTypes(enumType);
    valuesGlobal.initialize = (runtime) => {
      const elements = values.map((global) => readGlobalValue(runtime, global));
      return runtime.links.newList(runtime, elementType, elements, false, true);
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
  ): DartType {
    return this.inTemporaryFunction(true, cls, () => {
      const constructor = cls.constructors.get(constant.constructorName ?? '');
      if (!constructor)
        this.error(
          constant,
          `列挙型 ${cls.name} に${constant.constructorName ? ` ${constant.constructorName} という` : '名前のない'}コンストラクタがありません。`
        );
      const args = constant.arguments ?? { ...at(constant), positional: [], named: [], order: [] };
      const signature = { ...constructor.type, typeParams: cls.typeParams };
      const bound = this.withConstContext(true, () =>
        this.bindArguments(signature, args, constant.typeArguments, constant, undefined)
      );
      if (!bound.argumentsAreConst) this.error(constant, '列挙値の引数には定数を渡してください。');
      const fn = this.fn;
      const { name } = constant;
      global.initialize = (runtime) => {
        const frame = new Frame(runtime, fn.info, fn.slotCount, undefined, [], new Map(), undefined);
        const resolvedArgs = bound.typeArgs(frame);
        const object = new DartObject(cls, resolvedArgs, newFields(cls));
        object.native = { index: BigInt(index), name, values: () => [] };
        const evaluated = bound.args(frame);
        (constructor.impl as ConstructorImpl)(runtime, object, evaluated, resolvedArgs, undefined);
        return object;
      };
      this.checkConstant(constant, { type: bound.returnType, run: this.readGlobal(global), isConst: true });
      return bound.returnType;
    });
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
    this.checkMemberOverrides(cls);
    if (cls.kind !== 'mixin' && cls.kind !== 'extensionType') this.checkImplemented(cls, declaration);
  }

  private checkMemberOverrides(cls: ClassInfo, span?: Span): void {
    for (const member of cls.members.values()) this.checkOverride(cls, member, false, span);
    for (const member of cls.setters.values()) this.checkOverride(cls, member, true, span);
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
    for (const name of ['index', 'hashCode', '==']) {
      const own = cls.members.get(name);
      if (!own) continue;
      const isObjectMember = name === 'hashCode' || name === '==';
      if (!isObjectMember)
        this.error({ row: own.row ?? declaration.row }, `列挙型には ${name} というメンバーを宣言できません。`);
      if (isObjectMember && !own.isAbstract)
        this.error({ row: own.row ?? declaration.row }, `列挙型では ${name} を上書きできません。`);
    }
  }

  private checkImplemented(cls: ClassInfo, declaration: ClassDeclaration): void {
    const obligations = cls.isAbstract ? cls.interfaces : [...this.implementationObligations(cls), cls.thisType];
    this.checkImplementedMembers(cls, declaration, obligations, false);
    this.checkImplementedMembers(cls, declaration, obligations, true);
  }

  private checkImplementedMembers(
    cls: ClassInfo,
    declaration: ClassDeclaration,
    obligations: InterfaceType[],
    setter: boolean
  ): void {
    for (const name of cls.interfaceMemberNames(setter)) {
      const declared = cls.interfaceMember(name, setter);
      const shown = sourceMemberName(name) + (setter ? '=' : '');
      if (!declared) {
        this.error(declaration, `${cls.name} には ${shown} の継承したシグネチャが複数あり、型が一致しません。`);
      }
      const implementation = setter ? cls.setterImplementation(name) : cls.implementation(name);
      if (implementation && obligations.length > 0)
        this.checkOverride(cls, implementation, setter, declaration, obligations);
      if (!implementation && !cls.isAbstract && !cls.forwardingDeclaration(name, setter))
        this.error(declaration, `${cls.name} には、${declared.owner.name}.${shown} の実装がありません。`);
    }
  }

  private implementationObligations(cls: ClassInfo): InterfaceType[] {
    const obligations = [...cls.interfaces];
    for (const base of cls.superclassChain()) {
      if (!base.mixinOf) continue;
      const instantiated = asInstanceOf(cls.thisType, base.mixinOf);
      if (instantiated) obligations.push(instantiated);
    }
    return obligations;
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Each branch is one of the cases Dart distinguishes for this construct.
  private checkOverride(
    cls: ClassInfo,
    member: Member,
    setter: boolean,
    span?: Span,
    targets = cls.directSupertypes
  ): void {
    if (member.isStatic) return;
    const row = span?.row ?? member.row ?? 0;
    const own = memberTypeIn(cls.thisType, member);
    const library = (member.owner.mixinOf ?? member.owner).library;
    for (const supertype of targets) {
      const inherited = this.interfaceMember(supertype, member.name, setter, library);
      if (!inherited || inherited.member === member) continue;
      if (setter) {
        this.checkSetterOverride(cls, member, inherited.type, own, row);
        continue;
      }
      if (member.kind === 'method') {
        if (inherited.member.kind !== 'method') {
          this.error(
            { row },
            `${cls.name}.${member.name} はメソッドなので、getter やフィールドの ${inherited.member.owner.name}.${member.name} を上書きできません。`
          );
        }
        if (!this.isValidOverride(cls, member, own as FunctionType, inherited.member, inherited.type as FunctionType)) {
          this.error(
            { row },
            `${cls.name}.${member.name}（${typeToString(own)}）は、${inherited.member.owner.name}.${member.name}（${typeToString(inherited.type)}）の正しい上書きではありません。`
          );
        }
        continue;
      }
      if (inherited.member.kind === 'method') {
        this.error(
          { row },
          `${cls.name}.${member.name} は getter かフィールドなので、メソッドの ${inherited.member.owner.name}.${member.name} を上書きできません。`
        );
      }
      if (!isSubtype(own, inherited.type)) {
        this.error(
          { row },
          `${cls.name}.${member.name} の型 ${typeName(own)} は、${inherited.member.owner.name}.${member.name} の型 ${typeName(inherited.type)} に合いません。`
        );
      }
    }
  }

  private checkSetterOverride(cls: ClassInfo, member: Member, inherited: DartType, own: DartType, row: number): void {
    const declaration = (member.owner.mixinOf ?? member.owner).declaration?.members.find(
      (candidate): candidate is MethodDeclaration =>
        candidate.kind === 'method' && candidate.methodKind === 'setter' && candidate.name === member.name
    );
    const covariant =
      (member.kind === 'field' && member.isCovariant) ||
      declaration?.parameters.positional[0]?.isCovariant ||
      inheritsCovariance(member.owner, member.name, '', 0, true);
    if (covariant && member.kind === 'field' && member.owner === cls) member.isCovariant = true;
    if (isSubtype(inherited, own) || (covariant && isSubtype(own, inherited))) return;
    this.error(
      { row },
      `${cls.name}.${member.name} の setter の型 ${typeName(own)} は、継承した型 ${typeName(inherited)} に合いません。`
    );
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- The relaxed comparison and the forwarding contract use the same parameter checks.
  private isValidOverride(
    cls: ClassInfo,
    member: MethodMember,
    own: FunctionType,
    obligation: MethodMember,
    inherited: FunctionType
  ): boolean {
    if (isSubtype(own, inherited)) return true;
    const { owner, name } = member;
    const declaration = (owner.mixinOf ?? owner).declaration?.members.find(
      (candidate): candidate is MethodDeclaration =>
        candidate.kind === 'method' && candidate.name === name && candidate.methodKind !== 'setter'
    );
    const added = new Set<number>();
    const relax = (
      type: DartType,
      other: DartType | undefined,
      parameter: FormalParameter | undefined,
      index?: number
    ): DartType => {
      if (other && isSubtype(type, other)) {
        if (parameter?.isCovariant || inheritsCovariance(owner, name, parameter?.name ?? '', index)) return other;
        if (index !== undefined && owner !== cls && inheritsCovariance(cls, name, '', index)) {
          added.add(index);
          return other;
        }
      }
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
    if (!isSubtype(relaxed, inherited)) return false;
    if (added.size > 0) {
      if (!isSubtype(inherited, relaxed)) return false;
      const existing = cls.inheritedCovariance.get(member);
      cls.inheritedCovariance.set(member, {
        obligation: existing?.obligation ?? obligation,
        positions: new Set([...(existing?.positions ?? []), ...added]),
      });
    }
    return true;
  }

  // Extensions

  // code-gauge-allow functionCognitiveComplexity 23 -- Each branch is one of the cases Dart distinguishes for this construct.
  private declareExtension(ext: ExtensionInfo, declaration: ExtensionDeclaration): void {
    ext.typeParams.push(
      ...this.withoutFunctionTypeAnnotations(() => this.declareTypeParams(declaration.typeParameters))
    );
    this.withTypeParams(ext.typeParams, () => {
      ext.onType = this.resolveTypeWithoutAnnotations(declaration.onType);
      const holder = new ClassInfo(ext.name ?? 'extension', 'class', this.library.name);
      holder.typeParams.push(...ext.typeParams);
      ext.staticMembers = holder.staticMembers;
      ext.staticSetters = holder.staticSetters;
      this.inDeclarationScope(undefined, ext, () => {
        for (const member of declaration.members) {
          if (member.kind === 'constructor') this.error(member, '拡張にはコンストラクタを書けません。');
          if (member.kind === 'field' && !member.isStatic)
            this.error(member, '拡張には、インスタンスのフィールドを宣言できません。');
          this.declareAccessibleMember(holder, member, ext);
        }
      });
    });
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
    this.checkCovariantFormals(declaration.parameters);
    const typeParams = this.withoutFunctionTypeAnnotations(() => this.declareTypeParams(declaration.typeParameters));
    const { type } = this.withTypeParams(typeParams, () =>
      this.signatureOf(declaration.parameters, declaration.returnType, typeParams)
    );
    fn.type = declaration.functionKind === 'setter' && !declaration.returnType ? { ...type, returnType: VOID } : type;
    if (declaration.functionKind === 'setter')
      this.checkSetterSignature(declaration.parameters, fn.type.returnType, declaration);
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
      if (!variable.initializer && !declaration.isLate && declaration.isFinal) {
        this.error(variable, `final の ${variable.name} には初期値が必要です。`);
      } else if (!variable.initializer && !declaration.isLate && !isNullable(type) && type.kind !== 'dynamic') {
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
      if (!declaredType)
        this.inferTypeOnFirstUse(global, initializer, () => this.inferInitializerType(initializer, true, undefined));
      initializers.push(() => {
        void global.type;
        this.compileGlobalInitializer(global, initializer, declaration.isConst, undefined);
      });
    }
    return initializers;
  }

  private inferTypeOnFirstUse(global: GlobalVariable, initializer: Span, infer: () => DartType): void {
    Object.defineProperty(global, 'type', {
      get: this.memoizeTypeInference(global.name, initializer, () => this.inGlobalTypeScope(global, infer)),
    });
  }

  private inGlobalTypeScope<T>(global: GlobalVariable, run: () => T): T {
    return this.inDeclarationScope(global.owner, undefined, () =>
      this.withIsolatedTypes(() => this.withTypeParams(global.owner?.typeParams ?? [], run, true))
    );
  }

  // Runtime glue the expression compilers call

  readGlobal(global: GlobalVariable): Eval {
    const { slot } = global;
    return (frame) => readGlobalValue(frame.runtime, this.globals[slot] ?? global);
  }

  tearOffFunction(fn: TopLevelFunction): Eval {
    return (frame) => topLevelFunctionClosure(frame.runtime, fn);
  }

  constructSymbol(frame: Frame, name: string): Value {
    return frame.runtime.symbol(name, name.startsWith('_') ? this.library.name : undefined);
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

  makeSyncStarIterable(frame: Frame, elementType: DartType, body: GenExec): Value {
    return frame.runtime.links.syncStarIterable(frame, elementType, body);
  }

  protected native(key: string, kind: 'method' | 'getter' | 'setter' = 'method'): Callable | ConstructorImpl {
    if (!this.isLibraryCode) return missingExternal(key, kind);
    const found = this.natives.get(key);
    if (found) return found;
    // A library member without a native fails only when a program calls it.
    return () => {
      throw new Error(`The interpreter has no native for ${key}`);
    };
  }
}

export function topLevelFunctionClosure(runtime: Runtime, fn: TopLevelFunction): DartClosure {
  const { tearOffs } = runtime;
  const existing = tearOffs.get(fn);
  if (existing) return existing;
  const closure = new DartClosure(
    coreTypes.function,
    eraseFunctionType(fn.type),
    (callingRuntime, _receiver, args, typeArgs, callRow) =>
      (fn.impl as Callable)(callingRuntime, undefined, args, typeArgs, callRow),
    undefined,
    [],
    { name: fn.name, origin: `Function '${fn.name}': static.` },
    fn
  );
  tearOffs.set(fn, closure);
  return closure;
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
  return (runtime, _receiver, args, typeArgs) => runtime.throwMissingExternal(owner, name, kind, args, typeArgs);
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
  if (cell.v !== UNINITIALIZED) return cell.v;
  const { initialize, name } = global;
  if (!initialize) runtime.throwError('LateError', '', [`Field '${name}' has not been initialized.`]);
  return initializeField(
    runtime,
    name,
    global.isFinal,
    () => initialize(runtime),
    () => cell.v,
    (computed) => {
      cell.v = computed;
    }
  );
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

function needsImplicitConstructor(cls: ClassInfo): boolean {
  if (cls.constructors.size === 0) return true;
  return (
    cls.kind === 'enum' &&
    !cls.constructors.has('') &&
    [...cls.constructors.values()].every((constructor) => constructor.kind !== 'generative')
  );
}

/** Records a class among the subclasses of the sealed classes it extends or implements, for exhaustiveness. */
function registerSealedSubclass(cls: ClassInfo): void {
  for (const supertype of cls.directSupertypes) {
    const supercls = supertype.cls;
    if (supercls.modifiers.isSealed && supercls.library === cls.library) supercls.subclasses.push(cls);
  }
  if (!cls.superclass?.cls.mixinOf) return;
  let current: ClassInfo | undefined = cls.superclass.cls;
  while (current?.mixinOf && !current.declaration) current = current.superclass?.cls;
  if (current?.modifiers.isSealed && current.library === cls.library && !current.subclasses.includes(cls))
    current.subclasses.push(cls);
}
