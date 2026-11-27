// code-gauge-allow-file fileNcss -- Lowers TypeScript declarations, imports, exports, namespaces, and class members in one syntax pass.
import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../interpreter/limits';
import { nameOf, type Node } from '../javascript/convertNodes';
import { isConstructorDefinition } from '../javascript/programConverter';
import { Binder } from './checker/binder';
import { fsImportMeanings } from './checker/nodeLibrary';
import { Scope, type Sym } from './checker/scopes';
import { isModule, isParameterProperty, stringValue } from './checker/syntax';
import {
  assertedExpression,
  assertionTypes,
  erasedClassMembers,
  erasedStatementTypes,
  erasedTypeNodes,
} from './erasedSyntax';
import { blockEmitsRuntimeNamespace, isAmbient, isInstantiatedNamespace } from './namespaceInstantiation';
import { importableModules } from './unsupported';

/**
 * The type of a synthesized statement that copies a constructor's parameter properties to `this`, which the
 * TypeScript converter handles, since JavaScript has no syntax for it.
 */
export const PARAMETER_PROPERTY_ASSIGNMENT = 'parameter_property_assignment';
export const IMPORTED_MODULE = 'imported_module';

/** A node of the view, which may stand for a tree-sitter node or be synthesized from one. */
class ViewNode implements Node {
  /** Whether the view added this statement without a step of its own, as an assignment exporting a namespace's member. */
  isUnstepped = false;
  /** Whether a synthesized function (such as a namespace body wrapper) hides its call frame from trace `callLines`. */
  hidesCallRow = false;
  /** The variable name a synthesized namespace-export target or anonymous default export stands for (`--keep-names`). */
  inferredName?: string;
  /** Whether a viewed `class` came from an unnamed `export default [abstract] class` declaration. */
  isUnnamedDefaultClassDeclaration = false;
  /** Whether a synthesized member expression represents a live ESM import binding called with `undefined` receiver. */
  isUnboundCall = false;
  /** Whether an `imported_module` node wraps the CommonJS module in an ESM namespace object (`__toESM`). */
  isNamespaceImport = false;
  /** Whether the root program has top-level `import` or `export` syntax (an external module). */
  isExternalModule = false;
  /** Generated helper binding names allocated for this program, omitted from learner trace snapshots. */
  hiddenNames?: ReadonlySet<string>;
  /** A collision-free alias bound to an enum's object when a member initializer shadows the enum's source name. */
  enumAlias?: string;
  /** The source-spelled receiver name shown in runtime error messages when `text` is a generated `$ns_` helper. */
  displayText?: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };

  constructor(
    readonly type: string,
    readonly text: string,
    readonly isNamed: boolean,
    position: TreeNode,
    readonly children: ViewNode[],
    private readonly fields: Map<string, ViewNode[]>
  ) {
    this.startIndex = position.startIndex;
    this.endIndex = position.endIndex;
    this.startPosition = position.startPosition;
  }

  get namedChildren(): ViewNode[] {
    return this.children.filter((child) => child.isNamed);
  }

  childForFieldName(fieldName: string): ViewNode | null {
    // oxlint-disable-next-line unicorn/no-null -- Matches tree-sitter's API, which the converter is written against.
    return this.fields.get(fieldName)?.[0] ?? null;
  }

  childrenForFieldName(fieldName: string): ViewNode[] {
    return this.fields.get(fieldName) ?? [];
  }
}

interface Part {
  node: ViewNode;
  fieldName: string | null | undefined;
}

const exportedPatternTypes = new Set([
  'object_pattern',
  'array_pattern',
  'pair_pattern',
  'assignment_pattern',
  'rest_pattern',
]);

/** The kinds of names a namespace exports as properties that its declarations read and write. */
const exportedVariableKinds = new Set(['let', 'const', 'var', 'declared']);

/** Fields that hold only types, which running a program ignores. */
const typeFields = new Set(['type', 'return_type', 'type_parameters', 'type_arguments']);
const erasedModifierNodes = new Set(['accessibility_modifier', 'override_modifier']);
/** Modifier tokens of members, parameters, and declarators that running a program ignores. */
const memberModifiers = new Set(['readonly', 'abstract', 'declare', '?', '!', 'override']);
const modifiedTypes = new Set([
  'field_definition',
  'method_definition',
  'variable_declarator',
  'required_parameter',
  'optional_parameter',
  'abstract_class_declaration',
]);

interface NamespaceReceiver {
  symbol: Sym | undefined;
  receiver: string;
}

class ViewContext {
  readonly usedNames: Set<string>;
  readonly hiddenNames = new Set<string>();
  readonly displayNames = new Map<string, string>();
  readonly bodyReceivers = new Map<number, NamespaceReceiver[]>();
  readonly enumAliases = new Map<number, string>();
  readonly importReceivers = new Map<number, string>();
  private nextId = 0;

  constructor(root: TreeNode, budget: ExecutionBudget) {
    this.usedNames = collectIdentifierNames(root, budget);
  }

  freshHelperName(base: string, displayName = base): string {
    const clean = base.replaceAll(/[^\w$]/g, '_') || 'ns';
    let candidate = `$ns_${clean}`;
    while (this.usedNames.has(candidate)) candidate = `$ns_${clean}_${++this.nextId}`;
    this.usedNames.add(candidate);
    this.hiddenNames.add(candidate);
    this.displayNames.set(candidate, displayName);
    return candidate;
  }

  importReceiverFor(statement: TreeNode, moduleName: string): string {
    let helper = this.importReceivers.get(statement.id);
    if (!helper) {
      const cleanModule = moduleName.replaceAll(/[^\w$]/g, '_') || 'mod';
      helper = this.freshHelperName(`import_${moduleName}`, `import_${cleanModule}`);
      this.importReceivers.set(statement.id, helper);
    }
    return helper;
  }
}

let activeDisplayNames: ReadonlyMap<string, string> | undefined;

const viewContexts = new WeakMap<Binder, ViewContext>();

function contextOf(binder: Binder): ViewContext {
  const context = viewContexts.get(binder);
  if (!context) throw new Error('Missing ViewContext for Binder');
  return context;
}

function collectIdentifierNames(root: TreeNode, budget: ExecutionBudget): Set<string> {
  const names = new Set<string>();
  const stack: TreeNode[] = [root];
  for (let current = stack.pop(); current; current = stack.pop()) {
    budget.spend();
    if (current.type.includes('identifier')) {
      names.add(current.text);
      if (current.text.includes('\\')) {
        try {
          names.add(nameOf(current));
        } catch {
          // Invalid escapes are reported later during conversion/checking.
        }
      }
    }
    for (const child of current.namedChildren) if (child) stack.push(child);
  }
  return names;
}

