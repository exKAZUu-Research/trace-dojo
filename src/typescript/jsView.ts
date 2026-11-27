import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../interpreter/limits';
import { nameOf, type Node } from '../javascript/convertNodes';
import { isConstructorDefinition } from '../javascript/programConverter';
import { Binder } from './checker/binder';
import { Scope, type Sym } from './checker/scopes';
import { isParameterProperty } from './checker/syntax';
import {
  assertedExpression,
  assertionTypes,
  erasedClassMembers,
  erasedStatementTypes,
  erasedTypeNodes,
} from './erasedSyntax';
import { blockHasRuntimeCode, isAmbient, isInstantiatedNamespace } from './namespaceInstantiation';

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

/**
 * Views a TypeScript tree as the JavaScript tree that erasing its types leaves, so that the JavaScript converter can
 * convert it: types, type-only declarations, and type assertions disappear, parameters become their patterns, and
 * parameter properties become fields that the constructor assigns.
 */
export function javaScriptViewOf(root: TreeNode, budget: ExecutionBudget): Node {
  const binder = new Binder(root, new Scope('global', undefined, undefined), { budget, skipAssignmentAnalysis: true });
  for (const scope of binder.allScopes)
    for (const symbol of scope.values.values()) {
      budget.spend();
      const name = symbol.valueEntries[0]?.name;
      if (name) scope.values.set(nameOf(name), symbol);
    }
  return view(root, binder);
}

/** The TypeScript declarations that compile to code of their own, and the names a namespace's exports change. */
const compiledDeclarations: Record<string, (node: TreeNode, binder: Binder) => ViewNode> = {
  shorthand_property_identifier: (node, binder) => shorthandPropertyView(node, binder),
  module: (node, binder) => namespaceView(node, binder),
  internal_module: (node, binder) => namespaceView(node, binder),
  import_alias: (node, binder) => importAliasView(node, binder),
  import_statement: (node) => importView(node),
  export_statement: (node, binder) => exportView(node, binder),
};

