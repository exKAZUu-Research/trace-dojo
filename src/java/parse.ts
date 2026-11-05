import type { Node } from '@willbooster/web-tree-sitter';

import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { ClassDeclaration, CompilationUnit, ImportDeclaration } from './ast';
import { convertTypeDeclaration } from './parseDeclarations';
import { namedChildren, span, unsupported } from './parseNodes';

const parser = await loadParser('@willbooster/tree-sitter-java/tree-sitter-java.wasm');

/** Parses a compilation unit, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseJava(source: string): CompilationUnit {
  return parseSource(parser, source, { identifier: '名前' }, convertProgram);
}

function convertProgram(root: Node): CompilationUnit {
  const classes: ClassDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  for (const child of namedChildren(root)) {
    switch (child.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration': {
        classes.push(convertTypeDeclaration(child));
        break;
      }
      // Problems show several files in one listing, so package and import lines may appear between classes.
      case 'package_declaration': {
        break;
      }
      case 'import_declaration': {
        imports.push(convertImport(child));
        break;
      }
      default: {
        unsupported(child, 'クラスの外に書いた文や宣言');
      }
    }
  }
  return { classes, imports };
}

function convertImport(node: Node): ImportDeclaration {
  const name = namedChildren(node).find((child) => child.type === 'scoped_identifier' || child.type === 'identifier');
  return {
    isStatic: node.children.some((child) => child?.type === 'static'),
    names: (name?.text ?? '').split('.').map((part) => part.trim()),
    isWildcard: node.children.some((child) => child?.type === 'asterisk'),
    ...span(node),
  };
}