/**
 * Views a TypeScript tree as the JavaScript tree that erasing its types leaves, so that the JavaScript converter can
 * convert it: types, type-only declarations, and type assertions disappear, parameters become their patterns, and
 * parameter properties become fields that the constructor assigns.
 */
export function javaScriptViewOf(root: TreeNode, budget: ExecutionBudget): Node {
  const externalModule = isModule(root);
  const binder = new Binder(root, new Scope('global', undefined, undefined), {
    budget,
    skipAssignmentAnalysis: true,
    isExternalModule: externalModule,
    augmentableModules: importableModules,
  });
  const context = new ViewContext(root, budget);
  viewContexts.set(binder, context);
  for (const scope of binder.allScopes) {
    for (const symbol of scope.values.values()) {
      budget.spend();
      const name = symbol.valueEntries[0]?.name;
      if (name) scope.values.set(nameOf(name), symbol);
    }
    for (const symbol of scope.namespaces.values()) {
      budget.spend();
      const name = symbol.namespaceEntries[0]?.name;
      if (name) scope.namespaces.set(nameOf(name), symbol);
    }
  }
  const previousDisplayNames = activeDisplayNames;
  activeDisplayNames = context.displayNames;
  try {
    const viewed = view(root, binder);
    viewed.isExternalModule = externalModule;
    if (context.hiddenNames.size > 0) viewed.hiddenNames = context.hiddenNames;
    return viewed;
  } finally {
    activeDisplayNames = previousDisplayNames;
  }
}

/** The TypeScript declarations that compile to code of their own, and the names a namespace's exports change. */
const compiledDeclarations: Record<string, (node: TreeNode, binder: Binder) => ViewNode> = {
  shorthand_property_identifier: (node, binder) => shorthandPropertyView(node, binder),
  shorthand_property_identifier_pattern: (node, binder) => shorthandPropertyPatternView(node, binder),
  object_assignment_pattern: (node, binder) => objectAssignmentPatternView(node, binder),
  module: (node, binder) => namespaceView(node, binder),
  internal_module: (node, binder) => namespaceView(node, binder),
  import_alias: (node, binder) => importAliasView(node, binder),
  import_statement: (node, binder) => importView(node, binder),
  export_statement: (node, binder) => exportView(node, binder),
  required_parameter: (node, binder) => parameter(node, binder),
  optional_parameter: (node, binder) => parameter(node, binder),
  class_heritage: (node, binder) => heritage(node, binder),
  class_body: (node, binder) => classBody(node, binder),
  abstract_class_declaration: (node, binder) => generic(node, 'class_declaration', binder),
  field_definition: (node, binder) => generic(node, 'field_definition', binder),
  identifier: (node, binder) => identifierView(node, binder),
};

function view(node: TreeNode, binder: Binder): ViewNode {
  const compiled = compiledDeclarations[node.type] as ((node: TreeNode, binder: Binder) => ViewNode) | undefined;
  if (compiled) return compiled(node, binder);
  if (assertionTypes.has(node.type)) return view(assertedExpression(node) as TreeNode, binder);
  switch (node.type) {
    case 'instantiation_expression': {
      return view((node.childForFieldName('function') ?? node.namedChildren[0]) as TreeNode, binder);
    }
    case 'parenthesized_expression': {
      // tsx's esbuild drops parentheses around a name, which V8 then prints without them in errors.
      const inner = unwrappedName(node);
      return inner ? view(inner, binder) : generic(node, node.type, binder);
    }
    case 'expression_statement': {
      const inner = node.namedChildren[0];
      return inner?.type === 'internal_module' ? namespaceView(inner, binder) : generic(node, node.type, binder);
    }
    case 'enum_declaration': {
      const context = contextOf(binder);
      const nameNode = node.childForFieldName('name');
      if (isTopLevelEnumDeclaration(node) && nameNode && !context.enumAliases.has(node.id)) {
        context.enumAliases.set(node.id, context.freshHelperName(nameOf(nameNode)));
      }
      const viewed = generic(node, node.type, binder);
      viewed.enumAlias = context.enumAliases.get(node.id);
      return viewed;
    }
    default: {
      return erasedStatementTypes.has(node.type) ? leaf(node, 'empty_statement') : generic(node, node.type, binder);
    }
  }
}

function identifierView(node: TreeNode, binder: Binder): ViewNode {
  const rewritten = rewrittenIdentifierReference(node, binder);
  if (rewritten) return rewritten;
  const symbol = binder.lookupValue(node, nameOf(node));
  // esbuild only lowers the unbound global to void 0; local bindings retain their values and assignment targets.
  return nameOf(node) === 'undefined' && !symbol
    ? leaf(node, 'undefined', '(void 0)')
    : generic(node, node.type, binder);
}

/** `{ x }` naming a namespace's export or an enum's member, as `{ x: N.x }` or `{ A: E.A }`. */
function shorthandPropertyView(node: TreeNode, binder: Binder): ViewNode {
  const value = rewrittenIdentifierReference(node, binder);
  if (!value) return generic(node, node.type, binder);
  return assemble(node, 'pair', [
    { node: leaf(node, 'property_identifier', nameOf(node)), fieldName: 'key' },
    { node: token(node, ':'), fieldName: undefined },
    { node: value, fieldName: 'value' },
  ]);
}

function shorthandPropertyPatternView(node: TreeNode, binder: Binder): ViewNode {
  const target = isAssignmentPatternPosition(node) ? rewrittenIdentifierReference(node, binder) : undefined;
  return target ? pairPattern(node, node, target) : generic(node, node.type, binder);
}

function objectAssignmentPatternView(node: TreeNode, binder: Binder): ViewNode {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  const target =
    left?.type === 'shorthand_property_identifier_pattern' && right && isAssignmentPatternPosition(node)
      ? rewrittenIdentifierReference(left, binder)
      : undefined;
  if (!target || !left || !right) return generic(node, node.type, binder);
  return pairPattern(node, left, defaultedTarget(node, target, right, binder));
}

function pairPattern(position: TreeNode, keyNode: TreeNode, value: ViewNode): ViewNode {
  return assemble(position, 'pair_pattern', [
    { node: leaf(keyNode, 'property_identifier', nameOf(keyNode)), fieldName: 'key' },
    { node: token(position, ':'), fieldName: undefined },
    { node: value, fieldName: 'value' },
  ]);
}

function defaultedTarget(position: TreeNode, target: ViewNode, right: TreeNode, binder: Binder): ViewNode {
  return assemble(position, 'assignment_pattern', [
    { node: target, fieldName: 'left' },
    { node: token(position, '='), fieldName: undefined },
    { node: view(right, binder), fieldName: 'right' },
  ]);
}

