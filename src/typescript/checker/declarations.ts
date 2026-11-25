import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { checkDuplicateIndexSignatures } from './indexConformance';
import { nativeGlobalRedeclaration } from './nativeGlobalIdentity';
import type { Scope, Sym } from './scopes';
import { hasToken, isConstructorName, isParameterProperty, named } from './syntax';
import { isAnyLike, isIntrinsic, type Property, type Type, undefinedType, unionOf } from './types';

/** Reports the declarations TypeScript rejects for declaring a name twice, at every declaration it involves. */
export function checkDuplicateDeclarations(c: Checker, scopes: Scope[]): void {
  checkBuiltinUndefinedDeclaration(c);
  for (const scope of scopes) {
    for (const symbol of scope.values.values())
      if (symbol.valueEntries.some((entry) => !c.isLibrary(entry.name))) checkValueDuplicates(c, symbol);
    for (const symbol of scope.types.values()) {
      if (!symbol.typeEntries.some((entry) => !c.isLibrary(entry.name))) continue;
      checkTypeDuplicates(c, symbol);
      checkReservedTypeName(c, symbol);
    }
  }
}

function checkBuiltinUndefinedDeclaration(c: Checker): void {
  const entries = c.binder.moduleScope.values.get('undefined')?.valueEntries ?? [];
  for (const { kind, name } of entries)
    if (kind !== 'class') c.error(name, "宣言名が組み込みのグローバル識別子 'undefined' と競合しています。");
}

const blockScopedKinds = new Set(['let', 'const', 'class']);

// code-gauge-allow functionCognitiveComplexity -- Distinguishes block-scoped conflicts, mixed function/var declarations, repeated implementations, and compatible var redeclarations.
function checkValueDuplicates(c: Checker, symbol: Sym): void {
  const entries = symbol.valueEntries;
  if (entries.length < 2) return;
  const name = symbol.name;
  if (
    entries.some((entry) => entry.kind === 'enum' || entry.kind === 'namespace') &&
    !checkNamespaceAndEnumMerges(c, symbol)
  )
    return;
  if (entries.some((entry) => blockScopedKinds.has(entry.kind))) {
    const message = namesBlockScopedConflict(c, entries)
      ? `ブロックスコープの変数 ${name} はすでに宣言されています。`
      : `${name} はすでに宣言されています。`;
    for (const entry of entries) c.error(entry.name, message);
    return;
  }
  const parameters = entries.filter((entry) => entry.kind === 'parameter');
  if (parameters.length > 1) {
    for (const parameter of parameters) c.error(parameter.name, `${name} はすでに宣言されています。`);
    return;
  }
  if (entries.some((entry) => entry.kind === 'function') && entries.some(isFunctionScopedVariable)) {
    for (const entry of entries) c.error(entry.name, `${name} はすでに宣言されています。`);
    return;
  }
  if (entries.every((entry) => entry.kind === 'function')) {
    const implementations = symbol.valueDeclarations.filter(
      (declaration) =>
        declaration.type === 'function_declaration' || declaration.type === 'generator_function_declaration'
    );
    if (implementations.length > 1) {
      for (const implementation of implementations) {
        c.error(implementation.childForFieldName('name') ?? implementation, `関数 ${name} の実装が重複しています。`);
      }
    }
    return;
  }
  if (
    symbol.valueKind !== 'parameter' &&
    entries.some((entry) => entry.kind === 'var') &&
    entries.every(isFunctionScopedVariable)
  )
    checkVarRedeclarations(c, symbol);
}

/**
 * A namespace merges with namespaces, functions, classes, and enums, and an enum only with enums and namespaces; any
 * other duplicate of a namespace's name is checked as the others are, which this tells by returning true.
 */
