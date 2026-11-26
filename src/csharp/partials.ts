import type {
  ConstructorDeclaration,
  EventAccessorDeclaration,
  EventFieldDeclaration,
  MemberDeclaration,
  MethodDeclaration,
  Modifier,
  Parameter,
  Position,
  PropertyDeclaration,
  TypeDeclaration,
  TypeNode,
} from './ast';

type Report = (position: Position | number, code: string, message: string) => void;

const ACCESS_MODIFIERS: readonly Modifier[] = ['public', 'private', 'protected', 'internal'];

/**
 * Adds a later part of a partial type to the first part, as C# spec §15.2.7 joins them: the members and the base types
 * of every part, and the modifiers and constraints that any part writes. The first part's names resolve the members of
 * every part, which differs from Roslyn only when the parts sit in namespace blocks with different usings.
 */
export function joinPartialType(first: TypeDeclaration, part: TypeDeclaration, report: Report): void {
  const display = first.name;
  if (first.typeKind !== part.typeKind || first.isRecord !== part.isRecord) {
    report(
      part,
      'CS0261',
      `'${display}' の部分宣言は、すべてのクラス、すべてのレコード クラス、すべての構造体、すべての共用体、すべてのレコード構造体、またはすべてのインターフェイスである必要があります`
    );
    return;
  }
  const firstAccess = ACCESS_MODIFIERS.filter((modifier) => first.modifiers.set.has(modifier)).join(' ');
  const partAccess = ACCESS_MODIFIERS.filter((modifier) => part.modifiers.set.has(modifier)).join(' ');
  if (firstAccess && partAccess && firstAccess !== partAccess)
    report(first, 'CS0262', `'${display}' の partial 宣言には競合するアクセシビリティ修飾子が含まれています`);
  if (
    first.typeParameters.length !== part.typeParameters.length ||
    first.typeParameters.some((parameter, index) => parameter.name !== part.typeParameters[index].name)
  )
    report(
      first,
      'CS0264',
      `'${display}${first.typeParameters.length > 0 ? `<${first.typeParameters.map((parameter) => parameter.name).join(', ')}>` : ''}' の partial 宣言では、同じ型パラメーター名を同じ順序で指定しなければなりません`
    );
  const set = new Set(first.modifiers.set);
  const positions = new Map(first.modifiers.positions);
  for (const modifier of part.modifiers.set) {
    set.add(modifier);
    if (!positions.has(modifier)) positions.set(modifier, part.modifiers.positions.get(modifier) as Position);
  }
  first.modifiers = { set, positions };
  for (const base of part.bases) if (!first.bases.some((other) => sameTypeNode(other, base))) first.bases.push(base);
  if (first.constraints.length === 0) first.constraints = part.constraints;
  first.primaryParameters ??= part.primaryParameters;
  first.baseArguments ??= part.baseArguments;
  first.members.push(...part.members);
}

/**
 * Joins the defining and the implementing declarations of a type's partial methods, properties, indexers, events, and
 * constructors into the implementing one (C# spec §15.6.9, C# 14). A partial method that only has its definition and
 * returns void without an access modifier stays, without a body, as one whose calls are removed.
 */