const patternContainerTypes = new Set([
  'object_pattern',
  'object',
  'array_pattern',
  'array',
  'rest_pattern',
  'spread_element',
  'parenthesized_expression',
]);

function isAssignmentPatternPosition(node: TreeNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (patternContainerTypes.has(parent.type) || assertionTypes.has(parent.type)) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    const isValueOfPair =
      (parent.type === 'pair_pattern' || parent.type === 'pair') && parent.childForFieldName('value')?.id === child.id;
    const isLeftOfDefault =
      (parent.type === 'assignment_pattern' || parent.type === 'object_assignment_pattern') &&
      parent.childForFieldName('left')?.id === child.id;
    if (isValueOfPair || isLeftOfDefault) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    break;
  }
  if (!parent || parent.childForFieldName('left')?.id !== child.id) return false;
  return (
    parent.type === 'assignment_expression' || (parent.type === 'for_in_clause' && !parent.childForFieldName('kind'))
  );
}

function rewrittenIdentifierReference(node: TreeNode, binder: Binder): ViewNode | undefined {
  if (node.parent?.childForFieldName('name')?.id === node.id) return undefined;
  const symbol = binder.lookupValue(node, nameOf(node));
  const namespace = namespaceOfReference(node, symbol, binder);
  if (namespace) return memberReference(node, namespace, nameOf(node));
  if (symbol?.valueKind === 'import' && symbol.importTarget && !symbol.importTarget.typeOnly) {
    const declaration = symbol.valueDeclarations[0];
    if (declaration?.type === 'import_statement' && symbol.importTarget.name !== '*') {
      const receiver = contextOf(binder).importReceiverFor(declaration, symbol.importTarget.module);
      return liveImportReference(node, receiver, symbol.importTarget.name);
    }
  }
  // An enum's initializers refer to its members by name, which compiles to reading them from the enum object.
  if (symbol?.valueKind === 'enumMember') return enumMemberReference(node, symbol.valueDeclaration as TreeNode, binder);
  if (symbol?.valueKind === 'enum') {
    const enclosing = enclosingEnumOf(node);
    const alias =
      enclosing && symbol.valueDeclarations.some((decl) => decl.id === enclosing.id)
        ? contextOf(binder).enumAliases.get(enclosing.id)
        : undefined;
    if (alias) return leaf(node, 'identifier', alias);
  }
  return undefined;
}

function liveImportReference(position: TreeNode, objectName: string, memberName: string): ViewNode {
  const reference = memberReference(position, objectName, memberName);
  reference.isUnboundCall = true;
  return reference;
}

/**
 * The namespace whose object a name is read from: a namespace's exported variable is a property of its object, which
 * its declarations read, as is any export that another declaration of the namespace reads, where the name has no
 * binding of its own.
 */
function namespaceOfReference(node: TreeNode, symbol: Sym | undefined, binder: Binder): string | undefined {
  if (!symbol?.exportedFrom) return undefined;
  const currentBodyId = namespaceBodyOf(node)?.id;
  const hasLocalBinding = symbol.valueDeclarations.some((declaration) =>
    declaresLocalBindingInBody(declaration, symbol, currentBodyId)
  );
  const isProperty = exportedVariableKinds.has(symbol.valueKind ?? '') || !hasLocalBinding;
  return isProperty ? activeNamespaceReceiver(node, symbol.exportedFrom, contextOf(binder)) : undefined;
}

function activeNamespaceReceiver(node: TreeNode, targetNamespace: Sym, context: ViewContext): string {
  for (let body = namespaceBodyOf(node); body; body = namespaceBodyOf(body.parent)) {
    const entry = context.bodyReceivers.get(body.id)?.find((candidate) => candidate.symbol === targetNamespace);
    if (entry) return entry.receiver;
  }
  return targetNamespace.name;
}

function declaresLocalBindingInBody(declaration: TreeNode, symbol: Sym, currentBodyId: number | undefined): boolean {
  if (currentBodyId === undefined || namespaceBodyOf(declaration)?.id !== currentBodyId || isAmbient(declaration))
    return false;
  if (declaration.type === 'internal_module' || declaration.type === 'module') {
    const emitted = emittedNamespacePath(declaration);
    return !!emitted && nameOf(emitted.path[0]) === symbol.name && declaresNamespaceVar(symbol);
  }
  if (declaration.type === 'enum_declaration') {
    return !declaration.children.some((child) => !child?.isNamed && child?.type === 'const');
  }
  return !erasedStatementTypes.has(declaration.type);
}

/** The body of the namespace declaration a node is in, whose function binds the names it declares. */
function namespaceBodyOf(node: TreeNode | null | undefined): TreeNode | undefined {
  for (let current = node?.parent; current; current = current.parent)
    if (
      current.type === 'statement_block' &&
      (current.parent?.type === 'internal_module' || current.parent?.type === 'module')
    )
      return current;
  return undefined;
}

/** The name parentheses wrap, through nested parentheses and type assertions, as `((x))` and `(x as any)`. */
function unwrappedName(node: TreeNode): TreeNode | undefined {
  let inner = node;
  while (inner.type === 'parenthesized_expression' || assertionTypes.has(inner.type)) {
    const next =
      inner.type === 'parenthesized_expression'
        ? inner.namedChildren.find((child) => child?.type !== 'comment')
        : assertedExpression(inner);
    if (!next) return undefined;
    inner = next;
  }
  return inner.type === 'identifier' ? inner : undefined;
}

function generic(node: TreeNode, type: string, binder: Binder): ViewNode {
  const directives: Part[] = [];
  // An ECMAScript module's imports bind before its statements run, after any leading directive prologue.
  const imports: Part[] = [];
  const parts: Part[] = [];
  let inPrologue = type === 'program';
  for (const [index, child] of node.children.entries()) {
    if (!child) continue;
    if (inPrologue && !isPrologueChild(child)) inPrologue = false;
    const fieldName = node.fieldNameForChild(index);
    if (isErased(node, type, child, fieldName ?? undefined)) continue;
    const target = inPrologue ? directives : type === 'program' && child.type === 'import_statement' ? imports : parts;
    target.push({ node: view(child, binder), fieldName });
  }
  return assemble(node, type, [...directives, ...imports, ...parts]);
}

function isPrologueChild(child: TreeNode): boolean {
  if (child.type === 'hash_bang_line' || child.type === 'comment') return true;
  if (child.type !== 'expression_statement') return false;
  return child.namedChildren.find((inner) => inner?.type !== 'comment')?.type === 'string';
}