function checkNamespaceAndEnumMerges(c: Checker, symbol: Sym): boolean {
  const kinds = symbol.valueEntries.map((entry) => entry.kind);
  const mergeable = kinds.includes('enum') ? ['enum', 'namespace'] : ['namespace', 'function', 'class', 'enum'];
  if (kinds.every((kind) => mergeable.includes(kind))) return false;
  if (!kinds.includes('enum')) return true;
  for (const entry of symbol.valueEntries)
    c.error(entry.name, 'enum の宣言は、namespace かほかの enum の宣言としかマージできません。');
  return false;
}

export function checkParameterRedeclarations(c: Checker, scopes: Scope[]): void {
  for (const scope of scopes) {
    for (const symbol of scope.values.values()) {
      if (
        symbol.valueKind === 'parameter' &&
        symbol.valueEntries.some((entry) => entry.kind === 'var') &&
        symbol.valueEntries.every(isFunctionScopedVariable)
      )
        checkVarRedeclarations(c, symbol);
    }
  }
}

/** A `var` or a parameter, which a `var` of the same function redeclares. */
function isFunctionScopedVariable(entry: Sym['valueEntries'][number]): boolean {
  return entry.kind === 'var' || entry.kind === 'parameter';
}

/**
 * Whether TypeScript reports a conflict as a block-scoped redeclaration: against the library, when either side is `let`
 * or `const`, and within the program, when the declaration it binds first is, function declarations being bound first.
 */
function namesBlockScopedConflict(c: Checker, entries: Sym['valueEntries']): boolean {
  if (entries.some((entry) => c.isLibrary(entry.name))) return entries.some(isLexical);
  return isLexical(entries.find((entry) => entry.kind === 'function') ?? entries[0]);
}

function isLexical(entry: Sym['valueEntries'][number]): boolean {
  return entry.kind === 'let' || entry.kind === 'const';
}

function checkVarRedeclarations(c: Checker, symbol: Sym): void {
  const types = symbol.valueDeclarations.map((declaration) =>
    symbol.valueKind === 'parameter' && declaration === symbol.valueDeclaration
      ? c.silently(() => c.expressions.valueTypeOf(symbol))
      : c.silently(() => c.statements.declaredVariableType(symbol, declaration))
  );
  const [first] = types;
  for (let index = 1; index < types.length; index++) {
    const type = types[index];
    const native = nativeGlobalRedeclaration(c, symbol, symbol.valueDeclarations[index]);
    const identical =
      isIntrinsic(type, 'any') !== isIntrinsic(first, 'any') ? false : c.relations.identical(type, first);
    if (native ?? identical) continue;
    c.error(
      symbol.valueEntries[index].name,
      `後の変数の宣言は、同じ型でなければいけません。変数 ${symbol.name} の型は '${c.print(first)}' ですが、ここでは '${c.print(type)}' です。`
    );
  }
}

const reservedTypeNames = new Set([
  'any',
  'unknown',
  'never',
  'void',
  'undefined',
  'null',
  'string',
  'number',
  'bigint',
  'boolean',
  'symbol',
  'object',
]);
const declarationKindNames: Record<string, string> = {
  alias: '型の別名',
  interface: 'インターフェース',
  class: 'クラス',
};

/** Reports a type, interface, or class named as a predefined type, such as `type number = string`. */
function checkReservedTypeName(c: Checker, symbol: Sym): void {
  if (!reservedTypeNames.has(symbol.name)) return;
  for (const entry of symbol.typeEntries) {
    const kind = declarationKindNames[entry.kind];
    if (kind) c.error(entry.name, `${kind}の名前に '${symbol.name}' は使えません。`);
  }
}

function checkTypeDuplicates(c: Checker, symbol: Sym): void {
  const entries = symbol.typeEntries;
  if (entries.length < 2) return;
  const kinds = entries.map((entry) => entry.kind);
  // Enums merge with each other, conflict with a class as values, and conflict with a type-only declaration here.
  if (kinds.includes('enum')) {
    if (kinds.some((kind) => kind === 'alias' || kind === 'interface'))
      for (const entry of entries)
        c.error(entry.name, '列挙型の宣言は、名前空間または他の列挙型の宣言とのみマージできます。');
    return;
  }
  // Interfaces merge with each other and with a class; any other pair declares the name twice.
  const merges =
    kinds.every((kind) => kind === 'interface' || kind === 'class') &&
    kinds.filter((kind) => kind === 'class').length <= 1;
  if (!merges) {
    // Two classes report as values.
    if (kinds.every((kind) => kind === 'class')) return;
    for (const entry of entries) c.error(entry.name, `${symbol.name} はすでに宣言されています。`);
    return;
  }
  checkMergedTypeParameters(c, symbol);
  checkMergedProperties(c, symbol);
}

