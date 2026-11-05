import type { Node } from '@willbooster/web-tree-sitter';

import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { ClassDeclaration, CompilationUnit } from './ast';
import { convertTypeDeclaration } from './parseDeclarations';
import { namedChildren, unsupported } from './parseNodes';

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
      case 'enum_declaration':
      case 'record_declaration': {
        classes.push(convertTypeDeclaration(child));
        break;
      }
      // Problems show several files in one listing, so package and import lines may appear between classes.
      case 'package_declaration':
      case 'import_declaration': {
        break;
      }
      default: {
        unsupported(child, 'クラスの外に書いた文や宣言');
      }
    }
  }
  return { classes };
}