function view(node: TreeNode, binder: Binder): ViewNode {
  const compiled = compiledDeclarations[node.type] as ((node: TreeNode, binder: Binder) => ViewNode) | undefined;
  if (compiled) return compiled(node, binder);
  if (assertionTypes.has(node.type)) return view(assertedExpression(node) as TreeNode, binder);
  switch (node.type) {
    case 'required_parameter':
    case 'optional_parameter': {
      return parameter(node, binder);
    }
    case 'class_heritage': {
      return heritage(node, binder);
    }
    case 'class_body': {
      return classBody(node, binder);
    }
    case 'abstract_class_declaration': {
      return generic(node, 'class_declaration', binder);
    }
    case 'field_definition': {
      return generic(node, 'field_definition', binder);
    }
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
    case 'identifier': {
      return identifierView(node, binder);
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

function rewrittenIdentifierReference(node: TreeNode, binder: Binder): ViewNode | undefined {
  const symbol = binder.lookupValue(node, nameOf(node));
  const namespace = namespaceOfReference(node, symbol);
  if (namespace) return memberReference(node, namespace, nameOf(node));
  // An enum's initializers refer to its members by name, which compiles to reading them from the enum object.
  if (symbol?.valueKind === 'enumMember') return enumMemberReference(node, symbol.valueDeclaration as TreeNode);
  return undefined;
}

/**
 * The namespace whose object a name is read from: a namespace's exported variable is a property of its object, which
 * its declarations read, as is any export that another declaration of the namespace reads, where the name has no
 * binding of its own.
 */
function namespaceOfReference(node: TreeNode, symbol: Sym | undefined): string | undefined {
  if (!symbol?.exportedFrom) return undefined;
  const isProperty =
    exportedVariableKinds.has(symbol.valueKind ?? '') ||
    namespaceBodyOf(node)?.id !== namespaceBodyOf(symbol.valueDeclaration)?.id;
  return isProperty ? symbol.exportedFrom.name : undefined;
}

/** The body of the namespace declaration a node is in, whose function binds the names it declares. */
function namespaceBodyOf(node: TreeNode | undefined): TreeNode | undefined {
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
  return new ViewNode(type, text, isNamed, node, [], new Map());
}

/** `E.A` for a member `A` of the enum `E`, which the identifier `A` in an initializer of `E` stands for. */
function enumMemberReference(node: TreeNode, member: TreeNode): ViewNode {
  return memberReference(node, member.parent?.parent?.childForFieldName('name')?.text ?? '', nameOf(node));
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
  const name = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!name || !body || name.type === 'string' || !blockHasRuntimeCode(body)) return leaf(node, 'empty_statement');
  const path = namespacePathOf(name);
  const statements = nestedNamespaceStatements(node, body, path, binder);
  const outermost = path[0].text;
  const call = namespaceCall(node, outermost, statements, orEmptyObject(node, outermost));
  // Every block passes the object the blocks before it made, or a new one, so no block needs to know whether it is
  // first; a class, function, or enum declared before the namespace already declares its name.
  const isNamespaceFirst = declaresNamespaceVar(binder.lookupValue(node, outermost));
  return isNamespaceFirst ? varDeclaration(node, outermost, call) : expressionStatement(node, call);
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
 * An `import` of a Node.js module as tsx compiles it for a CommonJS program, which reads the module with `require`:
 * `var fs = require("fs");` (for a default or namespace import) and `var readFileSync = require("fs").readFileSync;`. A
 * type-only one compiles to nothing.
 */
function importView(node: TreeNode): ViewNode {
  const clause = node.childForFieldName('import_clause');
  const source = node.childForFieldName('source');
  if (!clause || !source || node.children.some((child) => child?.type === 'type')) return leaf(node, 'empty_statement');
  const bindings = importBindings(node, clause, source);
  if (bindings.length === 0) return leaf(node, 'empty_statement');
  const declarators = bindings.flatMap(([name, value], index) => [
    ...(index === 0 ? [] : [{ node: token(node, ','), fieldName: undefined }]),
    {
      node: assemble(node, 'variable_declarator', [
        { node: leaf(node, 'identifier', name), fieldName: 'name' },
        { node: token(node, '='), fieldName: undefined },
        { node: value, fieldName: 'value' },
      ]),
      fieldName: undefined,
    },
  ]);
  return unstepped(
    assemble(node, 'variable_declaration', [
      { node: token(node, 'var'), fieldName: undefined },
      ...declarators,
      { node: token(node, ';'), fieldName: undefined },
    ])
  );
}

/** The names an import declares, with the expressions that read them from the module `require` returns. */
function importBindings(node: TreeNode, clause: TreeNode, source: TreeNode): [string, ViewNode][] {
  const required = (): ViewNode => leaf(source, IMPORTED_MODULE, source.text);
  return clause.namedChildren.flatMap((part): [string, ViewNode][] => {
    // A default import is the whole module, as tsx's interop gives a CommonJS module without a default export.
    if (part?.type === 'identifier') return [[part.text, required()]];
    const name = part?.namedChildren[0];
    if (part?.type === 'namespace_import' && name) return [[name.text, required()]];
    if (part?.type !== 'named_imports') return [];
    return part.namedChildren.flatMap((specifier): [string, ViewNode][] => {
      const imported = specifier?.childForFieldName('name');
      const local = specifier?.childForFieldName('alias') ?? imported;
      if (!imported || !local || specifier?.children.some((child) => child?.type === 'type')) return [];
      const member = assemble(node, 'member_expression', [
        { node: required(), fieldName: 'object' },
        { node: token(node, '.'), fieldName: undefined },
        { node: leaf(imported, 'property_identifier', imported.text), fieldName: 'property' },
      ]);
      return [[local.text, member]];
    });
  });
}

/**
 * A top-level `export`, which runs as what it declares, or its default value as an expression statement; an export of
 * names declared elsewhere runs nothing.
 */
function exportView(node: TreeNode, binder: Binder): ViewNode {
  const declaration = node.childForFieldName('declaration');
  // `export default class { }` declares no name, so its class is only evaluated, as a class expression.
  if (declaration?.type === 'class_declaration' && !declaration.childForFieldName('name'))
    return expressionStatement(node, generic(declaration, 'class', binder));
  if (declaration) return view(declaration, binder);
  const value = node.childForFieldName('value');
  return value ? expressionStatement(node, view(value, binder)) : leaf(node, 'empty_statement');
}

/** `import X = N.Y` as TypeScript compiles it, `var X = N.Y;`, or nothing when `N.Y` has no value. */
function importAliasView(node: TreeNode, binder: Binder): ViewNode {
  const [name, target] = node.namedChildren;
  if (!name || !target) return leaf(node, 'empty_statement');
  const path = namespacePathOf(target);
  const rootName = nameOf(path[0]);
  const root = binder.lookupValue(target, rootName);
  const hasValue =
    root !== undefined &&
    (root.valueEntries.some((entry) => entry.kind !== 'namespace') || isInstantiatedNamespace(root));
  if (!hasValue) return leaf(node, 'empty_statement');
  const namespace = namespaceOfReference(path[0], root);
  let value = namespace
    ? memberReference(path[0], namespace, rootName)
    : root.valueKind === 'enumMember'
      ? enumMemberReference(path[0], root.valueDeclaration as TreeNode)
      : leaf(path[0], 'identifier', rootName);
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

/** The statements of the first namespace of a path `A.B.C`, which declare the next ones down to the body's. */
function nestedNamespaceStatements(node: TreeNode, body: TreeNode, path: TreeNode[], binder: Binder): ViewNode[] {
  let statements = namespaceBodyStatements(body, path.at(-1)?.text ?? '', binder);
  for (let index = path.length - 1; index > 0; index--) {
    const isNamespaceFirst = declaresNamespaceVar(binder.lookupValue(path[index], path[index].text));
    statements = exportedNamespaceStatements(node, path[index].text, path[index - 1].text, statements, {
      isPathPart: true,
      isNamespaceFirst,
    });
  }
  return statements;
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
  const statements = [view(declaration, binder)];
  // An import alias of a type only declares no value, so there is nothing to export.
  if (name && statements[0].type !== 'empty_statement')
    statements.push(unstepped(exportAssignment(declaration, namespaceName, nameOf(name))));
  return statements;
}

function exportedNamespace(node: TreeNode, outerName: string, binder: Binder): ViewNode[] {
  const name = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!name || !body || !blockHasRuntimeCode(body)) return [];
  const path = namespacePathOf(name);
  const statements = nestedNamespaceStatements(node, body, path, binder);
  const isNamespaceFirst = declaresNamespaceVar(binder.lookupValue(name, path[0].text));
  return exportedNamespaceStatements(node, path[0].text, outerName, statements, {
    isPathPart: false,
    isNamespaceFirst,
  });
}

/** `export const a = 1, b = 2;` as `N.a = 1, N.b = 2;`, whose variables are only the namespace's properties. */
function exportedVariables(declaration: TreeNode, namespaceName: string, binder: Binder): ViewNode[] {
  const assignments = declaration.namedChildren.flatMap((declarator) => {
    const name = declarator?.childForFieldName('name');
    const value = declarator?.childForFieldName('value');
    if (!declarator || !name || !value) return [];
    const target =
      name.type === 'identifier'
        ? memberReference(name, namespaceName, nameOf(name))
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
  const property = (name: TreeNode, value: ViewNode): ViewNode =>
    assemble(node, 'pair_pattern', [
      { node: leaf(name, 'property_identifier', name.text), fieldName: 'key' },
      { node: token(node, ':'), fieldName: undefined },
      { node: value, fieldName: 'value' },
    ]);
  if (node.type === 'shorthand_property_identifier_pattern')
    return property(node, memberReference(node, namespaceName, nameOf(node)));
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (node.type === 'object_assignment_pattern' && left?.type === 'shorthand_property_identifier_pattern' && right)
    return property(
      left,
      assemble(node, 'assignment_pattern', [
        { node: memberReference(left, namespaceName, nameOf(left)), fieldName: 'left' },
        { node: token(node, '='), fieldName: undefined },
        { node: view(right, binder), fieldName: 'right' },
      ])
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

/** `var B = ((B) => { ... })(B = A.B || (A.B = {}));` for a namespace `B` that the namespace `A` exports. */
function exportedNamespaceStatements(
  node: TreeNode,
  name: string,
  outerName: string,
  statements: ViewNode[],
  { isPathPart, isNamespaceFirst }: { isPathPart: boolean; isNamespaceFirst: boolean }
): ViewNode[] {
  const exported = orEmptyObject(node, `${outerName}.${name}`, () => memberReference(node, outerName, name));
  const argument = isNamespaceFirst
    ? parenthesized(node, assignment(node, leaf(node, 'identifier', name), exported))
    : exported;
  const call = namespaceCall(node, name, statements, argument);
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
  const declarator = assemble(node, 'variable_declarator', [
    { node: leaf(node, 'identifier', name), fieldName: 'name' },
    { node: token(node, '='), fieldName: undefined },
    { node: value, fieldName: 'value' },
  ]);
  return assemble(node, 'variable_declaration', [
    { node: token(node, 'var'), fieldName: undefined },
    { node: declarator, fieldName: undefined },
    { node: token(node, ';'), fieldName: undefined },
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
