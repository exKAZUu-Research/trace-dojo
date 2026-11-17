// code-gauge-allow-file fileNcss 489 -- Holds the types of classes with `this`, `super`, and accessibility, which all read the class information.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { FlowState, type State } from './flow';
import type { Sym } from './scopes';
import { hasToken, named, propertyNameText } from './syntax';
import {
  anonymousObject,
  anyType,
  type ClassInfo,
  emptyStructure,
  errorType,
  isAnyLike,
  isIntrinsic,
  newTypeId,
  type ObjectType,
  type Property,
  type Signature,
  simpleProperty,
  type Structure,
  type Type,
  type TypeParameter,
  undefinedType,
  unionOf,
  voidType,
} from './types';

interface MethodEntry {
  signatures: Signature[];
  implementation?: TreeNode;
  abstract: boolean;
  first: TreeNode;
}

interface AccessorEntry {
  getter?: TreeNode;
  setter?: TreeNode;
}

/** The members of a class body collected so far, as one side, instance or static, declares them. */
interface ClassMembers {
  info: ClassInfo;
  structure: Structure;
  methods: Map<string, MethodEntry>;
  accessors: Map<string, AccessorEntry>;
}

const classTypes = new Set(['class_declaration', 'abstract_class_declaration', 'class']);

/** Classes: their instance and constructor types, `this` and `super`, and the checks of their declarations. */
export class ClassChecker {
  private readonly infos = new Map<number, ClassInfo>();
  private readonly objectThis: ObjectType[] = [];

  constructor(private readonly c: Checker) {}

  classInfoOf(symbol: Sym): ClassInfo {
    const declaration = symbol.typeDeclarations[0] ?? symbol.valueDeclaration;
    return this.classInfoOfNode(declaration as TreeNode);
  }

  classInfoOfNode(node: TreeNode): ClassInfo {
    const cached = this.infos.get(node.id);
    if (cached) return cached;
    const name = node.childForFieldName('name')?.text ?? this.anonymousClassName(node);
    const typeParameters = this.c.signatures.typeParametersOf(node);
    const isAbstract = node.type === 'abstract_class_declaration' || hasToken(node, 'abstract');
    const info = { name, declaration: node, isAbstract } as ClassInfo;
    this.infos.set(node.id, info);
    const instanceType = this.instanceTypeOf(node, info, typeParameters);
    const staticType = this.staticTypeOf(node, info);
    instanceType.thisType = {
      kind: 'typeParameter',
      id: newTypeId(),
      name: 'this',
      isThisType: true,
      constraint: () => instanceType,
    };
    info.instanceType = instanceType;
    info.staticType = staticType;
    return info;
  }

