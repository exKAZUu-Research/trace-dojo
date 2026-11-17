import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { checkDuplicateMembers } from './declarations';
import { FlowState, propertyReferenceKey, type State } from './flow';
import { hasToken, isClassConstructor, isWithin, named } from './syntax';
import {
  anyType,
  type ClassInfo,
  errorType,
  isAnyLike,
  isIntrinsic,
  type Property,
  type Type,
  undefinedType,
  unionOf,
} from './types';

/** Checks class declarations: their members, constructors, and the types they implement and extend. */
export class ClassDeclarationChecker {
  private readonly checked = new Set<number>();

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
    if (body) checkDuplicateMembers(this.c, body);
    this.resolveMemberTypes(node, info);
    const ctor = this.c.classes.constructorNode(node);
    for (const member of members) this.checkMember(node, member, info, ctor);
    if (!ctor) this.checkPropertyInitialization(node, undefined, new FlowState(), []);
    else if (clause && !this.firstSuperCallAnywhere(ctor)) {
      this.c.error(
        ctor.childForFieldName('name') ?? ctor,
        "派生クラスのコンストラクタには 'super' の呼び出しが必要です。"
      );
    }
    this.checkImplements(node, info);
    this.c.statements.checkIndexConformance(this.c.classes.membersOf(node, info, false));
    this.checkAbstractMembers(node, info);
    this.checkBaseCompatibility(node, info);
    this.checkStaticCompatibility(node, info);
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
    if (isAnyLike(baseType) || baseType === errorType) return;
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

  private firstSuperCallAnywhere(ctor: TreeNode): boolean {
    let found = false;
    const visit = (current: TreeNode): void => {
      if (found) return;
      if (current.type === 'call_expression' && current.childForFieldName('function')?.type === 'super') {
        found = true;
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

  private checkFieldInitializer(member: TreeNode, info: ClassInfo, isStatic: boolean): void {
    const value = member.childForFieldName('value');
    const annotation = this.c.typeNodes.annotationType(member.childForFieldName('type'));
    if (value) {
      const valueType = this.c.classes.withThis(isStatic ? info.staticType : info.instanceType, () =>
        this.c.flow.from(new FlowState(), () => {
          this.c.functions.contexts.push({
            node: member,
            returnTypes: [],
            endReachable: false,
            keepsLiterals: false,
            isConstructor: false,
            hasReturnWithValue: false,
            hasReturn: false,
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
    if (name?.type === 'computed_property_name') this.c.expressions.check(named(name)[0]);
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
      const target = this.c.typeNodes.typeFromNode(typeNode);
      if (target === errorType || isAnyLike(target) || this.c.relations.isAssignable(info.instanceType, target))
        continue;
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
      if (this.c.relations.isAssignable(readType(own), readType(property))) continue;
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
    const base = missing[0].declaringClass?.name ?? '';
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

  // code-gauge-allow functionCognitiveComplexity 19 -- Follows TypeScript's checks of each inherited member: visibility, kind, then type.
  private checkBaseCompatibility(node: TreeNode, info: ClassInfo): void {
    const base = this.c.classes.baseInstanceType(node);
    if (!base || isAnyLike(base)) return;
    const own = this.c.classes.membersOf(node, info, false);
    for (const [name, property] of own.properties) {
      const baseProperty = this.c.propertyOf(base, name);
      if (!baseProperty) continue;
      if (baseProperty.visibility === 'private' || property.visibility === 'private') {
        if (baseProperty.visibility === 'private' || property.visibility !== baseProperty.visibility) {
          this.c.error(
            property.declaration?.childForFieldName('name') ?? node,
            `クラス '${info.name}' は、基底クラスを正しく継承していません。プロパティ '${name}' の可視性が異なります。`
          );
        }
        continue;
      }
      if (visibilityRank[property.visibility] > visibilityRank[baseProperty.visibility]) {
        this.c.error(
          node.childForFieldName('name') ?? node,
          `クラス '${info.name}' は、基底クラスを正しく継承していません。プロパティ '${name}' の可視性を狭めています。`
        );
        continue;
      }
      // A method may become a property, but a property may not become a method.
      if (property.isMethod && !baseProperty.isMethod && !baseProperty.isAbstract) {
        this.c.error(
          property.declaration?.childForFieldName('name') ?? node,
          `基底クラスはメンバー '${name}' をプロパティとして定義していますが、クラス '${info.name}' はメソッドとして定義しています。`
        );
        continue;
      }
      const ownType = property.type();
      const baseType = baseProperty.type();
      if (!this.c.relations.isAssignable(ownType, baseType)) {
        this.c.error(
          property.declaration?.childForFieldName('name') ?? node,
          `型 '${info.name}' のプロパティ '${name}' は、基底の型の同じプロパティに代入できません。型 '${this.c.print(ownType)}' を型 '${this.c.print(baseType)}' に代入することはできません。`
        );
      }
    }
  }

  /** Reports static members that do not fit the base class's static members of the same names. */
  private checkStaticCompatibility(node: TreeNode, info: ClassInfo): void {
    const baseStatic = this.c.classes.baseStaticType(node);
    if (!baseStatic || isAnyLike(baseStatic)) return;
    const own = this.c.classes.membersOf(node, info, true);
    for (const [name, property] of own.properties) {
      const baseProperty = name === 'prototype' ? undefined : this.c.propertyOf(baseStatic, name);
      if (!baseProperty || this.c.relations.isAssignable(property.type(), baseProperty.type())) continue;
      this.c.error(
        node.childForFieldName('name') ?? node,
        `クラス '${info.name}' の静的な側は、基底クラスの静的な側を正しく継承していません。プロパティ '${name}' の型が合いません。`
      );
      return;
    }
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
    for (const member of named(body)) {
      const nameNode = this.uninitializedFieldName(member);
      if (!nameNode) continue;
      const names = this.c.silently(() => this.c.patterns.propertyNames(nameNode));
      const key = propertyReferenceKey(`this${ownerId}`, names?.length === 1 ? names[0] : nameNode.text);
      const assigned = ctor !== undefined && states.every((state) => state.assignedFields.has(key));
      if (!assigned) {
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

function readType(property: Property): Type {
  return property.optional ? unionOf([property.type(), undefinedType]) : property.type();
}

/** How narrowly each visibility exposes a member, which a derived class may not narrow further. */
const visibilityRank = { public: 0, protected: 1, private: 2 } as const;