// code-gauge-allow functionCognitiveComplexity -- Validates parameter order, defaulted additions, and agreement of constraints and defaults across merged declarations.
function checkMergedTypeParameters(c: Checker, symbol: Sym): void {
  const lists = symbol.typeDeclarations.map((declaration) => {
    const parameters = declaration.childForFieldName('type_parameters');
    return parameters ? named(parameters) : [];
  });
  let mismatch = false;
  const seen = new Map<string, TreeNode>();
  for (const list of lists) {
    for (const [index, parameter] of list.entries()) {
      const name = parameter.childForFieldName('name')?.text ?? '';
      if (lists.some((other) => other[index] && other[index].childForFieldName('name')?.text !== name)) mismatch = true;
      if (lists.some((other) => other.length <= index) && !parameter.childForFieldName('value')) mismatch = true;
      if (!mergedParameterTypesAgree(c, parameter, name, seen)) mismatch = true;
    }
  }
  if (mismatch)
    for (const entry of symbol.typeEntries)
      c.error(entry.name, `同じ名前の型 ${symbol.name} の宣言は、同じ型パラメーターを持つ必要があります。`);
}

function mergedParameterTypesAgree(
  c: Checker,
  parameter: TreeNode,
  name: string,
  seen: Map<string, TreeNode>
): boolean {
  let matches = true;
  for (const field of ['constraint', 'value']) {
    const node = parameter.childForFieldName(field);
    if (!node) continue;
    const key = `${name}.${field}`;
    const previous = seen.get(key);
    if (
      previous &&
      !c.relations.identical(c.typeNodes.typeFromNode(named(previous)[0]), c.typeNodes.typeFromNode(named(node)[0]))
    )
      matches = false;
    else seen.set(key, node);
  }
  return matches;
}

/** A property declared again in a merged interface, or in the class it merges with, must have the same type. */
function checkMergedProperties(c: Checker, symbol: Sym): void {
  const properties = symbol.typeDeclarations.flatMap((declaration) => propertyDeclarationsOf(c, declaration));
  checkMergedMemberKinds(c, properties);
  // TypeScript binds computed names after the others, so a plain name declares the property first.
  const seen = new Map<string, TreeNode>();
  for (const member of [...properties.filter((member) => !isComputed(member)), ...properties.filter(isComputed)])
    if (!isMethodMember(member)) checkMergedProperty(c, member, seen);
}

function checkMergedMemberKinds(c: Checker, members: TreeNode[]): void {
  const groups = new Map<string, TreeNode[]>();
  for (const member of members) {
    c.budget.spend();
    const name = memberName(c, member);
    if (name === undefined) continue;
    const group = groups.get(name) ?? [];
    group.push(member);
    groups.set(name, group);
  }
  for (const [name, group] of groups) {
    c.budget.spend(group.length);
    const methods = group.filter(isMethodMember);
    const conflicts =
      methods.length > 0 && methods.length < group.length
        ? group
        : ['get', 'set'].flatMap((token) => {
            c.budget.spend(group.length);
            const accessors = group.filter((member) => hasToken(member, token));
            return accessors.length > 1 ? accessors : [];
          });
    for (const member of conflicts) c.error(memberNameNode(member), `${name} はすでに宣言されています。`);
  }
}

function isMethodMember(member: TreeNode): boolean {
  return overloadableMethodTypes.has(member.type) && !isAccessor(member);
}

