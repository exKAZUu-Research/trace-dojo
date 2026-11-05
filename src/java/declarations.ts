import type {
  ClassDeclaration,
  CompilationUnit,
  ConstructorDeclaration,
  FieldDeclaration,
  MethodDeclaration,
  Modifiers,
  TypeSyntax,
} from './ast';
import { sameParameters, superclassesOf } from './compilerBase';
import { findImplementation, throwBuiltin } from './runtime';
import { StatementCompiler } from './statementCompiler';
import {
  asSuper,
  bindingsOf,
  type ClassInfo,
  type ClassType,
  createClass,
  erasure,
  type FieldInfo,
  INT,
  isReference,
  isWidening,
  type JavaType,
  type MethodInfo,
  sameType,
  substitute,
  superinterfacesOf,
  thisTypeOf,
  VOID,
} from './types';
import { JavaArray, JavaObject, JavaString } from './values';

const KIND_NAMES = { class: 'クラス', interface: 'インターフェース', enum: '列挙型' } as const;

/** Declares the classes of a program and their members, checking how they inherit from each other. */
export abstract class DeclarationCompiler extends StatementCompiler {
  /** Every declared class, interface, and enum in textual order, nested ones after their enclosing class. */
  protected readonly declaredClasses: ClassInfo[] = [];

  protected registerClasses(unit: CompilationUnit): void {
    for (const declaration of unit.classes) this.registerClass(declaration, undefined);
  }

  protected registerClass(declaration: ClassDeclaration, enclosing: ClassInfo | undefined): void {
    const { name, kind, modifiers } = declaration;
    const siblings = enclosing ? enclosing.memberTypes : this.classes;
    if (siblings.has(name) || (!enclosing && this.builtins.classes.has(name))) {
      this.error(declaration, `${KIND_NAMES[kind]} ${name} はすでに定義されています。`);
    }
    for (let outer = enclosing; outer; outer = outer.enclosing) {
      if (outer.name === name)
        this.error(declaration, `入れ子のクラスには、外側のクラスと同じ名前 ${name} を付けられません。`);
    }
    // Member interfaces and enums are implicitly static, as is every member of an interface.
    const isStatic = modifiers.isStatic || kind !== 'class' || enclosing?.kind === 'interface';
    if (enclosing && !isStatic) {
      this.error(
        declaration,
        `static でない入れ子のクラス ${name} は、この採点環境では使えません。static を付けてください。`
      );
    }
    if (!enclosing && modifiers.isStatic)
      this.error(declaration, `トップレベルの${KIND_NAMES[kind]}に static は付けられません。`);
    if (kind === 'interface' && modifiers.isFinal)
      this.error(declaration, 'インターフェースに final は付けられません。');
    if (modifiers.isAbstract && modifiers.isFinal)
      this.error(declaration, `クラス ${name} に abstract と final を両方付けることはできません。`);
    if (kind === 'enum' && modifiers.isAbstract) this.error(declaration, '列挙型に abstract は付けられません。');
    const cls = createClass(name, undefined, false);
    cls.kind = kind;
    cls.declaration = declaration;
    cls.enclosing = enclosing;
    cls.binaryName = enclosing ? `${enclosing.binaryName}$${name}` : name;
    cls.isAbstract = modifiers.isAbstract || kind === 'interface';
    cls.isFinal = modifiers.isFinal || kind === 'enum';
    siblings.set(name, cls);
    this.declaredClasses.push(cls);
    for (const member of declaration.members) {
      if (member.kind === 'class' || member.kind === 'interface' || member.kind === 'enum')
        this.registerClass(member, cls);
    }
  }

