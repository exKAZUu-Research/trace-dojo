import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { checkDuplicateMembers } from './declarations';
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
  undefinedType,
  unionOf,
  voidType,
} from './types';

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

  // code-gauge-allow functionCognitiveComplexity 40 -- Collects each kind of class member.
  classInfoOfNode(node: TreeNode): ClassInfo {
    const cached = this.infos.get(node.id);
    if (cached) return cached;
    const name = node.childForFieldName('name')?.text ?? this.anonymousClassName(node);
    const typeParameters = this.c.typeParametersOf(node);
    const isAbstract = node.type === 'abstract_class_declaration' || hasToken(node, 'abstract');
    let instanceStructure: Structure | undefined;
    let staticStructure: Structure | undefined;
    const info = { name, declaration: node, isAbstract } as ClassInfo;
    this.infos.set(node.id, info);
    const instanceType: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'interface',
      name,
      typeParameters: typeParameters.length > 0 ? typeParameters : undefined,
      classInfo: info,
      resolve: () => {
        if (instanceStructure) return instanceStructure;
        instanceStructure = emptyStructure();
        const own = this.membersOf(node, info, false);
        const base = this.baseInstanceType(node);
        instanceStructure = base ? this.mergeBase(own, base, instanceType) : own;
        return instanceStructure;
      },
    };
    const staticType: ObjectType = {
      kind: 'object',
      id: newTypeId(),
      objectKind: 'anonymous',
      name,
      classInfo: info,
      isClassStatic: true,
      resolve: () => {
        if (staticStructure) return staticStructure;
        staticStructure = emptyStructure();
        const own = this.membersOf(node, info, true);
        own.properties.set('prototype', simpleProperty('prototype', info.instanceType, { readonly: true }));
        own.constructSignatures.push(...this.constructSignatures(node, info));
        const baseStatic = this.baseStaticType(node);
        if (baseStatic) {
          for (const [memberName, property] of this.c.structureOf(baseStatic).properties) {
            if (!own.properties.has(memberName)) own.properties.set(memberName, property);
          }
        }
        staticStructure = own;
        return staticStructure;
      },
    };
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

  private extendsClause(node: TreeNode): TreeNode | undefined {
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
    const typeArguments = argumentsNode ? named(argumentsNode).map((argument) => this.c.typeFromNode(argument)) : [];
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

  private constructorNode(node: TreeNode): TreeNode | undefined {
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
        ...this.c.signatureOf(declaration),
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

  // code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of class member.
  private membersOf(node: TreeNode, info: ClassInfo, isStatic: boolean): Structure {
    const structure = emptyStructure();
    const body = node.childForFieldName('body');
    if (!body) return structure;
    const methods = new Map<
      string,
      { signatures: Signature[]; implementation?: TreeNode; abstract: boolean; first: TreeNode }
    >();
    const accessors = new Map<string, { getter?: TreeNode; setter?: TreeNode }>();
    for (const member of named(body)) {
      if (hasToken(member, 'static') !== isStatic) continue;
      const nameNode = member.childForFieldName('name');
      const name = nameNode ? propertyNameText(nameNode) : undefined;
      switch (member.type) {
        case 'public_field_definition': {
          if (name === undefined || !nameNode) break;
          structure.properties.set(name, {
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
          });
          break;
        }
        case 'method_definition':
        case 'method_signature':
        case 'abstract_method_signature': {
          if (name === undefined || name === 'constructor') break;
          if (hasToken(member, 'get') || hasToken(member, 'set')) {
            const entry = accessors.get(name) ?? {};
            if (hasToken(member, 'get')) entry.getter = member;
            else entry.setter = member;
            accessors.set(name, entry);
            break;
          }
          const entry = methods.get(name) ?? { signatures: [], abstract: false, first: member };
          if (member.type === 'method_definition' && member.childForFieldName('body')) entry.implementation = member;
          else entry.signatures.push({ ...this.c.signatureOf(member), isMethod: true });
          if (member.type === 'abstract_method_signature' || hasToken(member, 'abstract')) entry.abstract = true;
          methods.set(name, entry);
          break;
        }
        case 'index_signature': {
          const indexType = member.childForFieldName('index_type');
          const keyType = indexType ? this.c.typeFromNode(indexType) : undefined;
          const index = {
            type: this.c.annotationType(member.childForFieldName('type')) ?? anyType,
            readonly: hasToken(member, 'readonly'),
          };
          if (keyType && isIntrinsic(keyType, 'number')) structure.numberIndex = index;
          else structure.stringIndex = index;
          break;
        }
        default: {
          break;
        }
      }
    }
    for (const [name, entry] of methods) {
      const signatures =
        entry.signatures.length > 0 && entry.implementation
          ? entry.signatures
          : entry.implementation
            ? [{ ...this.c.signatureOf(entry.implementation), isMethod: true }]
            : entry.signatures;
      const declaration = entry.first;
      structure.properties.set(name, {
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
      });
    }
    for (const [name, { getter, setter }] of accessors) {
      const declaration = (getter ?? setter) as TreeNode;
      structure.properties.set(name, {
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
      });
    }
    if (!isStatic) {
      const ctor = this.constructorNode(node);
      if (ctor) this.addParameterProperties(ctor, info, structure);
    }
    return structure;
  }

  private addParameterProperties(ctor: TreeNode, info: ClassInfo, structure: Structure): void {
    const parameters = ctor.childForFieldName('parameters');
    if (!parameters) return;
    const signature = this.c.signatureOf(ctor);
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
    const annotation = this.c.annotationType(member.childForFieldName('type'));
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
      return this.c.expressions.widenDeclared(valueType, hasToken(member, 'readonly'));
    }
    if (!this.c.isLibrary(member)) this.c.error(nameNode, `メンバー ${nameNode.text} の型が暗黙に any になります。`);
    return anyType;
  }

  private accessorType(getter: TreeNode | undefined, setter: TreeNode | undefined): Type {
    if (getter) {
      const signature = this.c.signatureOf(getter);
      return signature.returnType();
    }
    if (setter) {
      const signature = this.c.signatureOf(setter);
      return signature.parameters[0]?.type ?? anyType;
    }
    return anyType;
  }

  classExpression(node: TreeNode): Type {
    const info = this.classInfoOfNode(node);
    this.checkClass(node);
    return info.staticType;
  }

  // this ---------------------------------------------------------------------------------------------------------

  private readonly thisStack: (Type | undefined)[] = [];

  private withThis<T>(type: Type | undefined, run: () => T): T {
    this.thisStack.push(type);
    try {
      return run();
    } finally {
      this.thisStack.pop();
    }
  }

  withObjectThis<T>(object: ObjectType, run: () => T): T {
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

  // code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of function that decides `this`.
  thisTypeOfExpression(node: TreeNode): Type {
    const owner = this.thisOwner(node);
    if (!owner) return undefinedType;
    const thisParameter = this.thisParameterType(owner);
    if (thisParameter) return thisParameter;
    const parent = owner.parent;
    if (owner.type === 'method_definition' && parent?.type === 'object') {
      return this.objectThis.at(-1) ?? anyType;
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
      return this.c.annotationType(first.childForFieldName('type'));
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
        return symbol ? this.c.declaredTypeOf(symbol) : anyType;
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
    return this.c.expressions.propertyAccess(
      node,
      node.childForFieldName('object') as TreeNode,
      propertyNode,
      target,
      propertyNode.text
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
      ? named(argumentsNode).map((argument) => this.c.typeFromNode(argument))
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
    if (
      objectInfo &&
      !this.derivesFrom(objectInfo, enclosingInfo) &&
      objectInfo.declaration.id !== declaring.declaration.id
    ) {
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

  checkConstructorAccessibility(node: TreeNode, type: Type): void {
    void node;
    void type;
  }

  /** Whether assigning to a property is an error: it is read-only, outside its class's constructor. */
  isReadonlyFor(property: Property, expression: TreeNode, objectNode: TreeNode): boolean {
    if (!property.readonly) return false;
    if (objectNode.type !== 'this' || !property.declaringClass) return true;
    const owner = this.thisOwner(expression);
    if (!owner) return true;
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
      if (member.type !== 'public_field_definition' || hasToken(member, 'static')) continue;
      if (
        member.childForFieldName('value') ||
        hasToken(member, '!') ||
        hasToken(member, '?') ||
        hasToken(member, 'declare') ||
        hasToken(member, 'abstract')
      )
        continue;
      const typeNode = member.childForFieldName('type');
      const nameNode = member.childForFieldName('name');
      if (!typeNode || !nameNode || nameNode.type === 'computed_property_name') continue;
      const type = this.c.annotationType(typeNode) ?? anyType;
      if (isAnyLike(type) || isIntrinsic(type, 'unknown') || this.c.relations.isAssignable(undefinedType, type))
        continue;
      const key = `this${ownerId}.${nameNode.text}`;
      const assigned =
        ctor !== undefined && states.length > 0 && states.every((state) => state.assignedFields.has(key));
      if (!assigned) {
        this.c.error(
          nameNode,
          `プロパティ ${nameNode.text} には初期値がなく、コンストラクタの中で必ず代入されてもいません。`
        );
      }
    }
  }

  // Declarations -------------------------------------------------------------------------------------------------

  private readonly checked = new Set<number>();

  // code-gauge-allow functionCognitiveComplexity 40 -- Each check a class declaration needs.
  checkClass(node: TreeNode): void {
    if (this.c.silent > 0 || this.checked.has(node.id)) return;
    this.checked.add(node.id);
    const info = this.classInfoOfNode(node);
    const clause = this.extendsClause(node);
    const baseValue = clause?.childForFieldName('value');
    if (baseValue) {
      const baseType = this.c.expressions.check(baseValue);
      if (!isAnyLike(baseType) && baseType !== errorType && this.c.signaturesOf(baseType, 'construct').length === 0) {
        this.c.error(baseValue, `型 '${this.c.print(baseType)}' はコンストラクタの型ではありません。`);
      }
    }
    const body = node.childForFieldName('body');
    const members = body ? named(body) : [];
    if (body) checkDuplicateMembers(this.c, body);
    // Types written in the class report the names they cannot find.
    this.c.typeParametersOf(node);
    const instance = info.instanceType.resolve();
    info.staticType.resolve();
    for (const property of instance.properties.values()) {
      if (property.declaringClass === info) property.type();
    }
    const ctor = this.constructorNode(node);
    for (const member of members) this.checkMember(node, member, info, ctor);
    if (!ctor) this.checkPropertyInitialization(node, undefined, new FlowState(), []);
    else if (clause && !this.firstSuperCallAnywhere(ctor)) {
      this.c.error(
        ctor.childForFieldName('name') ?? ctor,
        "派生クラスのコンストラクタには 'super' の呼び出しが必要です。"
      );
    }
    this.checkImplements(node, info);
    this.c.statements.checkIndexConformance(this.membersOf(node, info, false));
    this.checkAbstractMembers(node, info);
    this.checkBaseCompatibility(node, info);
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
        ['function_declaration', 'function_expression', 'class', 'method_definition'].includes(current.type) &&
        current.id !== ctor.id
      )
        return;
      for (const child of named(current)) visit(child);
    };
    visit(ctor);
    return found;
  }

  private checkMember(classNode: TreeNode, member: TreeNode, info: ClassInfo, ctor: TreeNode | undefined): void {
    const isStatic = hasToken(member, 'static');
    switch (member.type) {
      case 'public_field_definition': {
        const value = member.childForFieldName('value');
        const annotation = this.c.annotationType(member.childForFieldName('type'));
        if (value) {
          const valueType = this.withThis(isStatic ? info.staticType : info.instanceType, () =>
            this.c.flow.from(this.c.flow.current, () => {
              this.c.expressions.functions.push({
                node: member,
                returnTypes: [],
                endReachable: false,
                keepsLiterals: false,
                isConstructor: false,
                hasReturnWithValue: false,
                hasReturn: false,
                returnStates: [],
              });
              try {
                const type = this.c.expressions.check(value, annotation);
                if (annotation)
                  this.c.expressions.checkAssignable(member.childForFieldName('name') ?? value, type, annotation);
              } finally {
                this.c.expressions.functions.pop();
              }
            })
          );
          void valueType;
        }
        break;
      }
      case 'method_definition': {
        const signature = this.c.signatureOf(member);
        this.c.statements.checkFunctionLike(member, signature, undefined);
        if (member.id === ctor?.id) void classNode;
        break;
      }
      case 'class_static_block': {
        this.c.statements.checkFunctionLike(
          member,
          { typeParameters: [], parameters: [], returnType: () => voidType },
          undefined
        );
        break;
      }
      default: {
        break;
      }
    }
  }

  private checkImplements(node: TreeNode, info: ClassInfo): void {
    const heritage = node.namedChildren.find((child) => child?.type === 'class_heritage');
    const clause = heritage?.namedChildren.find((child) => child?.type === 'implements_clause');
    if (!clause) return;
    for (const typeNode of named(clause)) {
      const target = this.c.typeFromNode(typeNode);
      if (target === errorType || isAnyLike(target)) continue;
      if (!this.c.relations.isAssignable(info.instanceType, target)) {
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

  private checkBaseCompatibility(node: TreeNode, info: ClassInfo): void {
    const base = this.baseInstanceType(node);
    if (!base || isAnyLike(base)) return;
    const own = this.membersOf(node, info, false);
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
}

export { anonymousObject };