/** The instance property declarations of an interface or a class, including a class's parameter properties. */
function propertyDeclarationsOf(c: Checker, declaration: TreeNode): TreeNode[] {
  if (declaration.type === 'interface_declaration') {
    const body = c.typeNodes.interfaceBody(declaration);
    return body ? named(body).filter(isInterfaceProperty) : [];
  }
  const members = named(declaration.childForFieldName('body') ?? declaration);
  const parameters = c.classes.constructorNode(declaration)?.childForFieldName('parameters');
  return [
    ...members.filter(
      (member) =>
        (member.type === 'field_definition' ||
          (member.type === 'method_definition' && !isConstructorName(member.childForFieldName('name')))) &&
        !hasToken(member, 'static') &&
        !hasPrivateName(member)
    ),
    ...(parameters ? named(parameters).filter(isParameterProperty) : []),
  ];
}

function isInterfaceProperty(member: TreeNode): boolean {
  return member.type === 'property_signature' || member.type === 'method_signature';
}

function isComputed(member: TreeNode): boolean {
  return member.childForFieldName('name')?.type === 'computed_property_name';
}

function checkMergedProperty(c: Checker, member: TreeNode, seen: Map<string, TreeNode>): void {
  const name = memberName(c, member);
  if (name === undefined) return;
  const previous = seen.get(name);
  if (!previous) {
    seen.set(name, member);
    return;
  }
  if (isAccessor(member)) return;
  const modifiersDiffer = ['?', 'readonly'].some(
    (modifier) => hasToken(previous, modifier) !== hasToken(member, modifier)
  );
  if (modifiersDiffer) {
    for (const declaration of isAccessor(previous) ? [member] : [previous, member])
      c.error(memberNameNode(declaration), `プロパティ ${name} の宣言の修飾子は同じでなければいけません。`);
  }
  const before = declaredPropertyType(c, previous, name);
  const after = declaredPropertyType(c, member, name);
  if (before && after && !c.relations.identical(before, after)) {
    // TypeScript words the error for a parameter property as it does for a variable.
    const kind = member.type === 'field_definition' || member.type === 'property_signature' ? 'プロパティ' : '変数';
    c.error(
      memberNameNode(member),
      `後の${kind}の宣言は、同じ型でなければいけません。${kind} ${name} の型は '${c.print(before)}' ですが、ここでは '${c.print(after)}' です。`
    );
  }
}

const overloadableMethodTypes = new Set(['method_signature', 'method_definition']);

/** Reports class members declared twice: fields, method implementations, constructors, and index signatures. */
export function checkDuplicateMembers(c: Checker, body: TreeNode): void {
  checkDuplicateIndexSignatures(
    c,
    named(body).filter((member) => !hasToken(member, 'static'))
  );
  const groups = classMemberGroups();
  for (const member of named(body)) {
    addParameterPropertyDuplicates(member, groups.instance);
    const name = duplicateNameOf(c, member);
    if (name !== undefined) addClassMember(groups, member, name);
  }
  reportDuplicateGroups(c, groups.instance, false);
  reportDuplicateGroups(c, groups.static, true);
  reportDuplicateGroups(c, groups.private, false);
}

function reportDuplicateGroups(c: Checker, groups: Map<string, TreeNode[]>, isStatic: boolean): void {
  for (const [name, members] of groups) {
    if (members.length < 2) continue;
    const accessorPair =
      members.length === 2 &&
      members.every((member) => member.type === 'method_definition') &&
      members.some((member) => hasToken(member, 'get')) &&
      members.some((member) => hasToken(member, 'set'));
    if (!accessorPair) reportDuplicateMembers(c, name, members, isStatic);
  }
}

function addParameterPropertyDuplicates(member: TreeNode, groups: Map<string, TreeNode[]>): void {
  if (!isConstructorName(member.childForFieldName('name'))) return;
  const parameters = member.childForFieldName('parameters');
  for (const parameter of parameters ? named(parameters) : []) {
    if (!isParameterProperty(parameter)) continue;
    const pattern = parameter.childForFieldName('pattern');
    if (!pattern || pattern.type !== 'identifier') continue;
    const group = groups.get(pattern.text) ?? [];
    group.push(parameter);
    groups.set(pattern.text, group);
  }
}

