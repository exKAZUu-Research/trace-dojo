import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { Language, type Node, Parser } from '@willbooster/web-tree-sitter';

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
import { CompileError, type JavaSourceDiagnostic } from './diagnostics';
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

// Resolving from the working directory keeps the lookup independent of how Next.js bundles this module.
const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));
// Copying into this realm's Uint8Array passes the runtime's `instanceof` check, which a Buffer from another realm
// (as under jsdom) fails.
const readWasm = (specifier: string): Uint8Array => Uint8Array.from(readFileSync(requireFromRoot.resolve(specifier)));
await Parser.init({
  wasmBinary: readWasm('@willbooster/web-tree-sitter/web-tree-sitter.wasm').buffer as ArrayBuffer,
});
const parser = new Parser();
parser.setLanguage(await Language.load(readWasm('@willbooster/tree-sitter-java/tree-sitter-java.wasm')));

/** Parses a compilation unit, throwing a {@link CompileError} for invalid or unsupported syntax. */
export function parseJava(source: string): CompilationUnit {
  const tree = parser.parse(source);
  if (!tree) throw new Error('The Java parser returned no tree');
  try {
    const tooDeep = findTooDeepNode(tree.rootNode);
    if (tooDeep) {
      throw new CompileError([{ row: tooDeep.startPosition.row, message: '括弧やブロックなどの入れ子が深すぎます。' }]);
    }
    const syntaxErrors = collectSyntaxErrors(tree.rootNode);
    if (syntaxErrors.length > 0) throw new CompileError(syntaxErrors);
    return convertProgram(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** Names for learners of the grammar's named tokens that error recovery may insert; punctuation names itself. */
const missingTokenNames: Record<string, string> = { identifier: '名前' };

/** Converting, compiling, and running recurse into nested constructs, so deeper nesting would exhaust the stack. */
const MAX_NESTING_DEPTH = 300;

function findTooDeepNode(root: Node): Node | undefined {
  const cursor = root.walk();
  try {
    for (;;) {
      if (cursor.currentDepth > MAX_NESTING_DEPTH) return cursor.currentNode;
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}

function collectSyntaxErrors(root: Node): JavaSourceDiagnostic[] {
  const errors: JavaSourceDiagnostic[] = [];
  const visit = (node: Node): void => {
    if (errors.length >= 5) return;
    if (node.isMissing) {
      errors.push({
        row: rowBeforeMissing(node),
        message: `「${missingTokenNames[node.type] ?? node.type}」が足りません。`,
      });
      return;
    }
    if (node.isError) {
      errors.push({ row: node.startPosition.row, message: '書き方に誤りがあります。' });
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return errors;
}

/** The row where the code before a missing token ends, since the parser places that token at the next one. */
function rowBeforeMissing(missing: Node): number {
  for (let node: Node | null = missing; node; node = node.parent) {
    const previous = node.previousSibling;
    if (previous) return previous.endPosition.row;
  }
  return missing.startPosition.row;
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
