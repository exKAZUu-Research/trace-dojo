import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  ClassDeclaration,
  ConstructorDeclaration,
  EnumConstant,
  ExplicitConstructorCall,
  FieldDeclaration,
  MemberDeclaration,
  MethodDeclaration,
  Parameter,
  Span,
  Statement,
  TypeSyntax,
} from './ast';
import { convertArguments } from './parseExpression';
import {
  convertModifiers,
  convertType,
  convertTypeParameters,
  convertVariableType,
  field,
  identifierOf,
  modifiersOf,
  namedChildren,
  span,
  unsupported,
} from './parseNodes';
import { convertBlock, convertDeclarator, convertStatement } from './parseStatement';

export function convertTypeDeclaration(node: Node): ClassDeclaration {
  const permitsNode = node.childForFieldName('permits');
  const kinds = {
    class_declaration: 'class',
    interface_declaration: 'interface',
    record_declaration: 'class',
    annotation_type_declaration: 'interface',
  } as const;
  const kind = kinds[node.type as keyof typeof kinds] ?? ('enum' as const);
  const superclassNode = node.childForFieldName('superclass');
  const interfacesNode =
    node.childForFieldName('interfaces') ?? node.children.find((child) => child?.type === 'extends_interfaces');
  const body = field(node, 'body');
  const enumConstants: EnumConstant[] = [];
  const members: MemberDeclaration[] = [];
  for (const member of namedChildren(body)) {
    if (member.type === 'enum_constant') enumConstants.push(convertEnumConstant(member));
    else if (member.type === 'enum_body_declarations') members.push(...namedChildren(member).map(convertMember));
    else if (member.type === 'compact_constructor_declaration') members.push(convertCompactConstructor(member));
    else if (member.type === 'annotation_type_element_declaration') members.push(convertAnnotationElement(member));
    else members.push(convertMember(member));
  }
  const header = node.type === 'record_declaration' ? field(node, 'parameters') : undefined;
  if (header) desugarRecord(node, header, members);
  return {
    kind,
    name: field(node, 'name').text,
    typeParameters: convertTypeParameters(node.childForFieldName('type_parameters')),
    modifiers: convertModifiers(modifiersOf(node)),
    superclass: superclassNode ? convertType(namedChildren(superclassNode)[0]) : undefined,
    interfaces: interfacesNode ? namedChildren(namedChildren(interfacesNode)[0]).map((type) => convertType(type)) : [],
    enumConstants,
    members,
    isRecord: header !== undefined,
    permits: permitsNode
      ? namedChildren(namedChildren(permitsNode)[0] ?? permitsNode).map((type) => convertType(type))
      : undefined,
    ...span(node),
  };
}

/** An element of an annotation interface, which these programs never read, as an abstract method. */
function convertAnnotationElement(node: Node): MethodDeclaration {
  return {
    kind: 'method',
    name: field(node, 'name').text,
    typeParameters: [],
    modifiers: convertModifiers(modifiersOf(node)),
    returnType: convertVariableType(node),
    parameters: [],
    throwsTypes: [],
    body: undefined,
    ...span(node),
  };
}

/** A compact canonical constructor, whose parameters the record's components give once the record is desugared. */
function convertCompactConstructor(node: Node): ConstructorDeclaration {
  return {
    kind: 'constructor',
    name: field(node, 'name').text,
    modifiers: convertModifiers(modifiersOf(node)),
    parameters: [],
    throwsTypes: [],
    explicitCall: undefined,
    body: convertBlock(field(node, 'body')),
    isCompact: true,
    ...span(node),
  };
}

/**
 * Writes out what a record declares implicitly: a private final field and a public accessor for each component, and
 * the canonical constructor, which a compact constructor's body begins.
 */
