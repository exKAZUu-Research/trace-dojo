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

/**
 * What javac checks of an annotation: where it may be written, its elements by whether each has a default, and whether
 * it may be written twice in one place.
 */
interface AnnotationInterface {
  targets: readonly ElementType[];
  elements: Readonly<Record<string, boolean>>;
  isRepeatable?: boolean;
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

/** The contexts of the declarations whose modifiers an annotation may be among, by their nodes' types. */
const DECLARATION_OWNERS: Readonly<Record<string, readonly ElementType[]>> = {
  class_declaration: ['TYPE'],
  interface_declaration: ['TYPE'],
  enum_declaration: ['TYPE'],
  record_declaration: ['TYPE'],
  annotation_type_declaration: ['TYPE', 'ANNOTATION_TYPE'],
  method_declaration: ['METHOD', 'TYPE_USE'],
  annotation_type_element_declaration: ['METHOD', 'TYPE_USE'],
  constructor_declaration: ['CONSTRUCTOR'],
  compact_constructor_declaration: ['CONSTRUCTOR'],
  enum_constant: ['FIELD'],
  field_declaration: ['FIELD', 'TYPE_USE'],
  constant_declaration: ['FIELD', 'TYPE_USE'],
  formal_parameter: ['PARAMETER', 'TYPE_USE'],
  spread_parameter: ['PARAMETER', 'TYPE_USE'],
  catch_formal_parameter: ['PARAMETER', 'TYPE_USE'],
  local_variable_declaration: ['LOCAL_VARIABLE', 'TYPE_USE'],
  resource: ['LOCAL_VARIABLE', 'TYPE_USE'],
  enhanced_for_statement: ['LOCAL_VARIABLE', 'TYPE_USE'],
  instanceof_expression: ['LOCAL_VARIABLE', 'TYPE_USE'],
  record_component: ['RECORD_COMPONENT', 'FIELD', 'METHOD', 'PARAMETER', 'TYPE_USE'],
  type_parameter: ['TYPE_PARAMETER', 'TYPE_USE'],
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
  const imported = importedMetaAnnotations(imports);
  const written = new Set<string>();
  for (const use of uses) {
    const name = (use.childForFieldName('name')?.text ?? '').replaceAll(/\s/g, '');
    const annotation = annotationInterfaceOf(name, declared, imported);
    if (!annotation) throw annotationError(use, `この採点環境には、アノテーション ${name} がありません。`);
    const place = `${use.parent?.startIndex}:${name.split('.').at(-1)}`;
    if (written.has(place) && !annotation.isRepeatable) {
      throw annotationError(use, `アノテーション @${name} は同じ場所に 2 回付けられません。`);
    }
    written.add(place);
    checkPlacement(use, name, annotation);
  }
}

/** The names of the annotation interfaces of java.lang.annotation that the imports bring in. */
function importedMetaAnnotations(imports: readonly ImportDeclaration[]): ReadonlySet<string> {
  return new Set(
    imports
      .filter((declaration) => !declaration.isStatic && declaration.names.join('.').startsWith('java.lang.annotation'))
      .flatMap((declaration) => (declaration.isWildcard ? Object.keys(META_ANNOTATIONS) : declaration.names.slice(-1)))
  );
}

/** Rejects an annotation written where its interface's targets do not allow, or with elements it does not declare. */
function checkPlacement(use: Node, name: string, annotation: AnnotationInterface): void {
  if (!contextsOf(use).some((context) => annotation.targets.includes(context))) {
    throw annotationError(use, `アノテーション @${name} はここには付けられません。`);
  }
  checkElements(use, name, annotation.elements);
}

/** A declared annotation interface: the contexts its `@Target` lists, or every declaration context, and its elements. */
function declaredInterface(declaration: Node): AnnotationInterface {
  const metaAnnotations = namedChildren(modifiersOf(declaration) ?? declaration).filter((child) => isAnnotation(child));
  const metaAnnotation = (name: string): Node | undefined =>
    metaAnnotations.find(
      (child) => child.childForFieldName('name')?.text.replace(/^java\.lang\.annotation\./, '') === name
    );
  const target = metaAnnotation('Target');
  const listed: string[] = target?.childForFieldName('arguments')?.text.match(/\b[A-Z_]+\b/g) ?? [];
  const elements = namedChildren(declaration.childForFieldName('body') ?? declaration)
    .filter((member) => member.type === 'annotation_type_element_declaration')
    .map((member) => [member.childForFieldName('name')?.text ?? '', member.childForFieldName('value') !== null]);
  return {
    targets: target ? listed.filter((name): name is ElementType => ELEMENT_TYPES.has(name)) : DECLARATION_CONTEXTS,
    elements: Object.fromEntries(elements),
    isRepeatable: metaAnnotation('Repeatable') !== undefined,
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
  if (owner?.type === 'method_declaration' && owner.childForFieldName('type')?.type === 'void_type') return ['METHOD'];
  return (owner && DECLARATION_OWNERS[owner.type]) ?? ['TYPE_USE'];
}

function annotationError(use: Node, message: string): CompileError {
  return new CompileError([{ row: use.startPosition.row, message }]);
}