/** Whether a child is TypeScript-only syntax, which the JavaScript view leaves out. */
function isErased(node: TreeNode, type: string, child: TreeNode, fieldName: string | undefined): boolean {
  if ((type === 'program' || type === 'statement_block') && erasedStatementTypes.has(child.type)) return true;
  if (fieldName && typeFields.has(fieldName)) return true;
  if (erasedTypeNodes.has(child.type) || erasedModifierNodes.has(child.type)) return true;
  if (node.type === 'field_definition' && child.type === 'readonly') return false;
  if (!child.isNamed && modifiedTypes.has(node.type) && memberModifiers.has(child.type)) return true;
  if (type === 'formal_parameters' && isThisParameter(child)) return true;
  return child.type === 'class_heritage' && !child.namedChildren.some((part) => part?.type === 'extends_clause');
}

function assemble(node: TreeNode, type: string, parts: Part[], text = node.text): ViewNode {
  const fields = new Map<string, ViewNode[]>();
  for (const { node: child, fieldName } of parts) {
    if (!fieldName) continue;
    const children = fields.get(fieldName) ?? [];
    children.push(child);
    fields.set(fieldName, children);
  }
  return new ViewNode(
    type,
    text,
    node.isNamed,
    node,
    parts.map((part) => part.node),
    fields
  );
}

function leaf(node: TreeNode, type: string, text = node.text, isNamed = true): ViewNode {
  const viewed = new ViewNode(type, text, isNamed, node, [], new Map());
  if (type === 'identifier') viewed.displayText = activeDisplayNames?.get(text);
  return viewed;
}

/** `E.A` for a member `A` of the enum `E`, which the identifier `A` in an initializer of `E` stands for. */
function enumMemberReference(node: TreeNode, member: TreeNode, binder: Binder): ViewNode {
  const declaration = member.parent?.parent;
  const nameNode = declaration?.childForFieldName('name');
  const enumName = nameNode ? nameOf(nameNode) : '';
  if (!declaration || !enumName) return memberReference(node, enumName, nameOf(node));
  const enumSymbol = binder.lookupValue(declaration, enumName);
  const targetEnum = enclosingEnumOf(node) ?? declaration;
  const context = contextOf(binder);
  const preassigned = context.enumAliases.get(targetEnum.id);
  if (!preassigned && binder.lookupValue(node, enumName) === enumSymbol) {
    return memberReference(node, enumName, nameOf(node));
  }
  let alias = preassigned;
  if (!alias) {
    alias = context.freshHelperName(enumName);
    context.enumAliases.set(targetEnum.id, alias);
  }
  return memberReference(node, alias, nameOf(node));
}

function enclosingEnumOf(node: TreeNode): TreeNode | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === 'enum_declaration') return current;
  }
  return undefined;
}

function isTopLevelEnumDeclaration(node: TreeNode): boolean {
  return (
    node.parent?.type === 'program' ||
    (node.parent?.type === 'export_statement' && node.parent.parent?.type === 'program')
  );
}

function exportedMemberReference(position: TreeNode, objectName: string, memberName: string): ViewNode {
  const reference = memberReference(position, objectName, memberName);
  reference.inferredName = memberName;
  return reference;
}

function memberReference(position: TreeNode, objectName: string, memberName: string): ViewNode {
  return assemble(
    position,
    'member_expression',
    [
      { node: leaf(position, 'identifier', objectName), fieldName: 'object' },
      { node: token(position, '.'), fieldName: undefined },
      { node: leaf(position, 'property_identifier', memberName), fieldName: 'property' },
    ],
    `${objectName}.${memberName}`
  );
}

function token(position: TreeNode, text: string): ViewNode {
  return leaf(position, text, text, false);
}

/**
 * A namespace as TypeScript compiles it: a function, called once, that adds the namespace's exports to its object,
 * `var N = ((N) => { ...; return N; })(N || (N = {}));`, where `namespace A.B { }` nests `B` in `A`. One that only
 * declares types compiles to nothing.
 */
function namespaceView(node: TreeNode, binder: Binder): ViewNode {
  const emitted = emittedNamespacePath(node);
  if (!emitted) return leaf(node, 'empty_statement');
  const { path, body, emitsBody } = emitted;
  const { statements, outermostReceiver, outermostSymbol } = buildNamespacePath(
    node,
    { body, path, emitsBody },
    binder
  );
  const outermost = nameOf(path[0]);
  const call = namespaceCall(node, outermostReceiver, statements, orEmptyObject(node, outermost));
  // Every block passes the object the blocks before it made, or a new one, so no block needs to know whether it is
  // first; a class, function, or enum declared before the namespace already declares its name.
  const isNamespaceFirst = declaresNamespaceVar(outermostSymbol);
  return isNamespaceFirst ? varDeclaration(node, outermost, call) : expressionStatement(node, call);
}

function emittedNamespacePath(node: TreeNode): { path: TreeNode[]; body: TreeNode; emitsBody: boolean } | undefined {
  const name = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!name || !body || name.type === 'string') return undefined;
  const path = namespacePathOf(name);
  if (blockEmitsRuntimeNamespace(body)) return { path, body, emitsBody: true };
  return path.length > 1 ? { path: path.slice(0, -1), body, emitsBody: false } : undefined;
}

/**
 * Whether a namespace block declares `var N`: never when a non-ambient class or function declares `N`, and otherwise
 * when a non-ambient namespace precedes any enum of the same name.
 */
function declaresNamespaceVar(symbol: Sym | undefined): boolean {
  if (!symbol) return true;
  const nonAmbient = symbol.valueEntries.filter((entry) => !isAmbient(entry.name));
  if (nonAmbient.some((entry) => entry.kind === 'class' || entry.kind === 'function')) return false;
  return nonAmbient[0]?.kind === 'namespace';
}

/**
 * An `import` of a Node.js module as tsx compiles it for CommonJS: `var ns = __toESM(require("fs"))` for a namespace
 * import, and a hidden `var $ns_import_fs = __toESM(require("fs"))` whose live getters default and named imports read.
 */
function importView(node: TreeNode, binder: Binder): ViewNode {
  const clause = node.childForFieldName('import_clause');
  const source = node.childForFieldName('source');
  if (!clause || !source || node.children.some((child) => !child.isNamed && child.type === 'type'))
    return leaf(node, 'empty_statement');
  const bindings = importBindings(node, clause, source, binder);
  if (bindings.length === 0) return leaf(node, 'empty_statement');
  const declarators = bindings.flatMap(([name, value], index) => [
    ...(index === 0 ? [] : [{ node: token(node, ','), fieldName: undefined }]),
    { node: variableDeclarator(node, name, value), fieldName: undefined },
  ]);
  return unstepped(
    assemble(node, 'variable_declaration', [
      { node: token(node, 'var'), fieldName: undefined },
      ...declarators,
      { node: token(node, ';'), fieldName: undefined },
    ])
  );
}