  /** Resolves each class's supertypes, ordering the classes so that supertypes come first. */
  protected orderBySupertypes(): ClassInfo[] {
    const ordered: ClassInfo[] = [];
    const visiting = new Set<ClassInfo>();
    const visit = (cls: ClassInfo): void => {
      if (ordered.includes(cls)) return;
      const declaration = cls.declaration as ClassDeclaration;
      if (visiting.has(cls)) this.error(declaration, `${KIND_NAMES[cls.kind]} ${cls.name} の継承が循環しています。`);
      visiting.add(cls);
      // A class's extends and implements clauses name types as its enclosing class's body does, with its type
      // parameters in scope.
      this.withTypeScope(cls.enclosing, () => {
        cls.typeParameters = this.declareTypeParameters(declaration.typeParameters);
        this.withTypeVariables(cls.typeParameters, () => {
          const superclass = this.resolveSuperclass(cls, declaration);
          const interfaces: ClassType[] = [];
          for (const syntax of declaration.interfaces) interfaces.push(this.resolveInterface(cls, syntax, interfaces));
          for (const supertype of [superclass, ...interfaces]) {
            if (supertype && !supertype.cls.isBuiltin) visit(supertype.cls);
          }
          cls.superclass = superclass?.cls;
          cls.interfaces = interfaces.map((type) => type.cls);
          cls.supertypes = superclass ? [superclass, ...interfaces] : interfaces;
        });
      });
      visiting.delete(cls);
      ordered.push(cls);
    };
    for (const cls of this.declaredClasses) visit(cls);
    return ordered;
  }

  protected resolveSuperclass(cls: ClassInfo, declaration: ClassDeclaration): ClassType | undefined {
    if (cls.kind === 'interface') return;
    if (cls.kind === 'enum') return this.builtins.enumClass.type as ClassType;
    if (!declaration.superclass) return this.builtins.objectClass.type as ClassType;
    const type = this.resolveType(declaration.superclass);
    if (type.kind !== 'class') return this.error(declaration.superclass, 'クラス以外は継承できません。');
    const superclass = type.cls;
    if (superclass.kind === 'interface') {
      this.error(
        declaration.superclass,
        `インターフェース ${superclass.name} は extends ではなく implements で指定してください。`
      );
    }
    const isUninheritable =
      superclass.kind === 'enum' ||
      superclass === this.builtins.enumClass ||
      superclass.isFinal ||
      (superclass.isBuiltin && superclass.constructors.length === 0);
    if (isUninheritable) this.error(declaration.superclass, `クラス ${superclass.name} は継承できません。`);
    return type;
  }

  protected resolveInterface(cls: ClassInfo, syntax: TypeSyntax, earlier: readonly ClassType[]): ClassType {
    const type = this.resolveType(syntax);
    if (type.kind !== 'class' || type.cls.kind !== 'interface') {
      const name = type.kind === 'class' ? type.cls.name : 'この型';
      return this.error(
        syntax,
        cls.kind === 'interface'
          ? `インターフェースが継承できるのはインターフェースだけですが、${name} はインターフェースではありません。`
          : `${name} はインターフェースではないので、implements で指定できません。`
      );
    }
    if (earlier.some((other) => other.cls === type.cls)) {
      this.error(syntax, `インターフェース ${type.cls.name} が重複しています。`);
    }
    return type;
  }

  protected declareMembers(cls: ClassInfo): void {
    // Supertypes come first, so their instance fields are final by now.
    const superclass = cls.superclass;
    cls.instanceFieldCount = superclass?.instanceFieldCount ?? 0;
    cls.instanceFields = [...(superclass?.instanceFields ?? [])];
    const declaration = cls.declaration as ClassDeclaration;
    if (cls.kind === 'enum') this.declareEnumConstants(cls, declaration);
    for (const member of declaration.members) {
      if (member.kind === 'field') this.declareField(cls, member);
      else if (member.kind === 'method') this.declareMethod(cls, member);
      else if (member.kind === 'constructor') this.declareConstructor(cls, member);
      else if (member.kind === 'initializer' && cls.kind === 'interface') {
        this.error(member, 'インターフェースには初期化ブロックを書けません。');
      }
    }
    if (cls.constructors.length === 0 && cls.kind !== 'interface') {
      cls.constructors.push({
        name: cls.name,
        owner: cls,
        parameterTypes: [],
        returnType: VOID,
        isStatic: false,
        isAbstract: false,
        isConstructor: true,
        access: cls.kind === 'enum' ? 'private' : declaration.modifiers.access,
        thrownTypes: [],
      });
    }
  }