export function joinPartialMembers(owner: TypeDeclaration, report: Report): void {
  const isPartialType = owner.modifiers.set.has('partial');
  const groups = new Map<string, PartialMember[]>();
  const laterGroups = new Map<string, LaterPartialMember[]>();
  const joined: MemberDeclaration[] = [];
  for (const member of owner.members) {
    if (isLaterPartialMember(member)) {
      for (const part of splitEvents(member)) addLaterPartial(owner, part, isPartialType, laterGroups, joined, report);
      continue;
    }
    if ((member.kind !== 'method' && member.kind !== 'property') || !member.modifiers.set.has('partial')) {
      joined.push(member);
      continue;
    }
    if (!isPartialType) {
      reportOutsidePartialType(owner, member, report);
      joined.push(member);
      continue;
    }
    const key = memberKey(member);
    const group = groups.get(key);
    if (group) group.push(member);
    else {
      groups.set(key, [member]);
      joined.push(member);
    }
  }
  for (const group of groups.values()) joined[joined.indexOf(group[0])] = joinGroup(owner, group, report);
  const duplicates: LaterPartialMember[] = [];
  for (const group of laterGroups.values())
    joined[joined.indexOf(group[0])] = joinLaterGroup(owner, group, duplicates, report);
  // Roslyn reports a repeated part as a repeated member once it has checked every partial member's parts.
  for (const duplicate of duplicates) {
    if (duplicate.kind === 'constructor')
      report(
        duplicate,
        'CS0111',
        `型 '${owner.name}' は、'${owner.name}' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
      );
    else report(duplicate, 'CS0102', `型 '${owner.name}' は既に '${laterName(duplicate)}' の定義を含んでいます`);
  }
  owner.members = joined;
}

/** A partial event (a field-like definition and an implementation with accessors) or constructor, which C# 14 adds. */
type LaterPartialMember = ConstructorDeclaration | EventFieldDeclaration | EventAccessorDeclaration;

function isLaterPartialMember(member: MemberDeclaration): member is LaterPartialMember {
  return (
    (member.kind === 'constructor' || member.kind === 'event' || member.kind === 'eventAccessors') &&
    member.modifiers.set.has('partial')
  );
}

/** A partial field-like event declares one partial event per name, `partial event Action A, B;` two. */
function splitEvents(member: LaterPartialMember): LaterPartialMember[] {
  if (member.kind !== 'event' || member.declarators.length === 1) return [member];
  return member.declarators.map((declarator) => ({ ...member, declarators: [declarator] }));
}

function addLaterPartial(
  owner: TypeDeclaration,
  member: LaterPartialMember,
  isPartialType: boolean,
  groups: Map<string, LaterPartialMember[]>,
  joined: MemberDeclaration[],
  report: Report
): void {
  const display = laterDisplay(owner, member);
  if (member.kind === 'event' && member.declarators[0].initializer)
    report(member, 'CS9279', `'${display}': 部分的イベントには初期化子を持たせることができません`);
  if (!isPartialType) {
    // Roslyn reports a constructor's missing part before, and an event's after, its partial type's absence.
    const isDefinition = !hasLaterBody(member);
    if (member.kind === 'constructor' && isDefinition) reportMissingImplementation(member, display, report);
    report(member, 'CS0751', '部分メンバーは、部分型内で宣言される必要があります');
    if (member.kind !== 'constructor' && isDefinition) reportMissingImplementation(member, display, report);
    joined.push(member);
    return;
  }
  const key =
    member.kind === 'constructor' ? `constructor(${parameterText(member.parameters)})` : `event ${laterName(member)}`;
  const group = groups.get(key);
  if (group) group.push(member);
  else {
    groups.set(key, [member]);
    joined.push(member);
  }
}

/** The one member that a partial event's or constructor's declarations join into, reporting what is missing or repeated. */
function joinLaterGroup(
  owner: TypeDeclaration,
  group: LaterPartialMember[],
  duplicates: LaterPartialMember[],
  report: Report
): MemberDeclaration {
  const display = laterDisplay(owner, group[0]);
  const definitions = group.filter((member) => !hasLaterBody(member));
  const implementations = group.filter((member) => hasLaterBody(member));
  for (const duplicate of definitions.slice(1))
    report(duplicate, 'CS9277', `部分的メンバー '${display}' には、複数の定義宣言を指定することはできません。`);
  for (const duplicate of implementations.slice(1))
    report(duplicate, 'CS9278', `部分的メンバー '${display}' には、複数の実装宣言を含めないでください。`);
  duplicates.push(...definitions.slice(1), ...implementations.slice(1));
  const [definition] = definitions;
  const [implementation] = implementations;
  if (definition?.kind === 'constructor' && definition.initializer)
    report(definition, 'CS9280', `'${display}': 部分コンストラクターの実装宣言のみが初期化子を持つことができます`);
  if (!implementation) {
    reportMissingImplementation(definition as LaterPartialMember, display, report);
    return definition as LaterPartialMember;
  }
  if (!definition) report(implementation, 'CS9276', `部分的メンバー '${display}' には定義パーツが必要です。`);
  return implementation;
}

function reportMissingImplementation(member: LaterPartialMember, display: string, report: Report): void {
  report(member, 'CS9275', `部分的メンバー '${display}' には実装部分が必要です。`);
}

function hasLaterBody(member: LaterPartialMember): boolean {
  if (member.kind === 'constructor') return member.body !== undefined;
  return member.kind === 'eventAccessors';
}

function laterName(member: LaterPartialMember): string {
  return member.kind === 'event' ? member.declarators[0].name : member.name;
}

function laterDisplay(owner: TypeDeclaration, member: LaterPartialMember): string {
  if (member.kind === 'constructor') return `${owner.name}.${owner.name}(${parameterText(member.parameters)})`;
  return `${owner.name}.${laterName(member)}`;
}

type PartialMember = MethodDeclaration | PropertyDeclaration;

/** A partial member of a type that is not partial (CS0751), which stays as it is written. */
function reportOutsidePartialType(owner: TypeDeclaration, member: PartialMember, report: Report): void {
  if (member.kind === 'property' && !hasBody(member))
    report(member, 'CS9248', `部分プロパティ '${owner.name}.${member.name}' には実装パーツが必要です。`);
  report(member, 'CS0751', '部分メンバーは、部分型内で宣言される必要があります');
  if (member.kind === 'method' && !member.body) member.isRemovedPartial = true;
}

/** The one member that the declarations of a partial member join into, reporting what is missing or repeated. */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one case of the C# rule that the function applies.
function joinGroup(owner: TypeDeclaration, group: PartialMember[], report: Report): MemberDeclaration {
  const [first] = group;
  const display = `${owner.name}.${first.name}${first.kind === 'method' ? `(${parameterText(first.parameters)})` : ''}`;
  const definitions = group.filter((member) => !hasBody(member));
  const implementations = group.filter((member) => hasBody(member));
  if (definitions.length > 1 || implementations.length > 1)
    reportDuplicate(
      owner,
      first,
      (definitions.length > 1 ? definitions[1] : implementations[1]) as PartialMember,
      report
    );
  const [definition] = definitions;
  const [implementation] = implementations;
  if (!definition) {
    report(
      implementation as MemberDeclaration,
      'CS0759',
      `部分メソッド '${display}' の実装宣言に対する定義宣言が見つかりませんでした`
    );
    return implementation as MemberDeclaration;
  }
  const hasAccess = ACCESS_MODIFIERS.some((modifier) => definition.modifiers.set.has(modifier));
  if (!implementation) {
    if (definition.kind === 'property' || hasAccess)
      report(
        definition,
        definition.kind === 'property' ? 'CS9248' : 'CS8795',
        definition.kind === 'property'
          ? `部分プロパティ '${display}' には実装パーツが必要です。`
          : `部分メソッド '${display}' にはアクセシビリティ修飾子があるため、実装部分が必要です。`
      );
    else reportNonVoidWithoutAccess(definition, display, report);
    if (definition.kind === 'method') definition.isRemovedPartial = true;
    return definition;
  }
  if (!hasAccess) reportNonVoidWithoutAccess(definition, display, report);
  return implementation;
}

function reportDuplicate(owner: TypeDeclaration, first: PartialMember, duplicate: PartialMember, report: Report): void {
  if (first.kind !== 'method') {
    report(duplicate, 'CS0102', `型 '${owner.name}' は既に '${first.name}' の定義を含んでいます`);
    return;
  }
  report(duplicate, 'CS0756', '部分メソッドには、複数の定義宣言を指定することはできません');
  report(
    duplicate,
    'CS0111',
    `型 '${owner.name}' は、'${first.name}' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
  );
}

/** A partial method without an access modifier must return void (CS8796). */
function reportNonVoidWithoutAccess(definition: PartialMember, display: string, report: Report): void {
  if (definition.kind === 'method' && !isVoid(definition.returnType))
    report(
      definition,
      'CS8796',
      `部分メソッド '${display}' には、void 以外の戻り値の型が指定されているため、アクセシビリティ修飾子が必要です。`
    );
}

function hasBody(member: MethodDeclaration | PropertyDeclaration): boolean {
  if (member.kind === 'method') return member.body !== undefined;
  return member.accessors.some((accessor) => accessor.body !== undefined);
}

function isVoid(type: TypeNode): boolean {
  return type.kind === 'predefinedType' && type.name === 'void';
}

function memberKey(member: MethodDeclaration | PropertyDeclaration): string {
  if (member.kind === 'property') return `property ${member.name}`;
  return `method ${member.name}\`${member.typeParameters.length}(${member.parameters
    .map((parameter) => `${parameter.modifier ?? ''} ${typeNodeKey(parameter.type)}`)
    .join(',')})`;
}

function parameterText(parameters: Parameter[]): string {
  return parameters.map((parameter) => typeNodeKey(parameter.type)).join(', ');
}

function sameTypeNode(a: TypeNode, b: TypeNode): boolean {
  return typeNodeKey(a) === typeNodeKey(b);
}

/** A type as written, without positions, which tells two declarations' types apart before they are resolved. */
function typeNodeKey(node: TypeNode | undefined): string {
  if (!node) return '';
  switch (node.kind) {
    case 'predefinedType': {
      return node.name;
    }
    case 'refType': {
      return `ref ${node.isReadonly ? 'readonly ' : ''}${typeNodeKey(node.type)}`;
    }
    case 'pointerType': {
      return `${typeNodeKey(node.element)}*`;
    }
    case 'functionPointerType': {
      return `delegate*<${[...node.parameters, node.returnType].map((part) => typeNodeKey(part)).join(',')}>`;
    }
    case 'namedType': {
      return node.typeArgs ? `${node.name}<${node.typeArgs.map(typeNodeKey).join(', ')}>` : node.name;
    }
    case 'qualifiedType': {
      const name = node.typeArgs ? `${node.name}<${node.typeArgs.map(typeNodeKey).join(', ')}>` : node.name;
      return `${typeNodeKey(node.left)}.${name}`;
    }
    case 'aliasQualifiedType': {
      const name = node.typeArgs ? `${node.name}<${node.typeArgs.map(typeNodeKey).join(', ')}>` : node.name;
      return `${node.alias}::${name}`;
    }
    case 'arrayType': {
      return `${typeNodeKey(node.element)}[${','.repeat(node.rank - 1)}]`;
    }
    case 'nullableType': {
      return `${typeNodeKey(node.inner)}?`;
    }
    case 'tupleType': {
      return `(${node.elements.map((element) => typeNodeKey(element.type)).join(', ')})`;
    }
    case 'varType': {
      return 'var';
    }
  }
}
