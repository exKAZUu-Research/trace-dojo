import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ImportDeclaration } from './ast';
import { isAnnotation, modifiersOf, namedChildren } from './parseNodes';

/** The kinds of program elements an annotation interface's `@Target` may list (JLS 9.6.4.1). */
type ElementType =
  | 'TYPE'
  | 'ANNOTATION_TYPE'
  | 'FIELD'
  | 'METHOD'
  | 'PARAMETER'
  | 'CONSTRUCTOR'
  | 'LOCAL_VARIABLE'
  | 'TYPE_PARAMETER'
  | 'RECORD_COMPONENT'
  | 'TYPE_USE';

const DECLARATION_CONTEXTS: readonly ElementType[] = [
  'TYPE',
  'ANNOTATION_TYPE',
  'FIELD',
  'METHOD',
  'PARAMETER',
  'CONSTRUCTOR',
  'LOCAL_VARIABLE',
  'TYPE_PARAMETER',
  'RECORD_COMPONENT',
];

const ELEMENT_TYPES: ReadonlySet<string> = new Set([...DECLARATION_CONTEXTS, 'TYPE_USE']);

/** The targets of the annotation interfaces of java.lang, which need no import. */
const LANG_TARGETS: Readonly<Record<string, readonly ElementType[]>> = {
  Override: ['METHOD'],
  Deprecated: ['TYPE', 'FIELD', 'METHOD', 'PARAMETER', 'CONSTRUCTOR', 'LOCAL_VARIABLE'],
  SuppressWarnings: ['TYPE', 'FIELD', 'METHOD', 'PARAMETER', 'CONSTRUCTOR', 'LOCAL_VARIABLE'],
  FunctionalInterface: ['TYPE'],
  SafeVarargs: ['CONSTRUCTOR', 'METHOD'],
};

/** The targets of the annotation interfaces of java.lang.annotation. */
const META_TARGETS: Readonly<Record<string, readonly ElementType[]>> = {
  Retention: ['ANNOTATION_TYPE'],
  Target: ['ANNOTATION_TYPE'],
  Documented: ['ANNOTATION_TYPE'],
  Inherited: ['ANNOTATION_TYPE'],
  Repeatable: ['ANNOTATION_TYPE'],
  Native: ['FIELD'],
};

/**
 * Rejects an annotation that names no annotation interface or one not applicable where it is written. These programs
 * ignore annotations otherwise, so the interfaces are those the program declares, java.lang's, and java.lang.annotation's
 * that are imported or written with their package.
 */
export function checkAnnotations(root: Node, imports: readonly ImportDeclaration[]): void {
  const targets = new Map<string, readonly ElementType[]>();
  const uses: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'annotation_type_declaration') {
      targets.set(node.childForFieldName('name')?.text ?? '', declaredTargets(node));
    }
    if (isAnnotation(node)) uses.push(node);
    for (const child of namedChildren(node)) visit(child);
  };
  visit(root);
  const imported = new Set(
    imports
      .filter((declaration) => !declaration.isStatic && declaration.names.join('.').startsWith('java.lang.annotation'))
      .flatMap((declaration) => (declaration.isWildcard ? Object.keys(META_TARGETS) : declaration.names.slice(-1)))
  );
  for (const use of uses) {
    const name = (use.childForFieldName('name')?.text ?? '').replaceAll(/\s/g, '');
    const applicable = targetsOf(name, targets, imported);
    if (!applicable) throw annotationError(use, `この採点環境には、アノテーション ${name} がありません。`);
    if (!contextsOf(use).some((context) => applicable.includes(context))) {
      throw annotationError(use, `アノテーション @${name} はここには付けられません。`);
    }
  }
}

/** The contexts a declared annotation interface lists in its `@Target`, or every declaration context without one. */
function declaredTargets(declaration: Node): readonly ElementType[] {
  const target = namedChildren(modifiersOf(declaration) ?? declaration).find(
    (child) =>
      isAnnotation(child) && /^(java\.lang\.annotation\.)?Target$/.test(child.childForFieldName('name')?.text ?? '')
  );
  if (!target) return DECLARATION_CONTEXTS;
  const listed: string[] = target.childForFieldName('arguments')?.text.match(/\b[A-Z_]+\b/g) ?? [];
  return listed.filter((name): name is ElementType => ELEMENT_TYPES.has(name));
}

function targetsOf(
  name: string,
  declared: ReadonlyMap<string, readonly ElementType[]>,
  imported: ReadonlySet<string>
): readonly ElementType[] | undefined {
  const simpleName = name.split('.').at(-1) as string;
  const declaredTargets = declared.get(simpleName);
  if (declaredTargets) return declaredTargets;
  if (Object.hasOwn(LANG_TARGETS, simpleName) && (name === simpleName || name === `java.lang.${simpleName}`)) {
    return LANG_TARGETS[simpleName];
  }
  if (
    Object.hasOwn(META_TARGETS, simpleName) &&
    (imported.has(name) || name === `java.lang.annotation.${simpleName}`)
  ) {
    return META_TARGETS[simpleName];
  }
}

/** The contexts an annotation written at `use` applies to: its declaration's kind, and the declared type's use. */
function contextsOf(use: Node): readonly ElementType[] {
  const owner = use.parent?.type === 'modifiers' ? use.parent.parent : use.parent;
  switch (owner?.type) {
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'record_declaration': {
      return ['TYPE'];
    }
    case 'annotation_type_declaration': {
      return ['TYPE', 'ANNOTATION_TYPE'];
    }
    case 'method_declaration': {
      return owner.childForFieldName('type')?.type === 'void_type' ? ['METHOD'] : ['METHOD', 'TYPE_USE'];
    }
    case 'annotation_type_element_declaration': {
      return ['METHOD', 'TYPE_USE'];
    }
    case 'constructor_declaration':
    case 'compact_constructor_declaration': {
      return ['CONSTRUCTOR'];
    }
    case 'enum_constant': {
      return ['FIELD'];
    }
    case 'field_declaration':
    case 'constant_declaration': {
      return ['FIELD', 'TYPE_USE'];
    }
    case 'formal_parameter':
    case 'spread_parameter':
    case 'catch_formal_parameter': {
      return ['PARAMETER', 'TYPE_USE'];
    }
    case 'local_variable_declaration':
    case 'resource':
    case 'enhanced_for_statement':
    case 'instanceof_expression': {
      return ['LOCAL_VARIABLE', 'TYPE_USE'];
    }
    case 'record_component': {
      return ['RECORD_COMPONENT', 'FIELD', 'METHOD', 'PARAMETER', 'TYPE_USE'];
    }
    case 'type_parameter': {
      return ['TYPE_PARAMETER', 'TYPE_USE'];
    }
    default: {
      return ['TYPE_USE'];
    }
  }
}

function annotationError(use: Node, message: string): CompileError {
  return new CompileError([{ row: use.startPosition.row, message }]);
}
