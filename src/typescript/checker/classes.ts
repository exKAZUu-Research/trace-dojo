// code-gauge-allow-file fileNcss 580 -- Holds the types of classes with `this`, `super`, and accessibility, which all read the class information.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { typesAtConstructorExit } from './assignmentFlow';
import type { Checker } from './checker';
import { FlowState, type State } from './flow';
import { isUsedBeforeInitialization } from './initializationOrder';
import type { Sym, ValueKind } from './scopes';
import {
  hasToken,
  isClassConstructor,
  isConstructorName,
  isImmediatelyInvoked,
  isWithin,
  named,
  propertyNameText,
} from './syntax';
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

/** The kinds of global declarations that become properties of `globalThis`, unlike `let`, `const`, and classes. */
const globalThisValueKinds = new Set<ValueKind>(['var', 'function', 'declared']);

/** A private or protected constructor, with the class declaring it. */
interface RestrictedConstructor {
  classNode: TreeNode;
  visibility: 'private' | 'protected';
}

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

/** The key a class structure stores a member under: a `#name` is a distinct member in each class declaring it. */
function memberKey(name: string, info: ClassInfo): string {
  return name.startsWith('#') ? `${name}@${info.declaration.id}` : name;
}

/** Classes: their instance and constructor types, `this` and `super`, and the checks of their declarations. */
export class ClassChecker {
  private readonly infos = new Map<number, ClassInfo>();
  private readonly objectThis: ObjectType[] = [];
  private readonly fieldTypes = new Map<number, Type>();
  private readonly resolvingFields: { member: TreeNode; nameNode: TreeNode }[] = [];
  private globalThis?: ObjectType;

  constructor(private readonly c: Checker) {}