  /** Declares an enum's constants as its first static fields, with the methods every enum has. */
  protected declareEnumConstants(cls: ClassInfo, declaration: ClassDeclaration): void {
    const constants: FieldInfo[] = [];
    for (const constant of declaration.enumConstants) {
      if (cls.fields.has(constant.name)) this.error(constant, `列挙定数 ${constant.name} はすでに定義されています。`);
      const field: FieldInfo = {
        name: constant.name,
        owner: cls,
        type: cls.type,
        isStatic: true,
        isFinal: true,
        access: 'public',
        slot: cls.staticFieldCount++,
        enumConstant: constant,
      };
      cls.fields.set(constant.name, field);
      cls.staticFields.push(field);
      constants.push(field);
    }
    const arrayType = { kind: 'array', element: cls.type } as const;
    const stringType = this.builtins.stringClass.type;
    const addNative = (
      name: string,
      parameterTypes: MethodInfo['parameterTypes'],
      returnType: MethodInfo['returnType'],
      isStatic: boolean,
      native: NonNullable<MethodInfo['native']>
    ): void => {
      cls.methods.push({
        name,
        owner: cls,
        parameterTypes,
        returnType,
        isStatic,
        isAbstract: false,
        isFinal: true,
        isConstructor: false,
        access: 'public',
        thrownTypes: [],
        native,
      });
    };
    addNative('values', [], arrayType, true, (frame) => {
      const statics = frame.runtime.staticsOf(frame, cls);
      frame.runtime.allocateArray(frame, constants.length);
      return new JavaArray(
        cls.type,
        constants.map((field) => statics[field.slot])
      );
    });
    addNative('valueOf', [stringType], cls.type, true, (frame, _, [name]) => {
      if (!(name instanceof JavaString)) return throwBuiltin(frame, 'NullPointerException', 'Name is null');
      const statics = frame.runtime.staticsOf(frame, cls);
      const field = constants.find((constant) => constant.name === name.value);
      if (!field) {
        return throwBuiltin(
          frame,
          'IllegalArgumentException',
          `No enum constant ${cls.binaryName.replaceAll('$', '.')}.${name.value}`
        );
      }
      return statics[field.slot];
    });
    addNative('compareTo', [cls.type], INT, false, (frame, receiver, [other]) => {
      if (!(other instanceof JavaObject)) return throwBuiltin(frame, 'NullPointerException');
      return ((receiver as JavaObject).enumConstant?.ordinal ?? 0) - (other.enumConstant?.ordinal ?? 0);
    });
  }

  protected declareField(cls: ClassInfo, member: FieldDeclaration): void {
    const modifiers = this.memberModifiers(cls, member.modifiers, true);
    const type = this.withInstanceTypeVariables(cls, !modifiers.isStatic, () => this.resolveType(member.type));
    for (const declarator of member.declarators) {
      if (cls.fields.has(declarator.name)) {
        this.error(declarator, `フィールド ${declarator.name} はすでに定義されています。`);
      }
      if (cls.kind === 'interface' && !declarator.initializer) {
        this.error(declarator, `インターフェースのフィールド ${declarator.name} には初期値が必要です。`);
      }
      const field: FieldInfo = {
        name: declarator.name,
        owner: cls,
        type: this.withDimensions(type, declarator.extraDimensions),
        isStatic: modifiers.isStatic,
        isFinal: modifiers.isFinal,
        access: modifiers.access,
        slot: modifiers.isStatic ? cls.staticFieldCount++ : cls.instanceFieldCount++,
        declaration: member,
      };
      cls.fields.set(declarator.name, field);
      if (field.isStatic) cls.staticFields.push(field);
      else cls.instanceFields.push(field);
    }
  }

  /** The modifiers a member has, including those an interface gives its members implicitly. */
  protected memberModifiers(cls: ClassInfo, modifiers: Modifiers, isField: boolean): Modifiers {
    if (cls.kind !== 'interface') return modifiers;
    const access = modifiers.access === 'package' ? 'public' : modifiers.access;
    if (isField) return { ...modifiers, isStatic: true, isFinal: true, access };
    return modifiers.access === 'private' ? modifiers : { ...modifiers, access };
  }

  protected declareMethod(cls: ClassInfo, member: MethodDeclaration): void {
    const modifiers = this.memberModifiers(cls, member.modifiers, false);
    const isAbstract = this.checkMethodModifiers(cls, member, modifiers);
    const method = this.withInstanceTypeVariables(cls, !modifiers.isStatic, (): MethodInfo => {
      const typeParameters = this.declareTypeParameters(member.typeParameters);
      return this.withTypeVariables(typeParameters, () => ({
        name: member.name,
        ...this.declaredSignature(cls, member),
        typeParameters,
        access: modifiers.access,
        returnType: member.returnType ? this.resolveType(member.returnType) : VOID,
        isStatic: modifiers.isStatic,
        isAbstract,
        isFinal: modifiers.isFinal,
        isConstructor: false,
      }));
    });
    if (cls.methods.some((other) => other.name === method.name && sameParameters(other, method))) {
      this.error(member, `メソッド ${member.name} はすでに定義されています。`);
    }
    this.checkOverride(cls, method, member);
    cls.methods.push(method);
  }

