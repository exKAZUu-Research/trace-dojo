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

/** What javac checks of an annotation: where it may be written, and its elements by whether each has a default. */
interface AnnotationInterface {
  targets: readonly ElementType[];
  elements: Readonly<Record<string, boolean>>;
}

const LANG_ANNOTATIONS: Readonly<Record<string, AnnotationInterface>> = {
  Override: { targets: ['METHOD'], elements: {} },
  Deprecated: {
    targets: ['TYPE', 'FIELD', 'METHOD', 'PARAMETER', 'CONSTRUCTOR', 'LOCAL_VARIABLE'],
    elements: { since: true, forRemoval: true },
  },
  SuppressWarnings: {
    targets: ['TYPE', 'FIELD', 'METHOD', 'PARAMETER', 'CONSTRUCTOR', 'LOCAL_VARIABLE'],
    elements: { value: false },
  },
  FunctionalInterface: { targets: ['TYPE'], elements: {} },
  SafeVarargs: { targets: ['CONSTRUCTOR', 'METHOD'], elements: {} },
};

const META_ANNOTATIONS: Readonly<Record<string, AnnotationInterface>> = {
  Retention: { targets: ['ANNOTATION_TYPE'], elements: { value: false } },
  Target: { targets: ['ANNOTATION_TYPE'], elements: { value: false } },
  Documented: { targets: ['ANNOTATION_TYPE'], elements: {} },
  Inherited: { targets: ['ANNOTATION_TYPE'], elements: {} },
  Repeatable: { targets: ['ANNOTATION_TYPE'], elements: { value: false } },
  Native: { targets: ['FIELD'], elements: {} },
};

/**
 * Rejects an annotation that names no annotation interface, one not applicable where it is written, or one whose
 * elements are not those its interface declares. These programs ignore annotations otherwise, so the interfaces are
 * those the program declares, java.lang's, and java.lang.annotation's that are imported or written with their package.
 */
export function checkAnnotations(root: Node, imports: readonly ImportDeclaration[]): void {
  const declared = new Map<string, AnnotationInterface>();
  const uses: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'annotation_type_declaration') {
      declared.set(node.childForFieldName('name')?.text ?? '', declaredInterface(node));
    }
    if (isAnnotation(node)) uses.push(node);
    for (const child of namedChildren(node)) visit(child);
  };
  visit(root);
  const imported = new Set(
    imports
      .filter((declaration) => !declaration.isStatic && declaration.names.join('.').startsWith('java.lang.annotation'))
      .flatMap((declaration) => (declaration.isWildcard ? Object.keys(META_ANNOTATIONS) : declaration.names.slice(-1)))
  );
  for (const use of uses) {
    const name = (use.childForFieldName('name')?.text ?? '').replaceAll(/\s/g, '');
    const annotation = annotationInterfaceOf(name, declared, imported);
    if (!annotation) throw annotationError(use, `この採点環境には、アノテーション ${name} がありません。`);
    if (!contextsOf(use).some((context) => annotation.targets.includes(context))) {
      throw annotationError(use, `アノテーション @${name} はここには付けられません。`);
    }
    checkElements(use, name, annotation.elements);
  }
}

/** A declared annotation interface: the contexts its `@Target` lists, or every declaration context, and its elements. */
function declaredInterface(declaration: Node): AnnotationInterface {
  const target = namedChildren(modifiersOf(declaration) ?? declaration).find(
    (child) =>
      isAnnotation(child) && /^(java\.lang\.annotation\.)?Target$/.test(child.childForFieldName('name')?.text ?? '')
  );
  const listed: string[] = target?.childForFieldName('arguments')?.text.match(/\b[A-Z_]+\b/g) ?? [];
  const elements = namedChildren(declaration.childForFieldName('body') ?? declaration)
    .filter((member) => member.type === 'annotation_type_element_declaration')
    .map((member) => [member.childForFieldName('name')?.text ?? '', member.childForFieldName('value') !== null]);
  return {
    targets: target ? listed.filter((name): name is ElementType => ELEMENT_TYPES.has(name)) : DECLARATION_CONTEXTS,
    elements: Object.fromEntries(elements),
  };
}

function annotationInterfaceOf(
  name: string,
  declared: ReadonlyMap<string, AnnotationInterface>,
  imported: ReadonlySet<string>
): AnnotationInterface | undefined {
  const simpleName = name.split('.').at(-1) as string;
  const declaredInterface = declared.get(simpleName);
  if (declaredInterface) return declaredInterface;
  if (Object.hasOwn(LANG_ANNOTATIONS, simpleName) && (name === simpleName || name === `java.lang.${simpleName}`)) {
    return LANG_ANNOTATIONS[simpleName];
  }
  if (
    Object.hasOwn(META_ANNOTATIONS, simpleName) &&
    (imported.has(name) || name === `java.lang.annotation.${simpleName}`)
  ) {
    return META_ANNOTATIONS[simpleName];
  }
}

/** Rejects an element the interface does not declare, one given twice, and a missing one without a default. */
function checkElements(use: Node, name: string, elements: Readonly<Record<string, boolean>>): void {
  const argumentList = use.childForFieldName('arguments');
  const given = (argumentList ? namedChildren(argumentList) : []).map((argument) =>
    argument.type === 'element_value_pair' ? (argument.childForFieldName('key')?.text ?? '') : 'value'
  );
  for (const [index, element] of given.entries()) {
    if (!Object.hasOwn(elements, element))
      throw annotationError(use, `アノテーション @${name} には要素 ${element} がありません。`);
    if (given.indexOf(element) !== index)
      throw annotationError(use, `アノテーション @${name} の要素 ${element} が重複しています。`);
  }
  for (const [element, hasDefault] of Object.entries(elements)) {
    if (!hasDefault && !given.includes(element)) {
      throw annotationError(use, `アノテーション @${name} には要素 ${element} の値が必要です。`);
    }
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