function duplicateNameOf(c: Checker, member: TreeNode): string | undefined {
  if (!['field_definition', 'method_definition'].includes(member.type)) return undefined;
  // A method without a body is an overload signature, and a getter pairs with a setter.
  if (member.type === 'method_definition' && !member.childForFieldName('body')) return undefined;
  return memberName(c, member);
}

function reportDuplicateMembers(c: Checker, name: string, members: TreeNode[], isStatic: boolean): void {
  const isConstructor = name === 'constructor' && !isStatic;
  for (const member of members) {
    const nameNode = member.childForFieldName('name') ?? member.childForFieldName('pattern') ?? member;
    if (isConstructor) c.error(nameNode, 'コンストラクタの実装は1つしか書けません。');
    else if (members.every((other) => other.type === 'method_definition'))
      c.error(nameNode, `メソッド ${name} の実装が重複しています。`);
    else c.error(nameNode, `${name} はすでに宣言されています。`);
  }
}

/**
 * Reports the members of one interface or object type body that declare a name twice, at each of them, except the
 * overloads of a method and a getter with a setter, which TypeScript allows.
 */
export function checkTypeMemberDuplicates(c: Checker, body: TreeNode): void {
  const byName = new Map<string, TreeNode[]>();
  for (const member of named(body)) {
    const name = memberName(c, member);
    if (name === undefined) continue;
    byName.set(name, [...(byName.get(name) ?? []), member]);
  }
  for (const [name, members] of byName) {
    if (members.length < 2 || isAllowedRedeclaration(members)) continue;
    for (const member of members) {
      c.error(member.childForFieldName('name') ?? member, `${name} はすでに宣言されています。`);
    }
  }
}

/**
 * Reports the declarations of one method that differ from the others in being optional, at each one that differs from
 * the implementation, or from the first declaration when there is none.
 */
export function checkOverloadOptionality(c: Checker, body: TreeNode): void {
  const groups = classMemberGroups();
  for (const member of named(body)) {
    if (!overloadableMethodTypes.has(member.type) || isAccessor(member)) continue;
    const name = memberName(c, member);
    if (name === undefined) continue;
    addClassMember(groups, member, name);
  }
  for (const declarations of [...groups.instance.values(), ...groups.static.values(), ...groups.private.values()]) {
    const canonical = declarations.find((declaration) => declaration.childForFieldName('body')) ?? declarations[0];
    for (const declaration of declarations) {
      if (hasToken(declaration, '?') !== hasToken(canonical, '?'))
        c.error(
          memberNameNode(declaration),
          'オーバーロードは、すべて省略可能にするか、すべて省略不可にしてください。'
        );
    }
  }
}

function classMemberGroups(): Record<'instance' | 'static' | 'private', Map<string, TreeNode[]>> {
  return { instance: new Map(), static: new Map(), private: new Map() };
}

function addClassMember(groups: ReturnType<typeof classMemberGroups>, member: TreeNode, name: string): void {
  const byName = hasPrivateName(member) ? groups.private : hasToken(member, 'static') ? groups.static : groups.instance;
  const group = byName.get(name) ?? [];
  group.push(member);
  byName.set(name, group);
}

function hasPrivateName(member: TreeNode): boolean {
  return member.childForFieldName('name')?.type === 'private_property_identifier';
}

function isAccessor(member: TreeNode): boolean {
  return hasToken(member, 'get') || hasToken(member, 'set');
}

function isAllowedRedeclaration(members: TreeNode[]): boolean {
  const getters = members.filter((member) => hasToken(member, 'get')).length;
  const setters = members.filter((member) => hasToken(member, 'set')).length;
  if (getters + setters === members.length) return getters <= 1 && setters <= 1;
  return members.every(
    (member) => member.type === 'method_signature' && !hasToken(member, 'get') && !hasToken(member, 'set')
  );
}

