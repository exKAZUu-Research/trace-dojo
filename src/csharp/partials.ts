import type {
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
 * Joins the defining and the implementing declarations of a type's partial methods, properties, and indexers into the
 * implementing one (C# spec §15.6.9). A partial method that only has its definition and returns void without an access
 * modifier stays, without a body, as one whose calls are removed.
 */
// code-gauge-allow functionCognitiveComplexity -- Each branch handles one rule of partial members.
export function joinPartialMembers(owner: TypeDeclaration, report: Report): void {
  const isPartialType = owner.modifiers.set.has('partial');
  const groups = new Map<string, (MethodDeclaration | PropertyDeclaration)[]>();
  const joined: MemberDeclaration[] = [];
  for (const member of owner.members) {
    if ((member.kind !== 'method' && member.kind !== 'property') || !member.modifiers.set.has('partial')) {
      joined.push(member);
      continue;
    }
    if (!isPartialType) {
      if (member.kind === 'property' && !hasBody(member))
        report(member, 'CS9248', `部分プロパティ '${owner.name}.${member.name}' には実装パーツが必要です。`);
      report(member, 'CS0751', '部分メンバーは、部分型内で宣言される必要があります');
      if (member.kind === 'method' && !member.body) member.isRemovedPartial = true;
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
  for (const [, group] of groups) {
    const index = joined.indexOf(group[0]);
    const display = `${owner.name}.${group[0].name}${group[0].kind === 'method' ? `(${parameterText(group[0].parameters)})` : ''}`;
    const definitions = group.filter((member) => !hasBody(member));
    const implementations = group.filter((member) => hasBody(member));
    if (definitions.length > 1 || implementations.length > 1) {
      const duplicate = (definitions.length > 1 ? definitions[1] : implementations[1]) as MemberDeclaration;
      if (group[0].kind === 'method') {
        report(duplicate, 'CS0756', '部分メソッドには、複数の定義宣言を指定することはできません');
        report(
          duplicate,
          'CS0111',
          `型 '${owner.name}' は、'${group[0].name}' と呼ばれるメンバーを同じパラメーターの型で既に定義しています`
        );
      } else report(duplicate, 'CS0102', `型 '${owner.name}' は既に '${group[0].name}' の定義を含んでいます`);
    }
    const [definition] = definitions;
    const [implementation] = implementations;
    if (!definition) {
      report(
        implementation as MemberDeclaration,
        'CS0759',
        `部分メソッド '${display}' の実装宣言に対する定義宣言が見つかりませんでした`
      );
      joined[index] = implementation as MemberDeclaration;
      continue;
    }
    if (!implementation) {
      if (definition.kind === 'property' || ACCESS_MODIFIERS.some((modifier) => definition.modifiers.set.has(modifier)))
        report(
          definition,
          definition.kind === 'property' ? 'CS9248' : 'CS8795',
          definition.kind === 'property'
            ? `部分プロパティ '${display}' には実装パーツが必要です。`
            : `部分メソッド '${display}' にはアクセシビリティ修飾子があるため、実装部分が必要です。`
        );
      else if (definition.kind === 'method' && !isVoid(definition.returnType))
        report(
          definition,
          'CS8796',
          `部分メソッド '${display}' には、void 以外の戻り値の型が指定されているため、アクセシビリティ修飾子が必要です。`
        );
      if (definition.kind === 'method') definition.isRemovedPartial = true;
      joined[index] = definition;
      continue;
    }
    if (
      definition.kind === 'method' &&
      !ACCESS_MODIFIERS.some((modifier) => definition.modifiers.set.has(modifier)) &&
      !isVoid(definition.returnType)
    )
      report(
        definition,
        'CS8796',
        `部分メソッド '${display}' には、void 以外の戻り値の型が指定されているため、アクセシビリティ修飾子が必要です。`
      );
    joined[index] = implementation;
  }
  owner.members = joined;
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