  /** Checks the modifiers that decide whether a method has a body, returning whether it is abstract. */
  protected checkMethodModifiers(cls: ClassInfo, member: MethodDeclaration, modifiers: Modifiers): boolean {
    const { name } = member;
    if (modifiers.isDefault && cls.kind !== 'interface')
      this.error(member, 'default メソッドはインターフェースの中にしか書けません。');
    if (cls.kind === 'interface') {
      if (modifiers.access === 'protected')
        this.error(member, 'インターフェースのメソッドに protected は付けられません。');
      if (modifiers.isFinal) this.error(member, 'インターフェースのメソッドに final は付けられません。');
      const hasBodyModifier = modifiers.isDefault || modifiers.isStatic || modifiers.access === 'private';
      if (hasBodyModifier && modifiers.isAbstract)
        this.error(member, `メソッド ${name} の修飾子の組み合わせが正しくありません。`);
      if (member.body && !hasBodyModifier) {
        this.error(member, `インターフェースのメソッド ${name} に本体を書くには、default か static を付けてください。`);
      }
      if (!member.body && hasBodyModifier) this.error(member, `メソッド ${name} に本体がありません。`);
      return !member.body;
    }
    const { isAbstract } = modifiers;
    if (isAbstract && !cls.isAbstract) {
      this.error(member, `抽象メソッド ${name} は抽象クラスの中にしか書けません。`);
    }
    if (isAbstract && (modifiers.isStatic || modifiers.isFinal || modifiers.access === 'private')) {
      this.error(member, `抽象メソッド ${name} に static や final や private は付けられません。`);
    }
    if (isAbstract && member.body) this.error(member, `抽象メソッド ${name} には本体を書けません。`);
    if (!isAbstract && !member.body) this.error(member, `メソッド ${name} に本体がありません。`);
    return isAbstract;
  }

  protected declareConstructor(cls: ClassInfo, member: ConstructorDeclaration): void {
    if (member.name !== cls.name) this.error(member, `メソッド ${member.name} に戻り値の型がありません。`);
    if (cls.kind === 'interface') this.error(member, 'インターフェースにはコンストラクタを書けません。');
    let { access } = member.modifiers;
    if (cls.kind === 'enum') {
      if (access === 'public' || access === 'protected') {
        this.error(member, '列挙型のコンストラクタに public や protected は付けられません。');
      }
      if (member.explicitCall?.target === 'super')
        this.error(member.explicitCall, '列挙型のコンストラクタでは super(...) を呼び出せません。');
      access = 'private';
    }
    const constructor: MethodInfo = {
      name: cls.name,
      ...this.withInstanceTypeVariables(cls, true, () => this.declaredSignature(cls, member)),
      access,
      returnType: VOID,
      isStatic: false,
      isAbstract: false,
      isConstructor: true,
    };
    if (cls.constructors.some((other) => sameParameters(other, constructor))) {
      this.error(member, `コンストラクタ ${cls.name} はすでに定義されています。`);
    }
    cls.constructors.push(constructor);
  }

  /** What a method's and a constructor's declarations give alike. */
  protected declaredSignature(
    cls: ClassInfo,
    member: MethodDeclaration | ConstructorDeclaration
  ): Pick<MethodInfo, 'owner' | 'parameterTypes' | 'thrownTypes' | 'declaration' | 'isAtomic'> {
    return {
      owner: cls,
      parameterTypes: member.parameters.map((parameter) => this.resolveType(parameter.type)),
      thrownTypes: member.throwsTypes.map((type) => this.resolveThrowable(type)),
      declaration: member,
      isAtomic: this.claimsAtomicRow(member),
    };
  }