/** A member's property name, with a computed name resolved as the member's type resolves it. */
export function memberName(c: Checker, member: TreeNode): string | undefined {
  // An index signature's `name` is its parameter's, which names no member.
  if (member.type === 'index_signature') return undefined;
  const nameNode = member.childForFieldName('name') ?? member.childForFieldName('pattern');
  const names = nameNode ? c.patterns.propertyNames(nameNode) : undefined;
  return names?.length === 1 ? names[0] : undefined;
}

/** The name of a member, or of a parameter property. */
function memberNameNode(member: TreeNode): TreeNode {
  return member.childForFieldName('name') ?? member.childForFieldName('pattern') ?? member;
}

/** The type a property declaration gives, with `undefined` if it is optional; a class field may infer it. */
function declaredPropertyType(c: Checker, declaration: TreeNode, name: string): Type | undefined {
  if (isAccessor(declaration)) {
    const signature = c.signatures.signatureOf(declaration);
    return hasToken(declaration, 'get') ? signature.returnType() : signature.parameters[0]?.type;
  }
  const annotated = c.typeNodes.annotationType(declaration.childForFieldName('type'));
  const classNode = declaringClassNode(declaration);
  const type =
    declaration.type === 'field_definition'
      ? c.classes.fieldType(declaration, memberNameNode(declaration))
      : (annotated ??
        (classNode ? c.propertyOf(c.classes.classInfoOfNode(classNode).instanceType, name)?.type() : undefined));
  return type && hasToken(declaration, '?') ? unionOf([type, undefinedType]) : type;
}

/** The class declaring a field or a parameter property, or undefined for an interface's property. */
function declaringClassNode(declaration: TreeNode): TreeNode | undefined {
  const body = declaration.type === 'field_definition' ? declaration.parent : declaration.parent?.parent?.parent;
  return body?.type === 'class_body' ? (body.parent ?? undefined) : undefined;
}

/**
 * Reports an interface whose bases declare a property it does not declare itself in ways that are not identical, as
 * TypeScript's `checkInheritedPropertiesAreIdentical` does, returning whether none do.
 */
export function checkInheritedPropertiesAreIdentical(c: Checker, symbol: Sym, nameNode: TreeNode): boolean {
  const bases = c.typeNodes.interfaceBases.baseTypesOf(symbol);
  if (bases.length < 2) return true;
  const own = c.typeNodes.interfaceOwnMembers(symbol.typeDeclarations).properties;
  const inherited = new Map<string, { property: Property; base: Type }>();
  const instance = c.typeNodes.declaredTypeOf(symbol);
  const receiver = instance.kind === 'object' ? instance.thisType : undefined;
  for (const base of bases) {
    // Keys, unlike names, tell apart the `#name` members of different classes.
    for (const [key, property] of c.structureOf(base, receiver).properties) {
      if (own.has(key)) continue;
      const existing = inherited.get(key);
      if (!existing) inherited.set(key, { property, base });
      else if (!arePropertiesIdentical(c, existing.property, property)) {
        c.error(
          nameNode,
          `インターフェース '${c.print(c.typeNodes.declaredTypeOf(symbol))}' は、型 '${c.print(existing.base)}' と '${c.print(base)}' を同時には継承できません。プロパティ '${property.name}' が同一ではありません。`
        );
        return false;
      }
    }
  }
  return true;
}

function arePropertiesIdentical(c: Checker, a: Property, b: Property): boolean {
  if (a === b) return true;
  if (a.visibility !== b.visibility || a.optional !== b.optional || a.readonly !== b.readonly) return false;
  if (a.visibility !== 'public' && a.declaration?.id !== b.declaration?.id) return false;
  const [typeA, typeB] = [a.type(), b.type()];
  return isAnyLike(typeA) === isAnyLike(typeB) && c.relations.identical(typeA, typeB);
}
