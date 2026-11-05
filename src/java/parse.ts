import type { Node } from '@willbooster/web-tree-sitter';

import { loadParser, parseSource } from '../interpreter/treeSitter';
import type {
  ClassDeclaration,
  CompilationUnit,
  ConstructorDeclaration,
  EnumConstant,
  ExplicitConstructorCall,
  FieldDeclaration,
  MemberDeclaration,
  MethodDeclaration,
  Parameter,
  Statement,
  TypeSyntax,
} from './ast';
import { convertArguments } from './parseExpression';
import {
  convertModifiers,
  convertType,
  convertVariableType,
  field,
  identifierOf,
  modifiersOf,
  namedChildren,
  span,
  unsupported,
} from './parseNodes';
import { convertBlock, convertDeclarator, convertStatement } from './parseStatement';

const parser = await loadParser('@willbooster/tree-sitter-java/tree-sitter-java.wasm');

/** Parses a compilation unit, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseJava(source: string): CompilationUnit {
  return parseSource(parser, source, { identifier: '名前' }, convertProgram);
}

function convertProgram(root: Node): CompilationUnit {
  const classes: ClassDeclaration[] = [];
  for (const child of namedChildren(root)) {
    switch (child.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration': {
        classes.push(convertTypeDeclaration(child));
        break;
      }
      // Problems show several files in one listing, so package and import lines may appear between classes.
      case 'package_declaration':
      case 'import_declaration': {
        break;
      }
      case 'record_declaration': {
        unsupported(child, 'レコード');
        break;
      }
      default: {
        unsupported(child, 'クラスの外に書いた文や宣言');
      }
    }
  }
  return { classes };
}

function convertTypeDeclaration(node: Node): ClassDeclaration {
  if (node.childForFieldName('type_parameters')) unsupported(node, '型パラメータ');
  if (node.childForFieldName('permits')) unsupported(node, 'permits');
  const kind =
    ({ class_declaration: 'class', interface_declaration: 'interface' } as const)[node.type as 'class_declaration'] ??
    ('enum' as const);
  const superclassNode = node.childForFieldName('superclass');
  const interfacesNode =
    node.childForFieldName('interfaces') ?? node.children.find((child) => child?.type === 'extends_interfaces');
  const body = field(node, 'body');
  const enumConstants: EnumConstant[] = [];
  const members: MemberDeclaration[] = [];
  for (const member of namedChildren(body)) {
    if (member.type === 'enum_constant') enumConstants.push(convertEnumConstant(member));
    else if (member.type === 'enum_body_declarations') members.push(...namedChildren(member).map(convertMember));
    else members.push(convertMember(member));
  }
  return {
    kind,
    name: field(node, 'name').text,
    modifiers: convertModifiers(modifiersOf(node)),
    superclass: superclassNode ? convertType(namedChildren(superclassNode)[0]) : undefined,
    interfaces: interfacesNode ? namedChildren(namedChildren(interfacesNode)[0]).map((type) => convertType(type)) : [],
    enumConstants,
    members,
    ...span(node),
  };
}

function convertEnumConstant(node: Node): EnumConstant {
  if (modifiersOf(node)) unsupported(node, '列挙定数へのアノテーション');
  if (node.childForFieldName('body')) unsupported(node, '本体を持つ列挙定数');
  const args = node.childForFieldName('arguments');
  return { name: field(node, 'name').text, args: args ? convertArguments(args) : [], ...span(node) };
}

function convertMember(member: Node): MemberDeclaration {
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
    case 'enum_declaration': {
      return convertTypeDeclaration(member);
    }
    case 'record_declaration': {
      return unsupported(member, 'レコード');
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
  return namedChildren(node).map((parameter) => {
    if (parameter.type !== 'formal_parameter') unsupported(parameter, '可変長引数や受け取りパラメータ');
    const modifiers = convertModifiers(modifiersOf(parameter));
    const type = convertVariableType(parameter);
    const name = identifierOf(parameter, '名前のない引数');
    return { name: name.text, type, isFinal: modifiers.isFinal, ...span(parameter) };
  });
}

function convertThrows(node: Node): TypeSyntax[] {
  const throwsNode = node.children.find((child) => child?.type === 'throws');
  return throwsNode ? namedChildren(throwsNode).map((type) => convertType(type)) : [];
}

function convertMethod(node: Node): MethodDeclaration {
  if (node.childForFieldName('type_parameters')) unsupported(node, '型パラメータ');
  if (node.childForFieldName('dimensions')) unsupported(node, 'メソッド名の後ろの []');
  const typeNode = field(node, 'type');
  const body = node.childForFieldName('body');
  return {
    kind: 'method',
    name: field(node, 'name').text,
    modifiers: convertModifiers(modifiersOf(node)),
    returnType: typeNode.type === 'void_type' ? undefined : convertType(typeNode),
    parameters: convertParameters(field(node, 'parameters')),
    throwsTypes: convertThrows(node),
    body: body ? convertBlock(body) : undefined,
    ...span(node),
  };
}

function convertConstructor(node: Node): ConstructorDeclaration {
  if (node.childForFieldName('type_parameters')) unsupported(node, '型パラメータ');
  const bodyNode = field(node, 'body');
  const statements: Statement[] = [];
  let explicitCall: ExplicitConstructorCall | undefined;
  for (const [index, child] of namedChildren(bodyNode).entries()) {
    if (child.type === 'explicit_constructor_invocation') {
      if (index !== 0) unsupported(child, 'コンストラクタの先頭以外での this(...) や super(...)');
      explicitCall = convertExplicitConstructorCall(child);
    } else {
      statements.push(convertStatement(child));
    }
  }
  return {
    kind: 'constructor',
    name: field(node, 'name').text,
    modifiers: convertModifiers(modifiersOf(node)),
    parameters: convertParameters(field(node, 'parameters')),
    throwsTypes: convertThrows(node),
    explicitCall,
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
