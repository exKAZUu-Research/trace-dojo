import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { checkDuplicateMembers, checkOverloadOptionality, memberName } from './declarations';
import { FlowState, propertyReferenceKey, type State } from './flow';
import { checkIndexConformance } from './indexConformance';
import { hasToken, isClassConstructor, isWithin, named } from './syntax';
import {
  anyType,
  type ClassInfo,
  errorType,
  isAnyLike,
  isIntrinsic,
  type Property,
  propertyAccessType,
  type Signature,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** Checks class declarations: their members, constructors, and the types they implement and extend. */
export class ClassDeclarationChecker {
  private readonly checked = new Set<number>();
  /** The fields without initializers that their class's constructor assigns on every path. */
  private readonly constructorAssignedFields = new Set<number>();

  constructor(private readonly c: Checker) {}

  checkClass(node: TreeNode): void {
    if (this.c.silent > 0 || this.checked.has(node.id)) return;
    this.checked.add(node.id);
    const info = this.c.classes.classInfoOfNode(node);
    const clause = this.c.classes.extendsClause(node);
    const baseValue = clause?.childForFieldName('value');
    if (baseValue) this.checkBaseValue(node, baseValue);
    const body = node.childForFieldName('body');
    const members = body ? named(body) : [];
    if (body) {
      checkDuplicateMembers(this.c, body);
      checkOverloadOptionality(this.c, body);
    }
    this.resolveMemberTypes(node, info);
    const ctor = this.c.classes.constructorNode(node);
    for (const member of members) this.checkMember(node, member, info, ctor);
    this.checkMethodOverloads(node, members, info);
    if (!ctor) this.checkPropertyInitialization(node, undefined, new FlowState(), []);
    else if (clause) this.checkSuperCallPresence(node, ctor);
    this.checkImplements(node, info);
    this.checkIndexes(node, info);
    this.checkAbstractMembers(node, info);
    this.checkBaseCompatibility(node, info);
    this.checkStaticCompatibility(node, info);
  }

  private checkIndexes(node: TreeNode, info: ClassInfo): void {
    const body = node.childForFieldName('body');
    for (const isStatic of [false, true]) {
      const base = isStatic ? this.c.classes.baseStaticType(node) : this.c.classes.baseInstanceType(node);
      const type = isStatic ? info.staticType : info.instanceType;
      checkIndexConformance(this.c, type.resolve(), {
        bodies: body ? [body] : [],
        name: node.childForFieldName('name') ?? undefined,
        bases: base ? [base] : [],
        isStatic,
      });
    }
  }

  /** Resolves the types written in the class, so that they report the names they cannot find. */
  private resolveMemberTypes(node: TreeNode, info: ClassInfo): void {
    this.c.signatures.typeParametersOf(node);
    const instance = info.instanceType.resolve();
    info.staticType.resolve();
    for (const property of instance.properties.values()) {
      if (property.declaringClass === info) property.type();
    }
  }

  private checkBaseValue(node: TreeNode, baseValue: TreeNode): void {
    const baseType = this.c.expressions.check(baseValue);
    if (isAnyLike(baseType) || baseType === errorType || isIntrinsic(baseType, 'null')) return;
    if (this.c.signaturesOf(baseType, 'construct').length === 0) {
      this.c.error(baseValue, `型 '${this.c.print(baseType)}' はコンストラクタの型ではありません。`);
      return;
    }
    this.checkBaseTypeArguments(node, baseValue, baseType);
    const restricted = this.c.classes.restrictedConstructor(baseType);
    const baseInfo = baseType.kind === 'object' ? baseType.classInfo : undefined;
    // A class may extend a class with a private constructor only inside the class it extends.
    if (restricted?.visibility === 'private' && baseInfo && !isWithin(baseValue, baseInfo.declaration)) {
      this.c.error(
        baseValue,
        `クラス '${baseInfo.name}' は継承できません。クラスのコンストラクタが private になっています。`
      );
    }
  }

  /** Reports type arguments in the `extends` clause that no construct signature of the base takes. */
  private checkBaseTypeArguments(node: TreeNode, baseValue: TreeNode, baseType: Type): void {
    const typeArguments = this.c.classes.baseTypeArguments(node);
    const baseInfo = baseType.kind === 'object' ? baseType.classInfo : undefined;
    if (!baseInfo) {
      if (this.c.classes.baseConstructSignatures(node)?.length === 0)
        this.c.error(baseValue, '基底のコンストラクタには、指定した数の型引数をとるものがありません。');
      return;
    }
    const parameters = baseInfo.instanceType.typeParameters ?? [];
    const required = parameters.filter((parameter) => !parameter.default).length;
    if (parameters.length === 0) {
      if (typeArguments.length > 0) this.c.error(baseValue, `型 ${baseInfo.name} は型引数をとりません。`);
    } else if (typeArguments.length < required || typeArguments.length > parameters.length) {
      this.c.error(
        baseValue,
        required === parameters.length
          ? `ジェネリック型 ${baseInfo.name} には型引数が ${required} 個必要です。`
          : `ジェネリック型 ${baseInfo.name} には型引数が ${required} 個から ${parameters.length} 個必要です。`
      );
    } else {
      const argumentsNode = this.c.classes.extendsClause(node)?.childForFieldName('type_arguments') ?? baseValue;
      const filled = this.c.fillTypeArguments(parameters, typeArguments);
      this.c.typeNodes.checkTypeArgumentConstraints(argumentsNode, parameters, filled);
    }
  }

  /** Reports a derived class's constructor that lacks a `super` call, or that has one although the class extends `null`. */
  private checkSuperCallPresence(node: TreeNode, ctor: TreeNode): void {
    const superCall = this.firstSuperCallAnywhere(ctor);
    if (this.c.classes.extendsNull(node)) {
      if (superCall)
        this.c.error(
          superCall,
          "クラスが 'null' を継承しているとき、コンストラクタには 'super' の呼び出しを書けません。"
        );
    } else if (!superCall) {
      this.c.error(
        ctor.childForFieldName('name') ?? ctor,
        "派生クラスのコンストラクタには 'super' の呼び出しが必要です。"
      );
    }
  }

  private firstSuperCallAnywhere(ctor: TreeNode): TreeNode | undefined {
    let found: TreeNode | undefined;
    const visit = (current: TreeNode): void => {
      if (found) return;
      if (current.type === 'call_expression' && current.childForFieldName('function')?.type === 'super') {
        found = current;
        return;
      }
      if (
        ['function_declaration', 'function_expression', 'arrow_function', 'class', 'method_definition'].includes(
          current.type
        ) &&
        current.id !== ctor.id
      )
        return;
      for (const child of named(current)) visit(child);
    };
    visit(ctor);
    return found;
  }

  private checkMember(classNode: TreeNode, member: TreeNode, info: ClassInfo, ctor: TreeNode | undefined): void {
    this.checkMemberDeclaration(member, info);
    const isStatic = hasToken(member, 'static');
    switch (member.type) {
      case 'field_definition': {
        this.checkFieldInitializer(member, info, isStatic);
        break;
      }
      case 'method_signature': {
        this.c.functions.checkOverloadImplementation(member);
        break;
      }
      case 'method_definition': {
        const signature = this.c.signatures.signatureOf(member);
        this.c.functions.checkFunctionLike(member, signature, undefined);
        const returnType = member.childForFieldName('return_type');
        if (member.id === ctor?.id && returnType)
          this.c.error(returnType, 'コンストラクタには戻り値の型を書けません。');
        break;
      }
      case 'class_static_block': {
        // A static block runs as the class is defined, so the flow there continues into it and out of it.
        const body = member.childForFieldName('body');
        this.c.statements.declareHoistedVariables(this.c.ownScope(member));
        if (body) this.c.statements.checkBlockStatements(named(body));
        break;
      }
      default: {
        break;
      }
    }
  }

  private checkMethodOverloads(node: TreeNode, members: TreeNode[], info: ClassInfo): void {
    const merged = this.c.typeNodes.interfaceOwnMembers(this.c.classes.mergedInterfaces(node)).properties;
    const instance = this.c.classes.membersOf(node, info, false).properties;
    const statics = this.c.classes.membersOf(node, info, true).properties;
    const methodSignatures = (property: Property | undefined): Signature[] =>
      property?.isMethod ? this.c.signaturesOf(property.type(), 'call') : [];
    for (const member of members) {
      if (
        member.type !== 'method_definition' ||
        isClassConstructor(member) ||
        hasToken(member, 'get') ||
        hasToken(member, 'set')
      )
        continue;
      const name = memberName(this.c, member);
      if (name === undefined) continue;
      const overloads = hasToken(member, 'static')
        ? methodSignatures(statics.get(name))
        : [...methodSignatures(instance.get(name)), ...methodSignatures(merged.get(name))];
      const ordered = overloads.toSorted(
        (left, right) => (left.declaration?.startIndex ?? 0) - (right.declaration?.startIndex ?? 0)
      );
      this.c.functions.checkOverloadCompatibility(this.c.signatures.signatureOf(member), ordered, member);
    }
  }

  private checkFieldInitializer(member: TreeNode, info: ClassInfo, isStatic: boolean): void {
    const value = member.childForFieldName('value');
    const declared = this.c.typeNodes.annotationType(member.childForFieldName('type'));
    const annotation = declared && hasToken(member, '?') ? unionOf([declared, undefinedType]) : declared;
    if (value) {
      if (hasToken(member, 'abstract'))
        this.c.error(
          member.childForFieldName('name') ?? member,
          'abstract プロパティに初期値を指定することはできません。'
        );
      const valueType = this.c.classes.withThis(isStatic ? info.staticType : info.instanceType, () =>
        this.c.flow.from(new FlowState(), () => {
          this.c.functions.contexts.push({
            node: member,
            returnTypes: [],
            endReachable: false,
            isConstructor: false,
            hasReturnWithValue: false,
            hasReturnWithoutValue: false,
            returnStates: [],
          });
          this.c.functions.capturedTypes.push(new Map());
          try {
            const type = this.c.expressions.check(value, annotation);
            if (annotation)
              this.c.expressions.checkAssignable(member.childForFieldName('name') ?? value, type, annotation, value);
          } finally {
            this.c.functions.capturedTypes.pop();
            this.c.functions.contexts.pop();
          }
        })
      );
      void valueType;
    }
  }

  private checkMemberDeclaration(member: TreeNode, info: ClassInfo): void {
    const name = member.childForFieldName('name');
    if (name?.type === 'computed_property_name') this.c.expressions.checkComputedPropertyName(name);
    if (hasToken(member, 'abstract') && !info.isAbstract)
      this.c.error(name ?? member, '抽象メンバーは抽象クラスの中でのみ宣言できます。');
    if (isClassConstructor(member) && hasToken(member, 'static'))
      this.c.error(member, "'static' 修飾子はコンストラクタの宣言には付けられません。");
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- Reports an incompatible member at itself and a missing one at the class, as TypeScript does.
  private checkImplements(node: TreeNode, info: ClassInfo): void {
    const heritage = node.namedChildren.find((child) => child?.type === 'class_heritage');
    const clause = heritage?.namedChildren.find((child) => child?.type === 'implements_clause');
    if (!clause) return;
    for (const typeNode of named(clause)) {
      const target = this.validImplementedType(typeNode);
      if (!target || isAnyLike(target) || this.c.relations.isAssignable(info.instanceType, target)) continue;
      if (!this.reportIncompatibleMembers(info, target)) {
        const missing =
          target.kind === 'object'
            ? [...target.resolve().properties.values()].filter(
                (property) => !property.optional && !this.c.propertyOf(info.instanceType, property.name)
              )
            : [];
        const detail =
          missing.length > 0
            ? `プロパティ ${missing.map((property) => `'${property.name}'`).join(', ')} がありません。`
            : '';
        this.c.error(
          node.childForFieldName('name') ?? node,
          `クラス '${info.name}' は、インターフェース '${this.c.print(target)}' を正しく実装していません。${detail}`
        );
      }
    }
  }

  /** The type an `implements` clause names, unless it is an error or a type a class cannot implement, which is reported. */
  private validImplementedType(typeNode: TreeNode): Type | undefined {
    // tsc resolves the name of a heritage clause as an entity name, where a type keyword such as `any` names nothing.
    if (typeNode.type === 'predefined_type') {
      this.c.error(typeNode, `クラスはプリミティブ型 '${typeNode.text}' を実装できません。`);
      return undefined;
    }
    const target = this.c.typeNodes.typeFromNode(typeNode);
    if (target === errorType) return undefined;
    if (this.c.typeNodes.interfaceBases.isValidBaseType(target)) return target;
    this.c.error(typeNode, 'クラスが実装できるのは、メンバーが静的に決まるオブジェクト型か、その交差型だけです。');
    return undefined;
  }

  /**
   * Reports, at each member, the members a class declares in its body with types its interface does not allow, where
   * an optional member's type includes `undefined`.
   */
  private reportIncompatibleMembers(info: ClassInfo, target: Type): boolean {
    if (target.kind !== 'object') return false;
    let reported = false;
    for (const property of target.resolve().properties.values()) {
      const own = this.c.propertyOf(info.instanceType, property.name);
      if (!own || own.declaringClass !== info || own.declaration?.parent?.type !== 'class_body') continue;
      if (this.c.relations.isAssignable(propertyAccessType(own), propertyAccessType(property))) continue;
      this.c.error(
        own.declaration?.childForFieldName('name') ?? own.declaration ?? info.declaration,
        `型 '${info.name}' のプロパティ '${property.name}' は、基底の型 '${this.c.print(target)}' の同じプロパティに代入できません。`
      );
      reported = true;
    }
    return reported;
  }

  private checkAbstractMembers(node: TreeNode, info: ClassInfo): void {
    if (info.isAbstract) return;
    const structure = info.instanceType.resolve();
    const missing = [...structure.properties.values()].filter(
      (property) => property.isAbstract && property.declaringClass !== info
    );
    if (missing.length === 0) return;
    const baseType = this.c.classes.baseInstanceType(node);
    const base = baseType ? this.c.print(baseType) : '';
    const nameNode = node.childForFieldName('name') ?? node;
    if (missing.length === 1) {
      this.c.error(
        nameNode,
        `抽象クラスでないクラス '${info.name}' は、クラス '${base}' から継承した抽象メンバー '${missing[0].name}' を実装していません。`
      );
    } else {
      this.c.error(
        nameNode,
        `抽象クラスでないクラス '${info.name}' は、クラス '${base}' から継承した抽象メンバー ${missing.map((property) => `'${property.name}'`).join(', ')} を実装していません。`
      );
    }
  }

  /** Checks each member overriding a base member: its visibility, then its kind, then its type. */
  private checkBaseCompatibility(node: TreeNode, info: ClassInfo): void {
    const base = this.c.classes.baseInstanceType(node);
    if (!base || isAnyLike(base)) return;
    const own = this.c.classes.membersOf(node, info, false);
    for (const [name, property] of own.properties) {
      const baseProperty = this.c.propertyOf(base, name);
      if (!baseProperty || this.reportVisibilityMismatch(node, info, property, baseProperty)) continue;
      const nameNode = memberNameNode(property) ?? node;
      const kindMismatch = this.kindMismatch(info, base, property, baseProperty);
      if (kindMismatch) {
        this.c.error(nameNode, kindMismatch);
        continue;
      }
      const ownType = propertyAccessType(property);
      const baseType = propertyAccessType(baseProperty);
      if (!this.c.relations.isAssignable(ownType, baseType)) {
        this.c.error(
          nameNode,
          `型 '${info.name}' のプロパティ '${name}' は、基底の型の同じプロパティに代入できません。${this.c.expressions.elaboration.typeRelationMessage(ownType, baseType)}`
        );
      } else if (property.optional && !baseProperty.optional) {
        this.c.error(
          node.childForFieldName('name') ?? node,
          `クラス '${info.name}' は、基底クラスを正しく継承していません。プロパティ '${name}' は基底クラスで必須です。`
        );
      }
    }
  }

  /** Reports a member whose visibility differs from its base member's as TypeScript forbids; whether it did. */
  private reportVisibilityMismatch(
    node: TreeNode,
    info: ClassInfo,
    property: Property,
    baseProperty: Property
  ): boolean {
    if (!conflictsInVisibility(property, baseProperty)) return false;
    if (baseProperty.visibility === 'private' || property.visibility === 'private') {
      this.c.error(
        memberNameNode(property) ?? node,
        `クラス '${info.name}' は、基底クラスを正しく継承していません。プロパティ '${property.name}' の可視性が異なります。`
      );
    } else {
      this.c.error(
        node.childForFieldName('name') ?? node,
        `クラス '${info.name}' は、基底クラスを正しく継承していません。プロパティ '${property.name}' の可視性を狭めています。`
      );
    }
    return true;
  }

  /**
   * The error for a member that overrides a base member of another kind, as TypeScript's
   * `checkKindsOfPropertyMemberOverrides` reports: a method may become a field but not an accessor, and a field or an
   * accessor may become neither a method nor the other kind unless the base member is abstract or an interface's.
   */
  private kindMismatch(info: ClassInfo, base: Type, property: Property, baseProperty: Property): string | undefined {
    const { name } = property;
    const kind = memberKind(property);
    const baseKind = memberKind(baseProperty);
    const baseName = this.c.print(base);
    if (baseKind === 'method') {
      return kind === 'accessor'
        ? `クラス '${baseName}' で定義されたインスタンス メンバー関数 '${name}' が、拡張されたクラス '${info.name}' ではインスタンス メンバー アクセサーとして定義されています。`
        : undefined;
    }
    if (kind === 'method') {
      return baseKind === 'accessor'
        ? `クラス '${baseName}' で定義されたインスタンス メンバー アクセサー '${name}' が、拡張されたクラス '${info.name}' ではインスタンス メンバー関数として定義されています。`
        : `基底クラスはメンバー '${name}' をプロパティとして定義していますが、クラス '${info.name}' はメソッドとして定義しています。`;
    }
    if (baseProperty.isAbstract || baseProperty.nameType || isInterfaceMember(baseProperty)) return undefined;
    if (kind !== baseKind) {
      return kind === 'field'
        ? `'${name}' はクラス '${baseName}' でアクセサーとして定義されていますが、ここではインスタンス プロパティとして '${info.name}' でオーバーライドされています。`
        : `'${name}' はクラス '${baseName}' でプロパティとして定義されていますが、ここでは '${info.name}' でアクセサーとしてオーバーライドされています。`;
    }
    return this.overwritesBaseField(property)
      ? `プロパティ '${name}' は、'${baseName}' の基底プロパティを上書きします。これが意図的である場合は初期化子を追加してください。そうでなければ、冗長な宣言を削除してください。`
      : undefined;
  }

  /**
   * Whether a field redeclaring a base field sets it to `undefined`, as a class field defined on each instance does
   * unless an initializer or the constructor assigns it; a `declare` field defines nothing at run time.
   */
  private overwritesBaseField(property: Property): boolean {
    const { declaration } = property;
    if (
      declaration?.type !== 'field_definition' ||
      declaration.childForFieldName('value') ||
      property.isAbstract ||
      hasToken(declaration, 'declare')
    )
      return false;
    return hasToken(declaration, '!') || !this.constructorAssignedFields.has(declaration.id);
  }

  /** Reports static members that do not fit the base class's static members of the same names. */
  private checkStaticCompatibility(node: TreeNode, info: ClassInfo): void {
    const baseStatic = this.c.classes.baseStaticType(node);
    if (!baseStatic || isAnyLike(baseStatic)) return;
    const own = this.c.classes.membersOf(node, info, true);
    for (const [name, property] of own.properties) {
      const baseProperty = name === 'prototype' ? undefined : this.c.propertyOf(baseStatic, name);
      if (!baseProperty) continue;
      const mismatch = this.staticOverrideMismatch(property, baseProperty);
      if (!mismatch) continue;
      this.c.error(
        node.childForFieldName('name') ?? node,
        `クラス '${info.name}' の静的な側は、基底クラスの静的な側を正しく継承していません。プロパティ '${property.name}' ${mismatch}。`
      );
      return;
    }
  }

  private staticOverrideMismatch(property: Property, baseProperty: Property): string | undefined {
    if (conflictsInVisibility(property, baseProperty)) return 'の可視性が異なります';
    if (!this.c.relations.isAssignable(propertyAccessType(property), propertyAccessType(baseProperty)))
      return 'の型が合いません';
    if (property.optional && !baseProperty.optional) return 'は基底クラスで必須です';
  }

  /** Reports the fields a constructor leaves unassigned, which strict property initialization requires. */
  checkPropertyInitialization(
    classNode: TreeNode,
    ctor: TreeNode | undefined,
    endState: State,
    returnStates: State[]
  ): void {
    const body = classNode.childForFieldName('body');
    if (!body) return;
    const ownerId = ctor?.id ?? 0;
    const states = [endState, ...returnStates].filter((state): state is FlowState => state !== undefined);
    const isAssigned = (nameNode: TreeNode): boolean => {
      const names = this.c.silently(() => this.c.patterns.propertyNames(nameNode));
      const key = propertyReferenceKey(`this${ownerId}`, names?.length === 1 ? names[0] : nameNode.text);
      return ctor !== undefined && states.every((state) => state.assignedFields.has(key));
    };
    for (const member of named(body)) {
      const fieldName = member.type === 'field_definition' ? member.childForFieldName('name') : undefined;
      if (fieldName && !member.childForFieldName('value') && isAssigned(fieldName))
        this.constructorAssignedFields.add(member.id);
      const nameNode = this.uninitializedFieldName(member);
      if (nameNode && !isAssigned(nameNode)) {
        this.c.error(
          nameNode,
          `プロパティ ${nameNode.text} には初期値がなく、コンストラクタの中で必ず代入されてもいません。`
        );
      }
    }
  }

  /** The name of a field the constructor must assign: one without initializer whose type lacks `undefined`. */
  private uninitializedFieldName(member: TreeNode): TreeNode | undefined {
    if (member.type !== 'field_definition' || hasToken(member, 'static')) return undefined;
    if (
      member.childForFieldName('value') ||
      hasToken(member, '!') ||
      hasToken(member, '?') ||
      hasToken(member, 'declare') ||
      hasToken(member, 'abstract')
    )
      return undefined;
    const typeNode = member.childForFieldName('type');
    const nameNode = member.childForFieldName('name');
    if (!typeNode || !nameNode) return undefined;
    const type = this.c.typeNodes.annotationType(typeNode) ?? anyType;
    if (isAnyLike(type) || isIntrinsic(type, 'unknown') || this.c.relations.isAssignable(undefinedType, type))
      return undefined;
    return nameNode;
  }
}

/** Whether a member is a method, an accessor, or a field, which a member overriding it must agree with. */
function memberKind(property: Property): 'method' | 'accessor' | 'field' {
  if (property.isMethod) return 'method';
  const declarationType = property.declaration?.type ?? '';
  return ['method_definition', 'method_signature', 'abstract_method_signature'].includes(declarationType)
    ? 'accessor'
    : 'field';
}

/**
 * Whether a member redeclaring a base member conflicts with it in visibility: a private member is compatible only with
 * itself, and a derived member may not narrow a base member's visibility.
 */
function conflictsInVisibility(property: Property, baseProperty: Property): boolean {
  return (
    property.visibility === 'private' ||
    baseProperty.visibility === 'private' ||
    visibilityRank[property.visibility] > visibilityRank[baseProperty.visibility]
  );
}

function isInterfaceMember(property: Property): boolean {
  return property.declaration?.parent?.parent?.type === 'interface_declaration';
}

/** The name a member is declared with, or the parameter that declares a parameter property. */
function memberNameNode(property: Property): TreeNode | undefined {
  const { declaration } = property;
  return declaration?.childForFieldName('name') ?? declaration?.childForFieldName('pattern') ?? undefined;
}

/** How narrowly each visibility exposes a member, which a derived class may not narrow further. */
const visibilityRank = { public: 0, protected: 1, private: 2 } as const;