/** The bindings an import statement initializes at the top of the module. */
function importBindings(node: TreeNode, clause: TreeNode, source: TreeNode, binder: Binder): [string, ViewNode][] {
  const moduleName = stringValue(source);
  const ambientExports = binder.ambientModules.get(moduleName)?.namespaceExports;
  const importedNamespace = (): ViewNode => {
    const mod = leaf(source, IMPORTED_MODULE, source.text);
    mod.isNamespaceImport = true;
    return mod;
  };
  const bindings: [string, ViewNode][] = [];
  let needsSharedNamespace = false;
  for (const part of clause.namedChildren) {
    if (part?.type === 'identifier') {
      needsSharedNamespace = true;
    } else if (part?.type === 'namespace_import') {
      const name = part.namedChildren[0];
      if (name) bindings.push([nameOf(name), importedNamespace()]);
    } else if (part?.type === 'named_imports' && hasValueImportSpecifier(part, { moduleName, ambientExports })) {
      needsSharedNamespace = true;
    }
  }
  if (needsSharedNamespace) {
    bindings.unshift([contextOf(binder).importReceiverFor(node, moduleName), importedNamespace()]);
  }
  return bindings;
}

function hasValueImportSpecifier(
  namedImports: TreeNode,
  context: { moduleName: string; ambientExports: Scope | undefined }
): boolean {
  return namedImports.namedChildren.some((specifier) => {
    const imported = specifier?.childForFieldName('name');
    const local = specifier?.childForFieldName('alias') ?? imported;
    const importedName = imported ? (imported.type === 'string' ? stringValue(imported) : nameOf(imported)) : undefined;
    return (
      !!specifier &&
      !!importedName &&
      !!local &&
      local.type !== 'string' &&
      !isTypeOnlySpecifier(specifier, importedName, context)
    );
  });
}

function isTypeOnlySpecifier(
  specifier: TreeNode,
  importedName: string,
  { moduleName, ambientExports }: { moduleName: string; ambientExports: Scope | undefined }
): boolean {
  if (specifier.children.some((child) => !child.isNamed && child.type === 'type')) return true;
  if (fsImportMeanings(moduleName, importedName)?.value === false && !ambientExports?.values.has(importedName))
    return true;
  return (
    ambientExports !== undefined && !ambientExports.values.has(importedName) && ambientExports.types.has(importedName)
  );
}

const unnamedDefaultFunctionViewTypes: Record<string, string> = {
  function_declaration: 'function_expression',
  generator_function_declaration: 'generator_function',
};

/**
 * A top-level `export`, which runs as what it declares, or its default value as an expression statement; an export of
 * names declared elsewhere runs nothing.
 */
function exportView(node: TreeNode, binder: Binder): ViewNode {
  const declaration = node.childForFieldName('declaration');
  if (declaration && !declaration.childForFieldName('name')) {
    if (declaration.type === 'class_declaration' || declaration.type === 'abstract_class_declaration') {
      const viewed = withDefaultName(generic(declaration, 'class', binder));
      viewed.isUnnamedDefaultClassDeclaration = true;
      return expressionStatement(node, viewed);
    }
    const fnType = unnamedDefaultFunctionViewTypes[declaration.type];
    if (fnType) return unstepped(expressionStatement(node, withDefaultName(generic(declaration, fnType, binder))));
  }
  if (declaration) return view(declaration, binder);
  const value = node.childForFieldName('value');
  return value ? expressionStatement(node, withDefaultName(view(value, binder))) : leaf(node, 'empty_statement');
}

function withDefaultName(viewed: ViewNode): ViewNode {
  if (viewed.type !== 'member_expression' && viewed.type !== 'subscript_expression') viewed.inferredName = 'default';
  return viewed;
}

/** `import X = N.Y` as TypeScript compiles it, `var X = N.Y;`, or nothing when `N.Y` has no value. */
function importAliasView(node: TreeNode, binder: Binder): ViewNode {
  const [name, target] = node.namedChildren;
  if (!name || !target) return leaf(node, 'empty_statement');
  const path = namespacePathOf(target);
  const rootName = nameOf(path[0]);
  const root = binder.lookupValue(target, rootName);
  if (!root || !resolveImportAliasValue(path, binder)) return leaf(node, 'empty_statement');
  const namespace = namespaceOfReference(path[0], root, binder);
  let value =
    rewrittenIdentifierReference(path[0], binder) ??
    (namespace
      ? memberReference(path[0], namespace, rootName)
      : root.valueKind === 'enumMember'
        ? enumMemberReference(path[0], root.valueDeclaration as TreeNode, binder)
        : leaf(path[0], 'identifier', rootName));
  let text = value.text;
  for (const part of path.slice(1)) {
    const memberName = nameOf(part);
    text = `${text}.${memberName}`;
    value = assemble(
      part,
      'member_expression',
      [
        { node: value, fieldName: 'object' },
        { node: token(part, '.'), fieldName: undefined },
        { node: leaf(part, 'property_identifier', memberName), fieldName: 'property' },
      ],
      text
    );
  }
  return varDeclaration(node, nameOf(name), value);
}

type AliasValueTarget = { kind: 'symbol'; symbol: Sym } | { kind: 'builtinModule'; module: string } | { kind: 'value' };

function resolveImportAliasValue(
  path: TreeNode[],
  binder: Binder,
  seen = new Set<number>()
): AliasValueTarget | undefined {
  let current = unwrapAliasSymbol(binder.lookupValue(path[0], nameOf(path[0])), binder, seen);
  for (const [index, part] of path.slice(1).entries()) {
    if (!current) return undefined;
    current = stepAliasTarget(current, nameOf(part), index === path.length - 2, binder, seen);
  }
  if (!current || current.kind !== 'symbol') return current;
  return current.symbol.valueEntries.some((entry) => entry.kind !== 'namespace') ||
    isInstantiatedNamespace(current.symbol)
    ? current
    : undefined;
}

function stepAliasTarget(
  current: AliasValueTarget,
  partName: string,
  isLast: boolean,
  binder: Binder,
  seen: Set<number>
): AliasValueTarget | undefined {
  if (current.kind === 'builtinModule') {
    if (isLast && fsImportMeanings(current.module, partName)?.value) return { kind: 'value' };
    const augmented = binder.ambientModules.get(current.module)?.namespaceExports?.values.get(partName);
    return unwrapAliasSymbol(augmented, binder, seen);
  }
  if (current.kind !== 'symbol') return undefined;
  const member =
    current.symbol.valueKind === 'enum' && isLast
      ? current.symbol.enumMembers?.values.get(partName)
      : current.symbol.namespaceExports?.values.get(partName);
  return unwrapAliasSymbol(member, binder, seen);
}