function desugarRecord(node: Node, header: Node, members: MemberDeclaration[]): void {
  const where = span(header);
  const componentNodes = namedChildren(header);
  const components = componentNodes.map((component, index) => {
    const typeNode = field(component, 'type');
    const isVarargs = component.children.some((child) => child?.type === '...');
    if (isVarargs && index !== componentNodes.length - 1) throw varargsNotLastError(component);
    const type = convertType(typeNode);
    return {
      name: field(component, 'name').text,
      type: isVarargs ? ({ kind: 'array', element: type, ...span(typeNode) } as const) : type,
      isFinal: false,
      isVarargs,
      ...span(component),
    };
  });
  const instanceField = members.find((member) => member.kind === 'field' && !member.modifiers.isStatic);
  if (instanceField) {
    throw new CompileError([
      { row: instanceField.row, message: 'レコードには static でないフィールドを宣言できません。' },
    ]);
  }
  const fields: FieldDeclaration[] = components.map((component) => ({
    kind: 'field',
    isRecordComponent: true,
    modifiers: { isStatic: false, isFinal: true, isAbstract: false, isDefault: false, access: 'private' },
    type: component.type,
    declarators: [{ name: component.name, extraDimensions: 0, initializer: undefined, ...spanOf(component) }],
    ...spanOf(component),
  }));
  const assignments: Statement[] = components.map((component) => ({
    kind: 'expression',
    isGenerated: true,
    expression: {
      kind: 'assign',
      operator: '=',
      target: { kind: 'fieldAccess', object: { kind: 'this', ...where }, name: component.name, ...where },
      value: { kind: 'name', name: component.name, ...where },
      ...where,
    },
    ...where,
  }));
  const isCanonical = (member: MemberDeclaration): boolean =>
    member.kind === 'constructor' &&
    !member.isCompact &&
    member.parameters.length === components.length &&
    member.parameters.every((parameter, index) => sameTypeSyntax(parameter.type, components[index].type));
  const compactIndex = members.findIndex((member) => member.kind === 'constructor' && member.isCompact);
  if (compactIndex !== -1) {
    const compact = members[compactIndex] as ConstructorDeclaration;
    members[compactIndex] = {
      ...compact,
      parameters: components,
      body: { ...compact.body, statements: [...compact.body.statements, ...assignments] },
    };
  } else if (!members.some(isCanonical)) {
    const name = field(node, 'name').text;
    members.push({
      kind: 'constructor',
      name,
      modifiers: { ...convertModifiers(modifiersOf(node)), isFinal: false, isStatic: false, access: 'public' },
      parameters: components,
      throwsTypes: [],
      explicitCall: undefined,
      body: { kind: 'block', statements: assignments, ...where },
      ...where,
    });
  }
  for (const component of components) {
    const declared = members.some(
      (member) => member.kind === 'method' && member.name === component.name && member.parameters.length === 0
    );
    if (declared) continue;
    members.push({
      kind: 'method',
      name: component.name,
      typeParameters: [],
      modifiers: { isStatic: false, isFinal: false, isAbstract: false, isDefault: false, access: 'public' },
      returnType: component.type,
      parameters: [],
      throwsTypes: [],
      body: {
        kind: 'block',
        statements: [
          {
            kind: 'return',
            value: { kind: 'fieldAccess', object: { kind: 'this', ...where }, name: component.name, ...where },
            ...where,
          },
        ],
        ...where,
      },
      ...where,
    });
  }
  members.unshift(...fields);
}

function spanOf(value: Span): Span {
  return { row: value.row, endRow: value.endRow, start: value.start, end: value.end };
}

function sameTypeSyntax(a: TypeSyntax, b: TypeSyntax): boolean {
  return withoutSpans(a) === withoutSpans(b);
}

function withoutSpans(type: TypeSyntax): string {
  return JSON.stringify(type, (key, value: unknown) =>
    ['row', 'endRow', 'start', 'end'].includes(key) ? undefined : value
  );
}

function convertEnumConstant(node: Node): EnumConstant {
  const args = node.childForFieldName('arguments');
  const body = node.childForFieldName('body');
  return {
    name: field(node, 'name').text,
    args: args ? convertArguments(args) : [],
    body: body ? namedChildren(body).map((member) => convertMember(member)) : undefined,
    ...span(node),
  };
}

/** A field or method of a compact source file, whose fields tree-sitter parses as declarations of local variables. */
export function convertTopLevelMember(member: Node): MemberDeclaration {
  return member.type === 'local_variable_declaration' ? convertField(member) : convertMember(member);
}

export function convertMember(member: Node): MemberDeclaration {
  switch (member.type) {
    case 'field_declaration':
    case 'constant_declaration': {
      return convertField(member);
    }
    case 'method_declaration': {
      return convertMethod(member);
    }
    case 'constructor_declaration': {
      return convertConstructor(member);
    }
    case 'block': {
      return { kind: 'initializer', isStatic: false, body: convertBlock(member), ...span(member) };
    }
    case 'static_initializer': {
      return { kind: 'initializer', isStatic: true, body: convertBlock(namedChildren(member)[0]), ...span(member) };
    }
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'record_declaration':
    case 'annotation_type_declaration': {
      return convertTypeDeclaration(member);
    }
    default: {
      return unsupported(member, `クラスの中の「${member.type}」`);
    }
  }
}