  /** Whether an `// atomic` annotation lies on the declaration's header, from its first row to its body's. */
  protected claimsAtomicRow(member: MethodDeclaration | ConstructorDeclaration): boolean {
    let claims = false;
    for (let row = member.row; row <= (member.body?.row ?? member.endRow); row++) {
      if (!this.atomicRows.has(row)) continue;
      this.usedAtomicRows.add(row);
      claims = true;
    }
    return claims;
  }

  /** Checks a method against those it overrides in its supertypes, recording them in `method.overrides`. */
  protected checkOverride(cls: ClassInfo, method: MethodInfo, declaration: MethodDeclaration): void {
    const ancestors = [...superclassesOf(cls), ...superinterfacesOf(cls)];
    if (cls.kind === 'interface') ancestors.push(this.builtins.objectClass);
    const self = thisTypeOf(cls);
    method.overrides = new Set();
    for (const ancestor of ancestors) {
      // The ancestor's methods as this class sees them, with its type arguments substituted.
      const supertype = asSuper(self, ancestor);
      const bindings = supertype ? bindingsOf(supertype) : new Map();
      for (const overridden of ancestor.methods) {
        if (overridden.name !== method.name || overridden.access === 'private' || overridden.isConstructor) continue;
        const parameterTypes = overridden.parameterTypes.map((type) => substitute(type, bindings));
        const isSubsignature =
          parameterTypes.length === method.parameterTypes.length &&
          (parameterTypes.every((type, index) => sameType(type, method.parameterTypes[index])) ||
            overridden.parameterTypes.every((type, index) => sameType(erasure(type), method.parameterTypes[index])));
        if (!isSubsignature) continue;
        // An interface's static methods belong to the interface alone.
        if (ancestor.kind === 'interface' && overridden.isStatic) continue;
        this.checkOverriding(method, overridden, substitute(overridden.returnType, bindings), ancestor, declaration);
        method.overrides.add(overridden);
        for (const indirect of overridden.overrides ?? []) method.overrides.add(indirect);
      }
    }
  }

  protected checkOverriding(
    method: MethodInfo,
    overridden: MethodInfo,
    overriddenReturnType: JavaType,
    ancestor: ClassInfo,
    declaration: MethodDeclaration
  ): void {
    if (overridden.isStatic !== method.isStatic) {
      this.error(declaration, `メソッド ${method.name} の static の有無が親クラスと異なります。`);
    }
    if (overridden.isFinal) this.error(declaration, `final のメソッド ${method.name} はオーバーライドできません。`);
    const returnsCompatible =
      sameType(overriddenReturnType, method.returnType) ||
      sameType(erasure(overriddenReturnType), method.returnType) ||
      (isReference(method.returnType) &&
        isWidening(method.returnType, overriddenReturnType, this.builtins.objectClass));
    if (!returnsCompatible) {
      this.error(declaration, `メソッド ${method.name} の戻り値の型が親クラスと異なります。`);
    }
    if (accessRank(method.access) < accessRank(overridden.access)) {
      this.error(
        declaration,
        ancestor.kind === 'interface'
          ? `メソッド ${method.name} はインターフェース ${ancestor.name} のメソッドをオーバーライドするので、public を付ける必要があります。`
          : `メソッド ${method.name} の公開範囲を親クラスより狭くすることはできません。`
      );
    }
  }

  protected checkAbstractMethods(cls: ClassInfo): void {
    if (cls.isAbstract) return;
    for (const ancestor of [cls, ...superclassesOf(cls), ...superinterfacesOf(cls)]) {
      for (const method of ancestor.methods) {
        if (!method.isAbstract) continue;
        if (this.findImplementation(cls, method).isAbstract) {
          this.error(
            cls.declaration as ClassDeclaration,
            `${KIND_NAMES[cls.kind]} ${cls.name} は抽象メソッド ${method.name} を実装していません。`
          );
        }
      }
    }
  }

  protected findImplementation(cls: ClassInfo, method: MethodInfo): MethodInfo {
    return findImplementation(cls, method);
  }

  /** Runs `compile` with `cls`'s type parameters in scope when the code belongs to its instances. */
  protected withInstanceTypeVariables<T>(cls: ClassInfo, isInstance: boolean, compile: () => T): T {
    return this.withTypeVariables(isInstance ? cls.typeParameters : [], compile);
  }
}

export function accessRank(access: string): number {
  return { private: 0, package: 1, protected: 2, public: 3 }[access] ?? 0;
}