function unwrapAliasSymbol(symbol: Sym | undefined, binder: Binder, seen: Set<number>): AliasValueTarget | undefined {
  if (!symbol) return undefined;
  if (symbol.valueKind === 'importAlias') {
    const declaration = symbol.valueDeclarations.find((candidate) => candidate.type === 'import_alias');
    const target = declaration?.namedChildren[1];
    if (!declaration || !target || seen.has(declaration.id)) return undefined;
    seen.add(declaration.id);
    return resolveImportAliasValue(namespacePathOf(target), binder, seen);
  }
  if (symbol.valueKind !== 'import') return { kind: 'symbol', symbol };
  return symbol.importTarget ? unwrapImportTarget(symbol.importTarget, binder, seen) : undefined;
}

function unwrapImportTarget(
  target: NonNullable<Sym['importTarget']>,
  binder: Binder,
  seen: Set<number>
): AliasValueTarget | undefined {
  if (target.typeOnly) return undefined;
  if (target.module === 'fs' || target.module === 'node:fs') {
    if (target.name === '*' || target.name === 'default') return { kind: 'builtinModule', module: target.module };
    if (fsImportMeanings(target.module, target.name)?.value) return { kind: 'value' };
    const augmented = binder.ambientModules.get(target.module)?.namespaceExports?.values.get(target.name);
    return unwrapAliasSymbol(augmented, binder, seen);
  }
  const ambient = binder.ambientModules.get(target.module);
  if (ambient) {
    return target.name === '*' || (target.name === 'default' && !ambient.namespaceExports?.values.has('default'))
      ? { kind: 'symbol', symbol: ambient }
      : unwrapAliasSymbol(ambient.namespaceExports?.values.get(target.name), binder, seen);
  }
  return { kind: 'value' };
}

/** The statements of the first namespace of a path `A.B.C`, which declare the next ones down to the body's. */
function buildNamespacePath(
  node: TreeNode,
  { body, path, emitsBody }: { body: TreeNode; path: TreeNode[]; emitsBody: boolean },
  binder: Binder
): { statements: ViewNode[]; outermostReceiver: string; outermostSymbol: Sym | undefined } {
  const context = contextOf(binder);
  const symbols = namespacePathSymbols(node, body, path, binder);
  const receivers = path.map((part) => context.freshHelperName(nameOf(part)));
  context.bodyReceivers.set(
    body.id,
    path.map((_, index) => ({ symbol: symbols[index], receiver: receivers[index] })).toReversed()
  );
  let statements = emitsBody ? namespaceBodyStatements(body, receivers.at(-1) as string, binder) : [];
  for (let index = path.length - 1; index > 0; index--) {
    const isNamespaceFirst = declaresNamespaceVar(symbols[index]);
    statements = exportedNamespaceStatements(
      node,
      { name: nameOf(path[index]), receiver: receivers[index], outerReceiver: receivers[index - 1] },
      statements,
      { isPathPart: true, isNamespaceFirst }
    );
  }
  return { statements, outermostReceiver: receivers[0], outermostSymbol: symbols[0] };
}

function namespacePathSymbols(node: TreeNode, body: TreeNode, path: TreeNode[], binder: Binder): (Sym | undefined)[] {
  const symbols: (Sym | undefined)[] = [];
  let current = binder.lookupValue(node, nameOf(path[0])) ?? binder.lookupNamespace(node, nameOf(path[0]));
  symbols.push(current);
  for (const part of path.slice(1)) {
    const partName = nameOf(part);
    current = current?.namespaceExports?.values.get(partName) ?? current?.namespaceExports?.namespaces.get(partName);
    symbols.push(current);
  }
  symbols[path.length - 1] ??= binder.ownScope(body)?.namespace;
  return symbols;
}

function namespaceBodyStatements(body: TreeNode, namespaceName: string, binder: Binder): ViewNode[] {
  const statements: ViewNode[] = [];
  for (const child of body.namedChildren) {
    if (!child) continue;
    const declaration = child.type === 'export_statement' ? child.childForFieldName('declaration') : undefined;
    if (declaration) statements.push(...exportStatements(declaration, namespaceName, binder));
    else if (!erasedStatementTypes.has(child.type) && child.type !== 'comment') statements.push(view(child, binder));
  }
  return statements;
}

/** The statements an `export` in a namespace compiles to, which make what it declares properties of the namespace. */
function exportStatements(declaration: TreeNode, namespaceName: string, binder: Binder): ViewNode[] {
  if (erasedStatementTypes.has(declaration.type)) return [];
  const inner = declaration.type === 'expression_statement' ? declaration.namedChildren[0] : declaration;
  if (inner && (inner.type === 'internal_module' || inner.type === 'module'))
    return exportedNamespace(inner, namespaceName, binder);
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration')
    return exportedVariables(declaration, namespaceName, binder);
  const name =
    declaration.type === 'import_alias' ? declaration.namedChildren[0] : declaration.childForFieldName('name');
  const exportedName = name ? nameOf(name) : undefined;
  const statements: ViewNode[] = [];
  if (declaration.type === 'enum_declaration' && exportedName) {
    statements.push(
      unstepped(
        varDeclaration(
          declaration,
          exportedName,
          orEmptyObject(declaration, `${namespaceName}.${exportedName}`, () =>
            memberReference(declaration, namespaceName, exportedName)
          )
        )
      )
    );
  }
  const viewed = view(declaration, binder);
  statements.push(viewed);
  // An import alias of a type only declares no value, so there is nothing to export.
  if (exportedName && viewed.type !== 'empty_statement')
    statements.push(unstepped(exportAssignment(declaration, namespaceName, exportedName)));
  return statements;
}

function exportedNamespace(node: TreeNode, outerReceiver: string, binder: Binder): ViewNode[] {
  const emitted = emittedNamespacePath(node);
  if (!emitted) return [];
  const { path, body, emitsBody } = emitted;
  const { statements, outermostReceiver, outermostSymbol } = buildNamespacePath(
    node,
    { body, path, emitsBody },
    binder
  );
  const isNamespaceFirst = declaresNamespaceVar(outermostSymbol);
  return exportedNamespaceStatements(
    node,
    { name: nameOf(path[0]), receiver: outermostReceiver, outerReceiver },
    statements,
    { isPathPart: false, isNamespaceFirst }
  );
}