  private instanceTypeOf(node: TreeNode, info: ClassInfo, typeParameters: TypeParameter[]): ObjectType {
    let structure: Structure | undefined;
    const instanceType: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'interface',
      name: info.name,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      classInfo: info,
      resolve: () => {
        if (structure) return structure;
        structure = emptyStructure();
        const own = this.membersOf(node, info, false);
        const base = this.baseInstanceType(node);
        structure = base ? this.mergeBase(own, base, instanceType) : own;
        return structure;
      },
    };
    return instanceType;
  }

  private staticTypeOf(node: TreeNode, info: ClassInfo): ObjectType {
    let structure: Structure | undefined;
    return {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'anonymous',
      name: info.name,
      classInfo: info,
      isClassStatic: true,
      resolve: () => {
        if (structure) return structure;
        structure = emptyStructure();
        const own = this.membersOf(node, info, true);
        own.properties.set('prototype', simpleProperty('prototype', info.instanceType, { readonly: true }));
        own.constructSignatures.push(...this.constructSignatures(node, info));
        const baseStatic = this.baseStaticType(node);
        if (baseStatic) {
          for (const [memberName, property] of this.c.structureOf(baseStatic).properties) {
            if (!own.properties.has(memberName)) own.properties.set(memberName, property);
          }
        }
        structure = own;
        return structure;
      },
    };
  }

  private anonymousClassName(node: TreeNode): string {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator') return parent.childForFieldName('name')?.text ?? '(Anonymous class)';
    return '(Anonymous class)';
  }

  /** The polymorphic `this` type inside the class, which stands for the type of the instance it is used on. */
  selfType(info: ClassInfo): Type {
    return info.instanceType.thisType ?? info.instanceType;
  }

  /** The members of a class with those it inherits, whose `this` type becomes the derived class's. */
  private mergeBase(own: Structure, base: Type, instanceType: ObjectType): Structure {
    if (base.kind !== 'object') return this.c.mergeBases(own, [base]);
    const baseThis = base.thisType ?? base.target?.thisType;
    const inherited =
      baseThis && instanceType.thisType
        ? this.c.instantiateStructure(base.resolve(), new Map([[baseThis.id, instanceType.thisType]]))
        : this.c.structureOf(base);
    const properties = new Map(own.properties);
    for (const [name, property] of inherited.properties) if (!properties.has(name)) properties.set(name, property);
    return {
      ...own,
      properties,
      stringIndex: own.stringIndex ?? inherited.stringIndex,
      numberIndex: own.numberIndex ?? inherited.numberIndex,
    };
  }

  extendsClause(node: TreeNode): TreeNode | undefined {
    const heritage = node.namedChildren.find((child) => child?.type === 'class_heritage');
    return heritage?.namedChildren.find((child) => child?.type === 'extends_clause') ?? undefined;
  }

  baseStaticType(node: TreeNode): Type | undefined {
    const clause = this.extendsClause(node);
    const value = clause?.childForFieldName('value');
    if (!value) return undefined;
    return this.c.silently(() => this.c.expressions.check(value));
  }

  baseInstanceType(node: TreeNode): Type | undefined {
    const clause = this.extendsClause(node);
    const value = clause?.childForFieldName('value');
    if (!clause || !value) return undefined;
    const staticType = this.baseStaticType(node);
    if (!staticType || isAnyLike(staticType)) return staticType && anyType;
    const signatures = this.c.signaturesOf(staticType, 'construct');
    if (signatures.length === 0) return undefined;
    const argumentsNode = clause.childForFieldName('type_arguments');
    const typeArguments = argumentsNode
      ? named(argumentsNode).map((argument) => this.c.typeNodes.typeFromNode(argument))
      : [];
    const returned = signatures[0].returnType();
    if (returned.kind === 'object' && returned.objectKind === 'reference' && returned.target) {
      return this.c.reference(
        returned.target,
        typeArguments.length > 0 ? typeArguments : (returned.target.typeParameters ?? []).map(() => anyType)
      );
    }
    if (returned.kind === 'object' && returned.typeParameters && typeArguments.length > 0)
      return this.c.reference(returned, typeArguments);
    return returned;
  }

  baseClassInfo(info: ClassInfo): ClassInfo | undefined {
    const base = this.baseStaticType(info.declaration);
    return base?.kind === 'object' ? base.classInfo : undefined;
  }

  constructorNode(node: TreeNode): TreeNode | undefined {
    const body = node.childForFieldName('body');
    return body
      ? named(body).find(
          (member) =>
            member.type === 'method_definition' &&
            member.childForFieldName('name')?.text === 'constructor' &&
            member.childForFieldName('body')
        )
      : undefined;
  }

  private constructSignatures(node: TreeNode, info: ClassInfo): Signature[] {
    const typeParameters = info.instanceType.typeParameters ?? [];
    const returnType =
      typeParameters.length > 0 ? this.c.reference(info.instanceType, typeParameters) : info.instanceType;
    const body = node.childForFieldName('body');
    const overloads = body
      ? named(body).filter(
          (member) => member.type === 'method_signature' && member.childForFieldName('name')?.text === 'constructor'
        )
      : [];
    const ctor = this.constructorNode(node);
    const declarations = overloads.length > 0 ? overloads : ctor ? [ctor] : [];
    if (declarations.length > 0) {
      return declarations.map((declaration) => ({
        ...this.c.signatures.signatureOf(declaration),
        typeParameters,
        returnType: () => returnType,
        isAbstract: info.isAbstract,
      }));
    }
    const baseStatic = this.baseStaticType(node);
    if (baseStatic && !isAnyLike(baseStatic)) {
      return this.c.signaturesOf(baseStatic, 'construct').map((signature) => ({
        ...signature,
        typeParameters: [...typeParameters, ...signature.typeParameters],
        returnType: () => returnType,
        isAbstract: info.isAbstract,
      }));
    }
    return [{ typeParameters, parameters: [], returnType: () => returnType, isAbstract: info.isAbstract }];
  }

  membersOf(node: TreeNode, info: ClassInfo, isStatic: boolean): Structure {
    const structure = emptyStructure();
    const body = node.childForFieldName('body');
    if (!body) return structure;
    const members: ClassMembers = { info, structure, methods: new Map(), accessors: new Map() };
    for (const member of named(body)) {
      if (hasToken(member, 'static') === isStatic) this.addMember(members, member);
    }
    for (const [name, entry] of members.methods) structure.properties.set(name, this.methodProperty(name, entry, info));
    for (const [name, accessor] of members.accessors) {
      structure.properties.set(name, this.accessorProperty(name, accessor, info));
    }
    if (!isStatic) {
      const ctor = this.constructorNode(node);
      if (ctor) this.addParameterProperties(ctor, info, structure);
    }
    return structure;
  }

  private addMember(members: ClassMembers, member: TreeNode): void {
    const nameNode = member.childForFieldName('name');
    const name = nameNode ? propertyNameText(nameNode) : undefined;
    switch (member.type) {
      case 'public_field_definition': {
        if (name !== undefined && nameNode)
          members.structure.properties.set(name, this.fieldProperty(name, nameNode, member, members.info));
        break;
      }
      case 'method_definition':
      case 'method_signature':
      case 'abstract_method_signature': {
        if (name !== undefined && name !== 'constructor') this.addMethod(members, name, member);
        break;
      }
      case 'index_signature': {
        this.addIndexSignature(members.structure, member);
        break;
      }
      default: {
        break;
      }
    }
  }

  private fieldProperty(name: string, nameNode: TreeNode, member: TreeNode, info: ClassInfo): Property {
    return {
      name,
      type: () => this.fieldType(member, nameNode),
      optional: hasToken(member, '?'),
      readonly: hasToken(member, 'readonly'),
      isMethod: false,
      visibility: this.visibilityOf(member),
      declaringClass: info,
      isPrivateName: nameNode.type === 'private_property_identifier',
      declaration: member,
      isAbstract: hasToken(member, 'abstract'),
    };
  }

  /** Records a method's signature or implementation, or an accessor, under its name. */
  private addMethod(members: ClassMembers, name: string, member: TreeNode): void {
    if (hasToken(member, 'get') || hasToken(member, 'set')) {
      const entry = members.accessors.get(name) ?? {};
      if (hasToken(member, 'get')) entry.getter = member;
      else entry.setter = member;
      members.accessors.set(name, entry);
      return;
    }
    const entry = members.methods.get(name) ?? { signatures: [], abstract: false, first: member };
    if (member.type === 'method_definition' && member.childForFieldName('body')) entry.implementation = member;
    else entry.signatures.push({ ...this.c.signatures.signatureOf(member), isMethod: true });
    if (member.type === 'abstract_method_signature' || hasToken(member, 'abstract')) entry.abstract = true;
    members.methods.set(name, entry);
  }

  private addIndexSignature(structure: Structure, member: TreeNode): void {
    const indexType = member.childForFieldName('index_type');
    const keyType = indexType ? this.c.typeNodes.typeFromNode(indexType) : undefined;
    const index = {
      type: this.c.typeNodes.annotationType(member.childForFieldName('type')) ?? anyType,
      readonly: hasToken(member, 'readonly'),
    };
    if (keyType && isIntrinsic(keyType, 'number')) structure.numberIndex = index;
    else structure.stringIndex = index;
  }

  private methodProperty(name: string, entry: MethodEntry, info: ClassInfo): Property {
    const signatures =
      entry.signatures.length > 0 && entry.implementation
        ? entry.signatures
        : entry.implementation
          ? [{ ...this.c.signatures.signatureOf(entry.implementation), isMethod: true }]
          : entry.signatures;
    const declaration = entry.first;
    return {
      name,
      type: () => this.c.overloadedFunction(signatures),
      optional: hasToken(declaration, '?'),
      readonly: false,
      isMethod: true,
      visibility: this.visibilityOf(declaration),
      declaringClass: info,
      isPrivateName: declaration.childForFieldName('name')?.type === 'private_property_identifier',
      declaration,
      isAbstract: entry.abstract,
    };
  }

  private accessorProperty(name: string, { getter, setter }: AccessorEntry, info: ClassInfo): Property {
    const declaration = (getter ?? setter) as TreeNode;
    return {
      name,
      type: () => this.accessorType(getter, setter),
      optional: false,
      readonly: !setter,
      getterOnly: !setter,
      isMethod: false,
      visibility: this.visibilityOf(declaration),
      declaringClass: info,
      isPrivateName: declaration.childForFieldName('name')?.type === 'private_property_identifier',
      declaration,
      isAbstract: hasToken(declaration, 'abstract'),
    };
  }

  private addParameterProperties(ctor: TreeNode, info: ClassInfo, structure: Structure): void {
    const parameters = ctor.childForFieldName('parameters');
    if (!parameters) return;
    const signature = this.c.signatures.signatureOf(ctor);
    let index = 0;
    for (const parameter of named(parameters)) {
      const pattern = parameter.childForFieldName('pattern');
      if (pattern?.type === 'this') continue;
      const modifier = parameter.namedChildren.find((child) => child?.type === 'accessibility_modifier');
      const isReadonly = hasToken(parameter, 'readonly');
      if ((modifier || isReadonly) && pattern?.type === 'identifier') {
        const parameterType = signature.parameters[index]?.type ?? anyType;
        structure.properties.set(pattern.text, {
          name: pattern.text,
          type: () =>
            parameter.type === 'optional_parameter' ? unionOf([parameterType, undefinedType]) : parameterType,
          optional: parameter.type === 'optional_parameter',
          readonly: isReadonly,
          isMethod: false,
          visibility: (modifier?.text as Property['visibility'] | undefined) ?? 'public',
          declaringClass: info,
          declaration: parameter,
        });
      }
      index++;
    }
  }

  private visibilityOf(member: TreeNode): Property['visibility'] {
    const modifier = member.namedChildren.find((child) => child?.type === 'accessibility_modifier');
    return (modifier?.text as Property['visibility'] | undefined) ?? 'public';
  }

  private fieldType(member: TreeNode, nameNode: TreeNode): Type {
    const annotation = this.c.typeNodes.annotationType(member.childForFieldName('type'));
    if (annotation) return annotation;
    const value = member.childForFieldName('value');
    if (value) {
      const owner = member.parent?.parent;
      const info = owner ? this.classInfoOfNode(owner) : undefined;
      const valueType = this.c.silently(() =>
        this.withThis(info && !hasToken(member, 'static') ? info.instanceType : info?.staticType, () =>
          this.c.expressions.check(value)
        )
      );
      return this.c.literals.widenDeclared(valueType, hasToken(member, 'readonly'));
    }
    const assigned = this.constructorAssignments(member, nameNode.text);
    if (assigned.length > 0) return unionOf(assigned);
    if (!this.c.isLibrary(member)) this.c.error(nameNode, `メンバー ${nameNode.text} の型が暗黙に any になります。`);
    return anyType;
  }

  /** The widened types the constructor assigns to `this.name`, from which a field without a type takes its type. */
  // code-gauge-allow functionCognitiveComplexity 16 -- Walks the constructor for assignments to the field outside nested functions.
  private constructorAssignments(member: TreeNode, name: string): Type[] {
    const classNode = member.parent?.parent;
    const ctor = classNode ? this.constructorNode(classNode) : undefined;
    if (!ctor || hasToken(member, 'static')) return [];
    const types: Type[] = [];
    const body = ctor.childForFieldName('body');
    let definite = false;
    const visit = (node: TreeNode): void => {
      if (
        ['function_declaration', 'function_expression', 'class', 'method_definition'].includes(node.type) &&
        node.id !== ctor.id
      )
        return;
      const left = node.type === 'assignment_expression' ? node.childForFieldName('left') : undefined;
      const right = node.childForFieldName('right');
      if (
        left?.type === 'member_expression' &&
        left.childForFieldName('object')?.type === 'this' &&
        left.childForFieldName('property')?.text === name &&
        right
      ) {
        types.push(this.c.widen(this.c.silently(() => this.c.expressions.check(right))));
        // An assignment statement directly in the constructor's body always runs.
        definite ||= node.parent?.type === 'expression_statement' && node.parent.parent?.id === body?.id;
      }
      for (const child of named(node)) visit(child);
    };
    visit(ctor);
    if (types.length > 0 && !definite) types.push(undefinedType);
    return types;
  }

  private accessorType(getter: TreeNode | undefined, setter: TreeNode | undefined): Type {
    if (getter) {
      const signature = this.c.signatures.signatureOf(getter);
      return signature.returnType();
    }
    if (setter) {
      const signature = this.c.signatures.signatureOf(setter);
      return signature.parameters[0]?.type ?? anyType;
    }
    return anyType;
  }

  classExpression(node: TreeNode): Type {
    const info = this.classInfoOfNode(node);
    this.c.classDeclarations.checkClass(node);
    return info.staticType;
  }

  // this ---------------------------------------------------------------------------------------------------------

  private readonly thisStack: (Type | undefined)[] = [];

  withThis<T>(type: Type | undefined, run: () => T): T {
    this.thisStack.push(type);
    try {
      return run();
    } finally {
      this.thisStack.pop();
    }
  }

  /** The object literals whose methods' `this` is the literal, by method, for return types inferred later. */
  private readonly objectThisByMethod = new Map<number, ObjectType>();

  withObjectThis<T>(object: ObjectType, run: () => T, method?: TreeNode): T {
    if (method) this.objectThisByMethod.set(method.id, object);
    this.objectThis.push(object);
    try {
      return run();
    } finally {
      this.objectThis.pop();
    }
  }

  /** The node that decides what `this` is at `node`: a class member, a function, or the program. */
  private thisOwner(node: TreeNode): TreeNode | undefined {
    for (let current = node.parent; current; current = current.parent) {
      switch (current.type) {
        case 'function_declaration':
        case 'function_expression':
        case 'method_definition':
        case 'class_static_block': {
          return current;
        }
        case 'public_field_definition': {
          return current;
        }
        case 'class_heritage': {
          // The heritage is evaluated outside the class.
          current = current.parent ?? current;
          break;
        }
        default: {
          break;
        }
      }
    }
    return undefined;
  }

  thisOwnerId(node: TreeNode): number {
    return this.thisOwner(node)?.id ?? 0;
  }

  thisTypeOfExpression(node: TreeNode): Type {
    const owner = this.thisOwner(node);
    if (!owner) return undefinedType;
    const thisParameter = this.thisParameterType(owner);
    if (thisParameter) return thisParameter;
    const parent = owner.parent;
    if (owner.type === 'method_definition' && parent?.type === 'object') {
      return this.objectThisByMethod.get(owner.id) ?? this.objectThis.at(-1) ?? anyType;
    }
    if (
      (owner.type === 'method_definition' ||
        owner.type === 'public_field_definition' ||
        owner.type === 'class_static_block') &&
      parent?.type === 'class_body'
    ) {
      const classNode = parent.parent as TreeNode;
      const info = this.classInfoOfNode(classNode);
      const isStatic = owner.type === 'class_static_block' || hasToken(owner, 'static');
      this.checkThisBeforeSuper(node, owner, classNode);
      return isStatic ? info.staticType : this.selfType(info);
    }
    if (owner.type === 'function_declaration' || owner.type === 'function_expression') {
      const fromStack = this.thisStack.at(-1);
      if (fromStack) return fromStack;
      this.c.error(node, "'this' の型が暗黙に any になります。型の注釈がないためです。");
      return anyType;
    }
    return anyType;
  }

  private thisParameterType(owner: TreeNode): Type | undefined {
    const parameters = owner.childForFieldName('parameters');
    const first = parameters ? named(parameters)[0] : undefined;
    if (first?.childForFieldName('pattern')?.type === 'this')
      return this.c.typeNodes.annotationType(first.childForFieldName('type'));
    return undefined;
  }

  /** Reports `this` in a derived class's constructor before it calls `super(...)`. */
  private checkThisBeforeSuper(node: TreeNode, owner: TreeNode, classNode: TreeNode): void {
    if (owner.type !== 'method_definition' || owner.childForFieldName('name')?.text !== 'constructor') return;
    if (!this.extendsClause(classNode)) return;
    const body = owner.childForFieldName('body');
    if (!body) return;
    const superCall = this.firstSuperCall(body);
    if (!superCall || node.startIndex < superCall.endIndex) {
      if (superCall && this.isInside(node, superCall)) return;
      this.c.error(node, "派生クラスのコンストラクタでは、'this' を使う前に 'super' を呼び出してください。");
    }
  }

  private isInside(node: TreeNode, container: TreeNode): boolean {
    return container.startIndex <= node.startIndex && node.endIndex <= container.endIndex;
  }

  private firstSuperCall(body: TreeNode): TreeNode | undefined {
    for (const statement of named(body)) {
      if (statement.type !== 'expression_statement') continue;
      const expression = named(statement)[0];
      if (expression?.type === 'call_expression' && expression.childForFieldName('function')?.type === 'super')
        return expression;
    }
    return undefined;
  }

  /** The type `this` stands for in a type annotation. */
  thisTypeAt(node: TreeNode): Type {
    for (let current = node.parent; current; current = current.parent) {
      if (classTypes.has(current.type)) return this.selfType(this.classInfoOfNode(current));
      if (current.type === 'interface_declaration') {
        const name = current.childForFieldName('name')?.text;
        const symbol = name ? this.c.scopeOf(current).lookupType(name) : undefined;
        return symbol ? this.c.typeNodes.declaredTypeOf(symbol) : anyType;
      }
    }
    this.c.error(node, "'this' 型は、クラスかインターフェースの中でしか使えません。");
    return errorType;
  }

  // super --------------------------------------------------------------------------------------------------------

  private enclosingClass(node: TreeNode): TreeNode | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type === 'class_body') return current.parent ?? undefined;
    }
    return undefined;
  }

  superProperty(node: TreeNode, propertyNode: TreeNode): Type {
    const classNode = this.enclosingClass(node);
    const base = classNode ? this.baseInstanceType(classNode) : undefined;
    if (!classNode || !base) {
      this.c.error(node, "'super' は派生クラスの中でしか使えません。");
      return errorType;
    }
    const owner = this.thisOwner(node);
    const isStatic = owner !== undefined && hasToken(owner, 'static');
    const target = isStatic ? (this.baseStaticType(classNode) ?? anyType) : base;
    const property = this.c.propertyOf(target, propertyNode.text);
    if (property?.isAbstract && property.isMethod) {
      this.c.error(propertyNode, `抽象メソッド '${propertyNode.text}' は、'super' からは使えません。`);
    }
    return this.c.members.propertyAccess(
      node,
      node.childForFieldName('object') as TreeNode,
      propertyNode,
      target,
      propertyNode.text
    );
  }

  /** Reports, in a field initializer, a field of the same class that is initialized after it. */
  checkInitializedBefore(node: TreeNode, objectNode: TreeNode, property: Property): void {
    if (objectNode.type !== 'this' || !property.declaringClass || !property.declaration) return;
    const owner = this.thisOwner(node);
    if (owner?.type !== 'public_field_definition' || hasToken(owner, 'static')) return;
    if (owner.parent?.parent?.id !== property.declaringClass.declaration.id) return;
    // A function in the initializer runs later, when it is called.
    for (let current = node.parent; current && current.id !== owner.id; current = current.parent) {
      if (current.type === 'arrow_function') return;
    }
    const declaration = property.declaration;
    // A field initializes in declaration order, a field without an initializer only in the constructor, after them.
    const later =
      declaration.type === 'public_field_definition'
        ? declaration.startIndex > owner.startIndex ||
          (!declaration.childForFieldName('value') && !hasToken(declaration, '!') && !hasToken(declaration, '?'))
        : declaration.type === 'required_parameter' || declaration.type === 'optional_parameter';
    if (later)
      this.c.error(
        node.childForFieldName('property') ?? node,
        `プロパティ '${property.name}' は、初期化される前に使われています。`
      );
  }

  superCall(node: TreeNode, args: TreeNode[]): Type {
    const classNode = this.enclosingClass(node);
    const baseStatic = classNode ? this.baseStaticType(classNode) : undefined;
    if (!baseStatic) {
      for (const arg of args) this.c.expressions.check(arg);
      this.c.error(node, "'super' の呼び出しは、派生クラスのコンストラクタの中でしか書けません。");
      return voidType;
    }
    if (isAnyLike(baseStatic)) {
      for (const arg of args) this.c.expressions.check(arg);
      return voidType;
    }
    const signatures = this.c
      .signaturesOf(baseStatic, 'construct')
      .map((signature) => ({ ...signature, isAbstract: false }));
    const clause = classNode ? this.extendsClause(classNode) : undefined;
    const argumentsNode = clause?.childForFieldName('type_arguments');
    const typeArguments = argumentsNode
      ? named(argumentsNode).map((argument) => this.c.typeNodes.typeFromNode(argument))
      : undefined;
    const instantiated = typeArguments
      ? signatures.map((signature) =>
          this.c.instantiateSignature(
            { ...signature, typeParameters: [] },
            new Map(signature.typeParameters.map((parameter, index) => [parameter.id, typeArguments[index] ?? anyType]))
          )
        )
      : signatures;
    this.c.expressions.calls.resolveWith(node, node.childForFieldName('function') as TreeNode, instantiated, args);
    return voidType;
  }

  // Accessibility ------------------------------------------------------------------------------------------------

  checkPropertyAccessibility(
    node: TreeNode,
    propertyNode: TreeNode,
    objectNode: TreeNode,
    objectType: Type,
    property: Property
  ): void {
    void objectType;
    if (property.visibility === 'public' || !property.declaringClass) return;
    const enclosing = this.enclosingClass(node);
    const enclosingInfo = enclosing ? this.classInfoOfNode(enclosing) : undefined;
    const declaring = property.declaringClass;
    if (property.visibility === 'private') {
      if (enclosingInfo?.declaration.id !== declaring.declaration.id) {
        this.c.error(
          propertyNode,
          `プロパティ '${property.name}' は private なので、クラス '${declaring.name}' の中でしか使えません。`
        );
      }
      return;
    }
    // Protected: inside the declaring class or a class derived from it.
    if (!enclosingInfo || !this.derivesFrom(enclosingInfo, declaring)) {
      this.c.error(
        propertyNode,
        `プロパティ '${property.name}' は protected なので、クラス '${declaring.name}' とその派生クラスの中でしか使えません。`
      );
      return;
    }
    if (objectNode.type === 'super' || objectNode.type === 'this') return;
    const objectInfo = this.classInfoOfType(this.c.silently(() => this.c.expressions.check(objectNode)));
    if (objectInfo && !this.derivesFrom(objectInfo, enclosingInfo)) {
      this.c.error(
        propertyNode,
        `プロパティ '${property.name}' は protected なので、クラス '${enclosingInfo.name}' のインスタンスからしか使えません。`
      );
    }
  }

  private classInfoOfType(type: Type): ClassInfo | undefined {
    if (type.kind !== 'object') return undefined;
    return type.classInfo ?? type.target?.classInfo;
  }

  derivesFrom(info: ClassInfo, base: ClassInfo): boolean {
    for (let current: ClassInfo | undefined = info; current; current = this.baseClassInfo(current)) {
      if (current.declaration.id === base.declaration.id) return true;
    }
    return false;
  }

  /** Reports `new` of a class whose constructor is private or protected, outside the class (or its subclasses). */
  checkConstructorAccessibility(node: TreeNode, type: Type): void {
    const info = type.kind === 'object' && type.isClassStatic ? type.classInfo : undefined;
    const ctor = info && this.constructorNode(info.declaration);
    const modifier = ctor?.namedChildren.find((child) => child?.type === 'accessibility_modifier')?.text;
    if (!info || (modifier !== 'private' && modifier !== 'protected')) return;
    const enclosing = this.enclosingClass(node);
    const enclosingInfo = enclosing ? this.classInfoOfNode(enclosing) : undefined;
    if (enclosingInfo?.declaration.id === info.declaration.id) return;
    this.c.error(
      node,
      `クラス '${info.name}' のコンストラクタは ${modifier} なので、クラスの宣言の中でしか使えません。`
    );
  }

  /** Whether assigning to a property is an error: it is read-only, outside its class's constructor. */
  isReadonlyFor(property: Property, expression: TreeNode, objectNode: TreeNode): boolean {
    if (!property.readonly) return false;
    if (objectNode.type !== 'this' || !property.declaringClass) return true;
    const owner = this.thisOwner(expression);
    if (!owner) return true;
    // An arrow function may run after construction, so it cannot assign a read-only property.
    for (let current = expression.parent; current && current.id !== owner.id; current = current.parent) {
      if (current.type === 'arrow_function') return true;
    }
    const isConstructor = owner.type === 'method_definition' && owner.childForFieldName('name')?.text === 'constructor';
    const isInitializer = owner.type === 'public_field_definition';
    if (!isConstructor && !isInitializer) return true;
    const classNode = owner.parent?.parent;
    return classNode?.id !== property.declaringClass.declaration.id;
  }

  privateNameAccess(node: TreeNode, propertyNode: TreeNode, objectType: Type): Type {
    const name = propertyNode.text;
    const property = this.c.propertyOf(objectType, name);
    if (!property) {
      this.c.error(propertyNode, `プロパティ '${name}' は型 '${this.c.print(objectType)}' にありません。`);
      return errorType;
    }
    const enclosing = this.enclosingClass(node);
    if (!enclosing || property.declaringClass?.declaration.id !== enclosing.id) {
      this.c.error(propertyNode, `プロパティ '${name}' は、それを宣言したクラスの外では使えません。`);
    }
    return property.type();
  }

  // Flow ---------------------------------------------------------------------------------------------------------

  /** The flow state at the start of a function's body: a constructor starts with its fields unassigned. */
  initialFlow(node: TreeNode): State {
    void node;
    return new FlowState();
  }
}

export { anonymousObject };