function convertField(node: Node): FieldDeclaration {
  const type = convertType(field(node, 'type'));
  return {
    kind: 'field',
    modifiers: convertModifiers(modifiersOf(node)),
    type,
    declarators: node.childrenForFieldName('declarator').map((declarator) => convertDeclarator(declarator)),
    ...span(node),
  };
}

function convertParameters(node: Node): Parameter[] {
  const parameters = namedChildren(node);
  return parameters.map((parameter, index) => {
    if (parameter.type === 'spread_parameter') {
      if (index !== parameters.length - 1) throw varargsNotLastError(parameter);
      return convertVarargsParameter(parameter);
    }
    if (parameter.type !== 'formal_parameter') unsupported(parameter, '受け取りパラメータ');
    const modifiers = convertModifiers(modifiersOf(parameter));
    const type = convertVariableType(parameter);
    const name = identifierOf(parameter, '名前のない引数');
    return { name: name.text, type, isFinal: modifiers.isFinal, isVarargs: false, ...span(parameter) };
  });
}

function varargsNotLastError(node: Node): CompileError {
  return new CompileError([{ row: node.startPosition.row, message: '可変長引数は最後の引数にしか使えません。' }]);
}

/** Converts `int... values`, whose variable holds the arguments as an array. */
export function convertVarargsParameter(parameter: Node): Parameter {
  const modifiers = convertModifiers(modifiersOf(parameter));
  const parts = namedChildren(parameter).filter((child) => child.type !== 'modifiers');
  const [typeNode, nameNode] = parts;
  const declarator = nameNode.type === 'variable_declarator' ? field(nameNode, 'name') : nameNode;
  const element = convertType(typeNode);
  return {
    name: declarator.text,
    type: { kind: 'array', element, ...span(typeNode) },
    isFinal: modifiers.isFinal,
    isVarargs: true,
    ...span(parameter),
  };
}

function convertThrows(node: Node): TypeSyntax[] {
  const throwsNode = node.children.find((child) => child?.type === 'throws');
  return throwsNode ? namedChildren(throwsNode).map((type) => convertType(type)) : [];
}

function convertMethod(node: Node): MethodDeclaration {
  if (node.childForFieldName('dimensions')) unsupported(node, 'メソッド名の後ろの []');
  const typeNode = field(node, 'type');
  const body = node.childForFieldName('body');
  return {
    kind: 'method',
    name: field(node, 'name').text,
    typeParameters: convertTypeParameters(node.childForFieldName('type_parameters')),
    modifiers: convertModifiers(modifiersOf(node)),
    returnType: typeNode.type === 'void_type' ? undefined : convertType(typeNode),
    parameters: convertParameters(field(node, 'parameters')),
    throwsTypes: convertThrows(node),
    body: body ? convertBlock(body) : undefined,
    ...span(node),
  };
}

function convertConstructor(node: Node): ConstructorDeclaration {
  const typeParameters = node.childForFieldName('type_parameters');
  const bodyNode = field(node, 'body');
  let statements: Statement[] = [];
  let prologue: Statement[] | undefined;
  let explicitCall: ExplicitConstructorCall | undefined;
  for (const child of namedChildren(bodyNode)) {
    if (child.type === 'explicit_constructor_invocation') {
      if (explicitCall) unsupported(child, '2 つ目の this(...) や super(...)');
      explicitCall = convertExplicitConstructorCall(child);
      if (statements.length > 0) prologue = statements;
      statements = [];
    } else {
      statements.push(convertStatement(child));
    }
  }
  return {
    kind: 'constructor',
    name: field(node, 'name').text,
    ...(typeParameters && { typeParameters: convertTypeParameters(typeParameters) }),
    modifiers: convertModifiers(modifiersOf(node)),
    parameters: convertParameters(field(node, 'parameters')),
    throwsTypes: convertThrows(node),
    explicitCall,
    prologue,
    body: { kind: 'block', statements, ...span(bodyNode) },
    ...span(node),
  };
}

function convertExplicitConstructorCall(node: Node): ExplicitConstructorCall {
  if (node.childForFieldName('object')) unsupported(node, '修飾された super(...)');
  return {
    kind: 'explicitConstructorCall',
    target: field(node, 'constructor').type === 'this' ? 'this' : 'super',
    args: convertArguments(field(node, 'arguments')),
    ...span(node),
  };
}