/** `export const a = 1, b = 2;` as `N.a = 1, N.b = 2;`, whose variables are only the namespace's properties. */
function exportedVariables(declaration: TreeNode, namespaceName: string, binder: Binder): ViewNode[] {
  const assignments = declaration.namedChildren.flatMap((declarator) => {
    const name = declarator?.childForFieldName('name');
    const value = declarator?.childForFieldName('value');
    if (!declarator || !name || !value) return [];
    const target =
      name.type === 'identifier'
        ? exportedMemberReference(name, namespaceName, nameOf(name))
        : exportedPattern(name, namespaceName, binder);
    return [assignment(declarator, target, view(value, binder))];
  });
  if (assignments.length <= 1) return assignments.map((expression) => expressionStatement(declaration, expression));
  const parts = assignments.flatMap((part, index) => [
    ...(index === 0 ? [] : [{ node: token(declaration, ','), fieldName: undefined }]),
    { node: part, fieldName: undefined },
  ]);
  return [expressionStatement(declaration, assemble(declaration, 'sequence_expression', parts))];
}

/**
 * A destructuring pattern that an exported declaration binds, as the assignment pattern TypeScript compiles it to,
 * which assigns the namespace's properties: `{ a, b = 1 }` becomes `{ a: N.a, b: N.b = 1 }`, and the names elsewhere in
 * it read as the namespace's properties already.
 */
function exportedPattern(node: TreeNode, namespaceName: string, binder: Binder): ViewNode {
  if (node.type === 'identifier') return exportedMemberReference(node, namespaceName, nameOf(node));
  if (node.type === 'shorthand_property_identifier_pattern')
    return pairPattern(node, node, exportedMemberReference(node, namespaceName, nameOf(node)));
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (node.type === 'object_assignment_pattern' && left?.type === 'shorthand_property_identifier_pattern' && right)
    return pairPattern(
      node,
      left,
      defaultedTarget(node, exportedMemberReference(left, namespaceName, nameOf(left)), right, binder)
    );
  if (!exportedPatternTypes.has(node.type)) return view(node, binder);
  return assemble(
    node,
    node.type,
    node.children.flatMap((child, index) => {
      if (!child || child.type === 'comment') return [];
      const fieldName = node.fieldNameForChild(index);
      const viewed =
        !child.isNamed || fieldName === 'key' ? view(child, binder) : exportedPattern(child, namespaceName, binder);
      return [{ node: viewed, fieldName }];
    })
  );
}

/** `var B = (($ns_B) => { ... })(B = $ns_A.B || ($ns_A.B = {}));` for a namespace `B` that `A` exports. */
function exportedNamespaceStatements(
  node: TreeNode,
  { name, receiver, outerReceiver }: { name: string; receiver: string; outerReceiver: string },
  statements: ViewNode[],
  { isPathPart, isNamespaceFirst }: { isPathPart: boolean; isNamespaceFirst: boolean }
): ViewNode[] {
  const exported = orEmptyObject(node, `${outerReceiver}.${name}`, () => memberReference(node, outerReceiver, name));
  const argument = isNamespaceFirst
    ? parenthesized(node, assignment(node, leaf(node, 'identifier', name), exported))
    : exported;
  const call = namespaceCall(node, receiver, statements, argument);
  const statement = isNamespaceFirst ? varDeclaration(node, name, call) : expressionStatement(node, call);
  return [isPathPart ? unstepped(statement) : statement];
}

function namespaceCall(node: TreeNode, name: string, statements: ViewNode[], argument: ViewNode): ViewNode {
  const returned = unstepped(
    assemble(node, 'return_statement', [
      { node: token(node, 'return'), fieldName: undefined },
      { node: leaf(node, 'identifier', name), fieldName: undefined },
      { node: token(node, ';'), fieldName: undefined },
    ])
  );
  const block = assemble(node, 'statement_block', [
    { node: token(node, '{'), fieldName: undefined },
    ...[...statements, returned].map((statement) => ({ node: statement, fieldName: undefined })),
    { node: token(node, '}'), fieldName: undefined },
  ]);
  const arrow = assemble(node, 'arrow_function', [
    { node: leaf(node, 'identifier', name), fieldName: 'parameter' },
    { node: token(node, '=>'), fieldName: undefined },
    { node: block, fieldName: 'body' },
  ]);
  arrow.hidesCallRow = true;
  const callee = assemble(node, 'parenthesized_expression', [
    { node: token(node, '('), fieldName: undefined },
    { node: arrow, fieldName: undefined },
    { node: token(node, ')'), fieldName: undefined },
  ]);
  const args = assemble(node, 'arguments', [
    { node: token(node, '('), fieldName: undefined },
    { node: argument, fieldName: undefined },
    { node: token(node, ')'), fieldName: undefined },
  ]);
  return assemble(node, 'call_expression', [
    { node: callee, fieldName: 'function' },
    { node: args, fieldName: 'arguments' },
  ]);
}

/** `object || (object = {})`, publishing a new namespace object before its body runs when none exists yet. */
function orEmptyObject(
  node: TreeNode,
  text: string,
  object: () => ViewNode = () => leaf(node, 'identifier', text)
): ViewNode {
  const empty = assemble(node, 'object', [
    { node: token(node, '{'), fieldName: undefined },
    { node: token(node, '}'), fieldName: undefined },
  ]);
  const initialized = parenthesized(node, assignment(node, object(), empty));
  return assemble(
    node,
    'binary_expression',
    [
      { node: object(), fieldName: 'left' },
      { node: token(node, '||'), fieldName: 'operator' },
      { node: initialized, fieldName: 'right' },
    ],
    `${text} || (${text} = {})`
  );
}

function parenthesized(node: TreeNode, inner: ViewNode): ViewNode {
  return assemble(node, 'parenthesized_expression', [
    { node: token(node, '('), fieldName: undefined },
    { node: inner, fieldName: undefined },
    { node: token(node, ')'), fieldName: undefined },
  ]);
}

function varDeclaration(node: TreeNode, name: string, value: ViewNode): ViewNode {
  return assemble(node, 'variable_declaration', [
    { node: token(node, 'var'), fieldName: undefined },
    { node: variableDeclarator(node, name, value), fieldName: undefined },
    { node: token(node, ';'), fieldName: undefined },
  ]);
}

function variableDeclarator(node: TreeNode, name: string, value: ViewNode): ViewNode {
  return assemble(node, 'variable_declarator', [
    { node: leaf(node, 'identifier', name), fieldName: 'name' },
    { node: token(node, '='), fieldName: undefined },
    { node: value, fieldName: 'value' },
  ]);
}

function exportAssignment(node: TreeNode, namespaceName: string, name: string): ViewNode {
  return expressionStatement(
    node,
    assignment(node, memberReference(node, namespaceName, name), leaf(node, 'identifier', name))
  );
}