  classInfoOf(symbol: Sym): ClassInfo {
    const declaration = symbol.typeDeclarations.find((node) => classTypes.has(node.type)) ?? symbol.valueDeclaration;
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
      outerTypeParameters: this.c.signatures.outerTypeParametersOf(node),
      resolve: () => {
        if (structure) return structure;
        structure = emptyStructure();
        const interfaces = this.c.typeNodes.interfaceMembers(this.mergedInterfaces(node));
        const own = this.withInterfaceMembers(this.membersOf(node, info, false), interfaces.own);
        const base = this.baseInstanceType(node);
        structure = this.c.mergeBases(base ? this.mergeBase(own, base, instanceType) : own, interfaces.bases);
        return structure;
      },
    };
    return instanceType;
  }

  /** The interfaces of the class's name, which merge their members into its instances. */
  private mergedInterfaces(node: TreeNode): TreeNode[] {
    const name = node.type === 'class' ? undefined : node.childForFieldName('name')?.text;
    const declarations = name ? this.c.scopeOf(node).lookupType(name)?.typeDeclarations : undefined;
    return declarations?.filter((declaration) => declaration.type === 'interface_declaration') ?? [];
  }

  /**
   * The class's members with its interfaces': a method both declare takes the signatures of each as overloads, and the
   * declaration checks report any other member both declare differently.
   */
  private withInterfaceMembers(own: Structure, declared: Structure): Structure {
    const properties = new Map(own.properties);
    for (const [name, property] of declared.properties) {
      const existing = properties.get(name);
      if (!existing) properties.set(name, property);
      else if (existing.isMethod && property.isMethod) {
        const signatures = (method: Property): Signature[] => this.c.signaturesOf(method.type(), 'call');
        let type: Type | undefined;
        properties.set(name, {
          ...existing,
          type: () => (type ??= this.c.overloadedFunction([...signatures(existing), ...signatures(property)])),
        });
      }
    }
    return {
      properties,
      callSignatures: [...own.callSignatures, ...declared.callSignatures],
      constructSignatures: [...own.constructSignatures, ...declared.constructSignatures],
      stringIndex: own.stringIndex ?? declared.stringIndex,
      numberIndex: own.numberIndex ?? declared.numberIndex,
      symbolIndex: own.symbolIndex ?? declared.symbolIndex,
    };
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
      symbolIndex: own.symbolIndex ?? inherited.symbolIndex,
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

  /**
   * Whether a type parameter of a class is referenced inside one of its static members, which all instantiations of the
   * class share.
   */
  isClassTypeParameterInStaticMember(symbol: Sym, reference: TreeNode): boolean {
    const classNode = symbol.typeKind === 'typeParameter' ? symbol.typeDeclarations[0]?.parent?.parent : undefined;
    if (!classNode || !classTypes.has(classNode.type)) return false;
    let member: TreeNode | null = reference;
    while (member && member.parent?.parent?.id !== classNode.id) member = member.parent;
    return (
      member?.parent?.type === 'class_body' && (hasToken(member, 'static') || member.type === 'class_static_block')
    );
  }

  /** Whether the class extends `null`, whose instances have no base class and whose constructor may not call `super`. */
  extendsNull(node: TreeNode): boolean {
    const baseStatic = this.baseStaticType(node);
    return baseStatic !== undefined && isIntrinsic(baseStatic, 'null');
  }

  baseInstanceType(node: TreeNode): Type | undefined {
    const clause = this.extendsClause(node);
    const value = clause?.childForFieldName('value');
    if (!clause || !value) return undefined;
    const staticType = this.baseStaticType(node);
    if (!staticType || isAnyLike(staticType)) return staticType && anyType;
    const instantiated = this.baseConstructSignatures(node)?.[0];
    if (instantiated) return instantiated.returnType();
    // The `extends` clause reports type arguments no base signature takes, and the base's members then read as `any`.
    const returned = this.c.signaturesOf(staticType, 'construct')[0]?.returnType();
    const target = returned?.kind === 'object' && returned.objectKind === 'reference' ? returned.target : returned;
    return target?.kind === 'object' && target.typeParameters
      ? this.c.reference(
          target,
          target.typeParameters.map(() => anyType)
        )
      : returned;
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
            isConstructorName(member.childForFieldName('name')) &&
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
          (member) => member.type === 'method_signature' && isConstructorName(member.childForFieldName('name'))
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
    const inherited = this.baseConstructSignatures(node);
    if (inherited) {
      return inherited.map((signature) => ({
        ...signature,
        typeParameters,
        returnType: () => returnType,
        isAbstract: info.isAbstract,
      }));
    }
    return [{ typeParameters, parameters: [], returnType: () => returnType, isAbstract: info.isAbstract }];
  }

  /**
   * The base's construct signatures that take as many type arguments as the `extends` clause passes, instantiated with
   * them: a class without a constructor inherits these, and `super(...)` calls them.
   */
  baseConstructSignatures(node: TreeNode): Signature[] | undefined {
    const baseStatic = this.baseStaticType(node);
    if (!baseStatic || isAnyLike(baseStatic) || isIntrinsic(baseStatic, 'null')) return undefined;
    const typeArguments = this.baseTypeArguments(node);
    return this.c.signaturesOf(baseStatic, 'construct').flatMap((signature) => {
      const parameters = signature.typeParameters;
      const required = parameters.filter((parameter) => !parameter.default).length;
      if (typeArguments.length < required || typeArguments.length > parameters.length) return [];
      const filled = this.c.fillTypeArguments(parameters, typeArguments);
      const mapper = new Map(parameters.map((parameter, index) => [parameter.id, filled[index]]));
      return [this.c.instantiateSignature({ ...signature, typeParameters: [] }, mapper)];
    });
  }

  baseTypeArguments(node: TreeNode): Type[] {
    const argumentsNode = this.extendsClause(node)?.childForFieldName('type_arguments');
    return argumentsNode ? named(argumentsNode).map((argument) => this.c.typeNodes.typeFromNode(argument)) : [];
  }

  membersOf(node: TreeNode, info: ClassInfo, isStatic: boolean): Structure {
    const structure = emptyStructure();
    const body = node.childForFieldName('body');
    if (!body) return structure;
    const members: ClassMembers = { info, structure, methods: new Map(), accessors: new Map() };
    for (const member of named(body)) {
      if (hasToken(member, 'static') === isStatic) this.addMember(members, member);
    }
    for (const [name, entry] of members.methods)
      structure.properties.set(memberKey(name, info), this.methodProperty(name, entry, info));
    for (const [name, accessor] of members.accessors) {
      structure.properties.set(memberKey(name, info), this.accessorProperty(name, accessor, info));
    }
    if (!isStatic) {
      const ctor = this.constructorNode(node);
      if (ctor) this.addParameterProperties(ctor, info, structure);
    }
    return structure;
  }

  private addMember(members: ClassMembers, member: TreeNode): void {
    const nameNode = member.childForFieldName('name');
    const names = nameNode ? this.c.silently(() => this.c.patterns.capturePropertyNames(nameNode)) : undefined;
    const name = names?.length === 1 ? names[0] : undefined;
    switch (member.type) {
      case 'field_definition': {
        if (name !== undefined && nameNode)
          members.structure.properties.set(
            memberKey(name, members.info),
            this.fieldProperty(name, nameNode, member, members.info)
          );
        break;
      }
      case 'method_definition':
      case 'method_signature':
      case 'abstract_method_signature': {
        if (name !== undefined && !isConstructorName(nameNode)) this.addMethod(members, name, member);
        break;
      }
      case 'index_signature': {
        this.c.typeNodes.addIndexSignature(members.structure, member);
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
      writeType: setter ? () => this.c.signatures.signatureOf(setter).parameters[0]?.type ?? anyType : undefined,
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
    const cached = this.fieldTypes.get(member.id);
    if (cached) return cached;
    const resolving = this.resolvingFields.findIndex((field) => field.member.id === member.id);
    // Fields whose initializers read one another have no type to infer, as TypeScript reports for each of them.
    if (resolving !== -1) {
      for (const field of this.resolvingFields.slice(resolving)) {
        if (this.fieldTypes.has(field.member.id)) continue;
        this.fieldTypes.set(field.member.id, anyType);
        this.c.errorWhileResolving(
          field.nameNode,
          `${field.nameNode.text} の型が、自分自身を参照しているため暗黙に any になります。`
        );
      }
      return anyType;
    }
    this.resolvingFields.push({ member, nameNode });
    try {
      const type = this.inferredFieldType(member, nameNode);
      if (!this.fieldTypes.has(member.id)) this.fieldTypes.set(member.id, type);
      return this.fieldTypes.get(member.id) as Type;
    } finally {
      this.resolvingFields.pop();
    }
  }

  private inferredFieldType(member: TreeNode, nameNode: TreeNode): Type {
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
    const types = this.constructorExitTypes(member, nameNode);
    // A field the constructor leaves `undefined` or `null` on every path has no type to infer.
    if (!isIntrinsic(this.c.relations.removeNullish(unionOf(types)), 'never')) return unionOf(types);
    if (!this.c.isLibrary(member)) this.c.error(nameNode, `メンバー ${nameNode.text} の型が暗黙に any になります。`);
    return anyType;
  }

  /** The types an instance field holds where its class's constructor finishes. */
  private constructorExitTypes(member: TreeNode, nameNode: TreeNode): Type[] {
    const classNode = member.parent?.parent;
    const body =
      classNode && !hasToken(member, 'static') ? this.constructorNode(classNode)?.childForFieldName('body') : undefined;
    // Names compare as property keys, as `["x"]` and `x`, or `1` and `this[1]`, name the same field.
    const name = propertyNameText(nameNode);
    return body && name !== undefined
      ? typesAtConstructorExit(
          body,
          name,
          (right) => this.c.widen(this.c.silently(() => this.c.expressions.check(right))),
          (index) => {
            const key = this.c.silently(() => this.c.expressions.check(index));
            return key.kind === 'literal' && (typeof key.value === 'string' || typeof key.value === 'number')
              ? String(key.value)
              : undefined;
          },
          (operator, type) => skippedType(this.c, operator, type),
          () => this.c.budget.spend()
        )
      : [];
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
    if (method) this.registerObjectThis(method, object);
    this.objectThis.push(object);
    try {
      return run();
    } finally {
      this.objectThis.pop();
    }
  }

  registerObjectThis(method: TreeNode, object: ObjectType): void {
    this.objectThisByMethod.set(method.id, object);
  }

  /** The `this` types functions take from their contextual signatures, by function. */
  private readonly contextualThisByFunction = new Map<number, Type>();

  registerContextualThis(node: TreeNode, type: Type | undefined): void {
    if (type) this.contextualThisByFunction.set(node.id, type);
    else this.contextualThisByFunction.delete(node.id);
  }

  thisContextId(node: TreeNode): number {
    const owner = this.thisOwner(node);
    const ownerThis = owner && (this.contextualThisByFunction.get(owner.id) ?? this.objectThisByMethod.get(owner.id));
    return ownerThis?.id ?? this.thisStack.at(-1)?.id ?? 0;
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
        case 'field_definition': {
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
    if (!owner) return this.globalThisType(node);
    const thisParameter = this.thisParameterType(owner) ?? this.contextualThisByFunction.get(owner.id);
    if (thisParameter) return thisParameter;
    const parent = owner.parent;
    const objectThis = this.objectThisByMethod.get(owner.id);
    if (objectThis) return objectThis;
    if (owner.type === 'method_definition' && parent?.type === 'object') {
      return this.objectThis.at(-1) ?? anyType;
    }
    if (
      (owner.type === 'method_definition' ||
        owner.type === 'field_definition' ||
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

  /**
   * The type of `this` outside any function or class, which an arrow function must not capture: `typeof globalThis`, as
   * the reference compiler checks the program as a script, although it runs as a module.
   */
  private globalThisType(node: TreeNode): Type {
    for (let current = node.parent; current; current = current.parent) {
      if (current.type !== 'arrow_function') continue;
      this.c.error(node, "アロー関数が、グローバルの 'this' の値を取り込んでいます。");
      break;
    }
    this.globalThis ??= anonymousObject(() => this.globalThisStructure(), { aliasName: 'typeof globalThis' });
    return this.globalThis;
  }

  /** The members of `globalThis`: the global `var` declarations and functions, of the library and of the script. */
  private globalThisStructure(): Structure {
    const structure = emptyStructure();
    for (const symbol of this.c.libraryBinder.moduleScope.values.values()) {
      if (symbol.unsupported || !globalThisValueKinds.has(symbol.valueKind ?? 'let')) continue;
      structure.properties.set(symbol.name, {
        ...simpleProperty(symbol.name, anyType),
        type: () => this.c.expressions.valueTypeOf(symbol),
        declaration: symbol.valueDeclaration,
      });
    }
    return structure;
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
    if (!isClassConstructor(owner)) return;
    if (!this.extendsClause(classNode)) return;
    for (let current = node.parent; current && current.id !== owner.id; current = current.parent)
      if (current.type === 'arrow_function') return;
    if (this.c.flow.current && !this.c.flow.current.superCalled)
      this.c.error(node, "派生クラスのコンストラクタでは、'this' を使う前に 'super' を呼び出してください。");
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
    const target = this.superType(node);
    return target === errorType
      ? errorType
      : this.c.members.propertyAccess(
          node,
          node.childForFieldName('object') as TreeNode,
          propertyNode,
          target,
          propertyNode.text
        );
  }

  /** The type `super.<name>` at `node` reads a member of: the base instance type, or the base class in static code. */
  superType(node: TreeNode): Type {
    const classNode = this.enclosingClass(node);
    const base = classNode ? this.baseInstanceType(classNode) : undefined;
    if (!classNode || !base) {
      this.c.error(node, "'super' は派生クラスの中でしか使えません。");
      return errorType;
    }
    const owner = this.thisOwner(node);
    return owner !== undefined && hasToken(owner, 'static') ? (this.baseStaticType(classNode) ?? anyType) : base;
  }

  /** Reports, in a field initializer or a static block, a class member read before it is initialized. */
  checkInitializedBefore(node: TreeNode, objectNode: TreeNode, property: Property): void {
    if (isUsedBeforeInitialization(node, objectNode, property))
      this.c.error(
        node.childForFieldName('property') ?? node,
        `プロパティ '${property.name}' は、初期化される前に使われています。`
      );
  }

  superCall(node: TreeNode, args: TreeNode[]): Type {
    const classNode = this.enclosingClass(node);
    const baseStatic = classNode ? this.baseStaticType(classNode) : undefined;
    const owner = this.c.functions.contexts.at(-1)?.node;
    if (!baseStatic || !owner || !isClassConstructor(owner)) {
      for (const arg of args) this.c.expressions.check(arg);
      this.c.error(node, "'super' の呼び出しは、派生クラスのコンストラクタの中でしか書けません。");
      return voidType;
    }
    const signatures = (this.baseConstructSignatures(classNode as TreeNode) ?? []).map((signature) => ({
      ...signature,
      isAbstract: false,
    }));
    // An `any` base takes any arguments, and the `extends` clause reports type arguments no base signature takes.
    if (signatures.length > 0)
      this.c.expressions.calls.resolveWith(node, node.childForFieldName('function') as TreeNode, signatures, args);
    else for (const arg of args) this.c.expressions.check(arg);
    if (this.c.flow.current) this.c.flow.current.superCalled = true;
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
    if (!property.declaringClass || (objectNode.type === 'super' && this.reportSuperAccess(propertyNode, property)))
      return;
    if (property.visibility === 'public') return;
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
    if (
      objectNode.type === 'super' ||
      objectNode.type === 'this' ||
      (property.declaration && hasToken(property.declaration, 'static'))
    )
      return;
    const receiver = this.c.silently(() => this.c.relations.removeNullish(this.c.expressions.check(objectNode)));
    if (!this.isReceiverDerivedFrom(receiver, enclosingInfo)) {
      this.c.error(
        propertyNode,
        `プロパティ '${property.name}' は protected なので、クラス '${enclosingInfo.name}' のインスタンスからしか使えません。`
      );
    }
  }

  /**
   * Whether a receiver of a protected instance member is an instance of the enclosing class, as TypeScript's
   * `hasBaseType` decides: a type parameter by its constraint, an intersection by any member, and never a union.
   */
  private isReceiverDerivedFrom(type: Type, enclosing: ClassInfo): boolean {
    switch (type.kind) {
      case 'typeParameter': {
        const constraint = this.c.constraintOf(type);
        return constraint !== undefined && this.isReceiverDerivedFrom(constraint, enclosing);
      }
      case 'intersection': {
        return type.types.some((member) => this.isReceiverDerivedFrom(member, enclosing));
      }
      case 'union': {
        return false;
      }
      default: {
        const info = this.classInfoOfType(type);
        return !info || this.derivesFrom(info, enclosing);
      }
    }
  }

  /** Reports, through `super`, an abstract member or an instance field, which lives on the instance instead of the prototype. */
  private reportSuperAccess(propertyNode: TreeNode, property: Property): boolean {
    if (property.isAbstract) {
      this.c.error(propertyNode, `抽象メソッド '${property.name}' は、'super' からは使えません。`);
      return true;
    }
    const declaration = property.declaration;
    if (declaration?.type !== 'field_definition' || hasToken(declaration, 'static')) return false;
    this.c.error(propertyNode, `親クラスのフィールド '${property.name}' は、子クラスから 'super' では使えません。`);
    return true;
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

  /**
   * Reports `new` of a class whose constructor, its own or the one it inherits, is private or protected, outside the
   * class declaring that constructor (or, for a protected one, the classes derived from it).
   */
  checkConstructorAccessibility(node: TreeNode, signature: Signature): void {
    const ctor = this.restrictedDeclaration(signature.declaration);
    if (!ctor || isWithin(node, ctor.classNode)) return;
    const declaring = this.classInfoOfNode(ctor.classNode);
    const enclosing = this.enclosingClass(node);
    if (ctor.visibility === 'protected' && enclosing && this.derivesFrom(this.classInfoOfNode(enclosing), declaring))
      return;
    this.c.error(
      node,
      `クラス '${declaring.name}' のコンストラクタは ${ctor.visibility} なので、クラスの宣言の中でしか使えません。`
    );
  }

  /** The private or protected constructor of the first construct signature of `type`. */
  restrictedConstructor(type: Type): RestrictedConstructor | undefined {
    return this.restrictedDeclaration(this.c.signaturesOf(type, 'construct')[0]?.declaration);
  }

  private restrictedDeclaration(declaration: TreeNode | undefined): RestrictedConstructor | undefined {
    const classNode = declaration?.parent?.parent;
    if (!isConstructorName(declaration?.childForFieldName('name')) || !classNode || !classTypes.has(classNode.type))
      return undefined;
    const visibility = this.visibilityOf(declaration);
    return visibility === 'public' ? undefined : { classNode, visibility };
  }

  /** Whether assigning to a property is an error: it is read-only, outside its class's constructor. */
  isReadonlyFor(property: Property, expression: TreeNode, objectNode: TreeNode): boolean {
    if (!property.readonly) return false;
    if (objectNode.type !== 'this' || !property.declaringClass) return true;
    const owner = this.thisOwner(expression);
    if (!owner) return true;
    // An arrow function that is not immediately invoked may run after construction.
    for (let current = expression.parent; current && current.id !== owner.id; current = current.parent) {
      if (current.type === 'arrow_function' && !isImmediatelyInvoked(current)) return true;
    }
    if (!isClassConstructor(owner)) return true;
    const classNode = owner.parent?.parent;
    return classNode?.id !== property.declaringClass.declaration.id;
  }

  privateNameAccess(node: TreeNode, propertyNode: TreeNode, objectType: Type): Type {
    const name = propertyNode.text;
    const declaring = this.privateNameDeclarer(node, name);
    const property = declaring && this.c.propertyOf(objectType, memberKey(name, declaring));
    if (property) return property.type();
    const declaredElsewhere = [...this.c.structureOf(objectType).properties.values()].some(
      (member) => member.name === name
    );
    this.c.error(
      propertyNode,
      declaredElsewhere || !declaring
        ? `プロパティ '${name}' は、それを宣言したクラスの外では使えません。`
        : `プロパティ '${name}' は型 '${this.c.print(objectType)}' にありません。`
    );
    return errorType;
  }

  /** The key a property access's name has in class structures, where a `#name` is the one its enclosing classes declare. */
  propertyKey(node: TreeNode, propertyNode: TreeNode): string {
    const name = propertyNode.text;
    if (propertyNode.type !== 'private_property_identifier') return name;
    const declaring = this.privateNameDeclarer(node, name);
    return declaring ? memberKey(name, declaring) : name;
  }

  /** The innermost class enclosing a node that declares a `#name`, which every use of the name in it refers to. */
  private privateNameDeclarer(node: TreeNode, name: string): ClassInfo | undefined {
    for (let classNode = this.enclosingClass(node); classNode; classNode = this.enclosingClass(classNode)) {
      const body = classNode.childForFieldName('body');
      const declares = body && named(body).some((member) => member.childForFieldName('name')?.text === name);
      if (declares) return this.classInfoOfNode(classNode);
    }
    return undefined;
  }

  // Flow ---------------------------------------------------------------------------------------------------------

  /** The flow state at the start of a function's body: a constructor starts with its fields unassigned. */
  initialFlow(node: TreeNode): State {
    void node;
    return new FlowState();
  }
}

export { anonymousObject };

/** The part of a field's type for which `&&=`, `||=`, or `??=` skips assigning it, or undefined for none. */
function skippedType(c: Checker, operator: string, type: Type): Type | undefined {
  const skipped =
    operator === '??=' ? c.relations.removeNullish(type) : c.flow.narrowByTruthiness(type, operator === '||=');
  return isIntrinsic(skipped, 'never') ? undefined : skipped;
}
