import type { Node } from '@willbooster/web-tree-sitter';

import { loadParser, parseSource } from '../interpreter/treeSitter';
import type {
  ClassDeclaration,
  CompilationUnit,
  ConstructorDeclaration,
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
      case 'class_declaration': {
        classes.push(convertClass(child));
        break;
      }
      // Problems show several files in one listing, so package and import lines may appear between classes.
      case 'package_declaration':
      case 'import_declaration': {
        break;
      }
      case 'interface_declaration': {
        unsupported(child, 'インターフェース');
        break;
      }
      case 'enum_declaration': {
        unsupported(child, '列挙型');
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

function convertClass(node: Node): ClassDeclaration {
  if (node.childForFieldName('type_parameters')) unsupported(node, '型パラメータ');
  if (node.childForFieldName('interfaces')) unsupported(node, 'インターフェースの実装');
  if (node.childForFieldName('permits')) unsupported(node, 'permits');
  const superclassNode = node.childForFieldName('superclass');
  const members = namedChildren(field(node, 'body')).map((member) => convertMember(member));
  return {
    name: field(node, 'name').text,
    modifiers: convertModifiers(modifiersOf(node)),
    superclass: superclassNode ? convertType(namedChildren(superclassNode)[0]) : undefined,
    members,
    ...span(node),
  };
}

function convertMember(member: Node): MemberDeclaration {
  switch (member.type) {
    case 'field_declaration': {
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
    default: {
      return unsupported(member, 'クラスの中のクラスやインターフェース');
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