function assignment(node: TreeNode, target: ViewNode, value: ViewNode): ViewNode {
  return assemble(node, 'assignment_expression', [
    { node: target, fieldName: 'left' },
    { node: token(node, '='), fieldName: 'operator' },
    { node: value, fieldName: 'right' },
  ]);
}

function expressionStatement(node: TreeNode, expression: ViewNode): ViewNode {
  return assemble(node, 'expression_statement', [
    { node: expression, fieldName: undefined },
    { node: token(node, ';'), fieldName: undefined },
  ]);
}

function unstepped(statement: ViewNode): ViewNode {
  statement.isUnstepped = true;
  return statement;
}

/** Whether the view added a statement that records no step of its own. */
export function isUnsteppedStatement(node: Node): boolean {
  return node instanceof ViewNode && node.isUnstepped;
}

/** Whether the view synthesized a wrapper function whose invocation is not a source-level call in traces. */
export function isHiddenCallFunction(node: Node): boolean {
  return node instanceof ViewNode && node.hidesCallRow;
}

/** The inferred name a synthesized namespace-export target or anonymous default export carries, if any. */
export function inferredTargetNameOf(node: Node): string | undefined {
  return node instanceof ViewNode ? node.inferredName : undefined;
}

/** Whether a viewed `class` came from an unnamed `export default [abstract] class` declaration. */
export function isUnnamedDefaultClassDeclaration(node: Node): boolean {
  return node instanceof ViewNode && node.isUnnamedDefaultClassDeclaration;
}

/** Whether a synthesized member expression calls its function with an `undefined` receiver. */
export function isUnboundCallMember(node: Node): boolean {
  return node instanceof ViewNode && node.isUnboundCall;
}

/** Whether an `imported_module` node wraps the module in an ESM namespace object. */
export function isNamespaceImportNode(node: Node): boolean {
  return node instanceof ViewNode && node.isNamespaceImport;
}

/** Whether a viewed root program came from an external module (`import` or `export` at top level). */
export function isExternalModuleView(node: Node): boolean {
  return node instanceof ViewNode && node.isExternalModule;
}

/** Generated helper binding names allocated for a viewed program, omitted from learner trace snapshots. */
export function hiddenNamesOf(node: Node): ReadonlySet<string> | undefined {
  return node instanceof ViewNode ? node.hiddenNames : undefined;
}

/** The collision-free alias bound to an enum's object when a member initializer shadows the enum's name. */
export function enumAliasOf(node: Node): string | undefined {
  return node instanceof ViewNode ? node.enumAlias : undefined;
}

function namespacePathOf(name: TreeNode): TreeNode[] {
  if (name.type !== 'nested_identifier' && name.type !== 'member_expression') return [name];
  const object = name.childForFieldName('object');
  const property = name.childForFieldName('property');
  return [...(object ? namespacePathOf(object) : []), ...(property ? [property] : [])];
}

function isThisParameter(node: TreeNode): boolean {
  return node.type === 'required_parameter' && node.childForFieldName('pattern')?.type === 'this';
}

/** A parameter as JavaScript spells it: its pattern, with its default value as an assignment pattern. */
function parameter(node: TreeNode, binder: Binder): ViewNode {
  const pattern = view(node.childForFieldName('pattern') as TreeNode, binder);
  const value = node.childForFieldName('value');
  if (!value) return pattern;
  return assemble(node, 'assignment_pattern', [
    { node: pattern, fieldName: 'left' },
    { node: leaf(node, '=', '=', false), fieldName: undefined },
    { node: view(value, binder), fieldName: 'right' },
  ]);
}

/** A class heritage as JavaScript spells it: `extends` and the superclass, without `implements` or type arguments. */
function heritage(node: TreeNode, binder: Binder): ViewNode {
  const extendsClause = node.namedChildren.find((child) => child?.type === 'extends_clause');
  const value = extendsClause?.childForFieldName('value');
  if (!extendsClause || !value) return assemble(node, 'class_heritage', []);
  return assemble(node, 'class_heritage', [
    { node: leaf(extendsClause, 'extends', 'extends', false), fieldName: undefined },
    { node: view(value, binder), fieldName: undefined },
  ]);
}

/**
 * A class body without its type-only members, where each parameter property of the constructor becomes a field
 * declared before the others, which the constructor assigns once `this` exists.
 */
function classBody(node: TreeNode, binder: Binder): ViewNode {
  const parts: Part[] = [];
  const parameterProperties: ViewNode[] = [];
  for (const [index, child] of node.children.entries()) {
    if (!child || erasedClassMembers.has(child.type) || isTypeOnlyField(child)) continue;
    const viewed = isConstructorDefinition(child)
      ? constructorWithProperties(child, parameterProperties, binder)
      : view(child, binder);
    parts.push({ node: viewed, fieldName: node.fieldNameForChild(index) });
  }
  // Fields go after the opening brace, before the members the body declares.
  parts.splice(1, 0, ...parameterProperties.map((field) => ({ node: field, fieldName: undefined })));
  return assemble(node, 'class_body', parts);
}

/** Whether a field only declares a type: an abstract field, or one marked `declare`. */
function isTypeOnlyField(node: TreeNode): boolean {
  return (
    node.type === 'field_definition' &&
    node.children.some((child) => child?.type === 'abstract' || child?.type === 'declare')
  );
}

/**
 * The parameters of a constructor that declare properties, such as `private x: number`. A binding pattern declares
 * none, as the checker rejects it.
 */
function parameterPropertiesOf(constructorNode: TreeNode): TreeNode[] {
  const parameters = constructorNode.childForFieldName('parameters');
  return (parameters?.namedChildren ?? []).filter(
    (parameterNode): parameterNode is TreeNode =>
      parameterNode?.childForFieldName('pattern')?.type === 'identifier' && isParameterProperty(parameterNode)
  );
}

function constructorWithProperties(node: TreeNode, fields: ViewNode[], binder: Binder): ViewNode {
  const viewed = view(node, binder);
  const properties = parameterPropertiesOf(node);
  if (properties.length === 0) return viewed;
  const assignments: ViewNode[] = [];
  for (const property of properties) {
    const name = property.childForFieldName('pattern') as TreeNode;
    fields.push(
      assemble(property, 'field_definition', [{ node: leaf(name, 'property_identifier'), fieldName: 'name' }])
    );
    assignments.push(leaf(name, PARAMETER_PROPERTY_ASSIGNMENT));
  }
  const body = viewed.childForFieldName('body') as ViewNode;
  body.children.splice(1, 0, ...assignments);
  return viewed;
}
