import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import { loadParser, parseSource } from '../interpreter/treeSitter';
import type { ClassDeclaration, CompilationUnit, ImportDeclaration, MemberDeclaration } from './ast';
import { checkAnnotations } from './parseAnnotations';
import { convertTopLevelMember, convertTypeDeclaration } from './parseDeclarations';
import { namedChildren, span } from './parseNodes';

const parser = await loadParser('@willbooster/tree-sitter-java/tree-sitter-java.wasm');

/** Parses a compilation unit, throwing a `CompileError` for invalid or unsupported syntax. */
export function parseJava(source: string): CompilationUnit {
  return parseSource(parser, source, { identifier: '名前' }, convertProgram);
}

function convertProgram(root: Node): CompilationUnit {
  const classes: ClassDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  // A compact source file's top-level declarations, in order, which become members of its implicit class.
  const members: MemberDeclaration[] = [];
  let isCompact = false;
  for (const child of namedChildren(root)) {
    switch (child.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration':
      case 'record_declaration':
      case 'annotation_type_declaration': {
        const declaration = convertTypeDeclaration(child);
        classes.push(declaration);
        members.push(declaration);
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
      // A compact source file's fields and methods, which tree-sitter parses as declarations of local variables.
      case 'local_variable_declaration':
      case 'method_declaration': {
        members.push(convertTopLevelMember(child));
        isCompact = true;
        break;
      }
      // Java accepts only declarations outside classes, so a statement there needs a method around it.
      default: {
        throw new CompileError([
          { row: child.startPosition.row, message: '文はクラスの外ではなく、メソッドの中に書いてください。' },
        ]);
      }
    }
  }
  checkAnnotations(root, imports);
  return { classes: isCompact ? [implicitClass(members)] : classes, imports };
}

/**
 * The final class named after the file that a compact source file declares, whose members are the file's fields,
 * methods, and classes (JLS 7.3).
 */
function implicitClass(members: MemberDeclaration[]): ClassDeclaration {
  const [first, last] = [members[0], members.at(-1) as MemberDeclaration];
  return {
    kind: 'class',
    name: 'Main',
    typeParameters: [],
    modifiers: { isStatic: false, isFinal: true, isAbstract: false, isDefault: false, access: 'package' },
    interfaces: [],
    enumConstants: [],
    isImplicit: true,
    members,
    row: first.row,
    start: first.start,
    endRow: last.endRow,
    end: last.end,
  };
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
