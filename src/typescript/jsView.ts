import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Node } from '../javascript/convertNodes';

/**
 * The type of a synthesized statement that copies a constructor's parameter properties to `this`, which the
 * TypeScript converter handles, since JavaScript has no syntax for it.
 */
export const PARAMETER_PROPERTY_ASSIGNMENT = 'parameter_property_assignment';

/** A node of the view, which may stand for a tree-sitter node or be synthesized from one. */
class ViewNode implements Node {
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

/** Fields that hold only types, which running a program ignores. */
const typeFields = new Set(['type', 'return_type', 'type_parameters', 'type_arguments']);
/** Children that only declare types or modifiers that running a program ignores. */
const typeOnlyNodes = new Set([
  'type_annotation',
  'type_parameters',
  'type_arguments',
  'accessibility_modifier',
  'override_modifier',
  'type_predicate_annotation',
  'asserts_annotation',
]);
/** Expressions that only state a type of the expression they wrap. */
const assertionTypes = new Set(['as_expression', 'satisfies_expression', 'non_null_expression', 'type_assertion']);
/** Declarations without any effect at run time. */
const typeDeclarations = new Set(['interface_declaration', 'type_alias_declaration', 'function_signature']);
/** Class members without any effect at run time. */
const typeMembers = new Set(['method_signature', 'abstract_method_signature', 'index_signature']);
/** Modifier tokens of members, parameters, and declarators that running a program ignores. */
const memberModifiers = new Set(['readonly', 'abstract', 'declare', '?', '!', 'override']);
const modifiedTypes = new Set([
  'public_field_definition',
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
export function javaScriptViewOf(root: TreeNode): Node {
  return view(root);
}

function view(node: TreeNode): ViewNode {
  if (assertionTypes.has(node.type)) return view(assertedExpression(node));
  switch (node.type) {
    case 'required_parameter':
    case 'optional_parameter': {
      return parameter(node);
    }
    case 'class_heritage': {
      return heritage(node);
    }
    case 'class_body': {
      return classBody(node);
    }
    case 'abstract_class_declaration': {
      return generic(node, 'class_declaration');
    }
    case 'public_field_definition': {
      return generic(node, 'field_definition');
    }
    default: {
      return typeDeclarations.has(node.type) ? leaf(node, 'empty_statement') : generic(node, node.type);
    }
  }
}

/** The expression an assertion wraps, which follows the type in `<T>x` and precedes it otherwise. */
function assertedExpression(node: TreeNode): TreeNode {
  const children = node.namedChildren.filter((child) => child !== null);
  return (node.type === 'type_assertion' ? children.at(-1) : children[0]) as TreeNode;
}

function generic(node: TreeNode, type: string): ViewNode {
  const parts: Part[] = [];
  for (const [index, child] of node.children.entries()) {
    if (!child) continue;
    const fieldName = node.fieldNameForChild(index);
    if (!isErased(node, type, child, fieldName ?? undefined)) parts.push({ node: view(child), fieldName });
  }
  return assemble(node, type, parts);
}

/** Whether a child is TypeScript-only syntax, which the JavaScript view leaves out. */
function isErased(node: TreeNode, type: string, child: TreeNode, fieldName: string | undefined): boolean {
  if (fieldName && typeFields.has(fieldName)) return true;
  if (typeOnlyNodes.has(child.type)) return true;
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

function isThisParameter(node: TreeNode): boolean {
  return node.type === 'required_parameter' && node.childForFieldName('pattern')?.type === 'this';
}

/** A parameter as JavaScript spells it: its pattern, with its default value as an assignment pattern. */
function parameter(node: TreeNode): ViewNode {
  const pattern = view(node.childForFieldName('pattern') as TreeNode);
  const value = node.childForFieldName('value');
  if (!value) return pattern;
  return assemble(node, 'assignment_pattern', [
    { node: pattern, fieldName: 'left' },
    { node: leaf(node, '=', '=', false), fieldName: undefined },
    { node: view(value), fieldName: 'right' },
  ]);
}

/** A class heritage as JavaScript spells it: `extends` and the superclass, without `implements` or type arguments. */
function heritage(node: TreeNode): ViewNode {
  const extendsClause = node.namedChildren.find((child) => child?.type === 'extends_clause');
  const value = extendsClause?.childForFieldName('value');
  if (!extendsClause || !value) return assemble(node, 'class_heritage', []);
  return assemble(node, 'class_heritage', [
    { node: leaf(extendsClause, 'extends', 'extends', false), fieldName: undefined },
    { node: view(value), fieldName: undefined },
  ]);
}

/**
 * A class body without its type-only members, where each parameter property of the constructor becomes a field
 * declared before the others, which the constructor assigns once `this` exists.
 */
function classBody(node: TreeNode): ViewNode {
  const parts: Part[] = [];
  const parameterProperties: ViewNode[] = [];
  for (const [index, child] of node.children.entries()) {
    if (!child || typeMembers.has(child.type) || isTypeOnlyField(child)) continue;
    const viewed = isConstructor(child) ? constructorWithProperties(child, parameterProperties) : view(child);
    parts.push({ node: viewed, fieldName: node.fieldNameForChild(index) });
  }
  // Fields go after the opening brace, before the members the body declares.
  parts.splice(1, 0, ...parameterProperties.map((field) => ({ node: field, fieldName: undefined })));
  return assemble(node, 'class_body', parts);
}

/** Whether a field only declares a type: an abstract field, or one marked `declare`. */
function isTypeOnlyField(node: TreeNode): boolean {
  return (
    node.type === 'public_field_definition' &&
    node.children.some((child) => child?.type === 'abstract' || child?.type === 'declare')
  );
}

function isConstructor(node: TreeNode): boolean {
  return (
    node.type === 'method_definition' &&
    node.childForFieldName('name')?.text === 'constructor' &&
    !node.children.some((child) => child?.type === 'static')
  );
}

/** The parameters of a constructor that declare properties, such as `private x: number`. */
export function parameterPropertiesOf(constructorNode: TreeNode): TreeNode[] {
  const parameters = constructorNode.childForFieldName('parameters');
  return (parameters?.namedChildren ?? []).filter(
    (parameterNode): parameterNode is TreeNode =>
      parameterNode !== null &&
      (parameterNode.type === 'required_parameter' || parameterNode.type === 'optional_parameter') &&
      parameterNode.children.some(
        (child) => child?.type === 'accessibility_modifier' || child?.type === 'readonly' || child?.type === 'override'
      )
  );
}

function constructorWithProperties(node: TreeNode, fields: ViewNode[]): ViewNode {
  const viewed = view(node);
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
  const statements = body.children;
  // A derived class's constructor assigns them once `super(...)` returns, before the statements after it.
  const superCall = statements.findIndex(isSuperCallStatement);
  statements.splice(superCall === -1 ? 1 : superCall + 1, 0, ...assignments);
  return viewed;
}

function isSuperCallStatement(statement: ViewNode): boolean {
  if (statement.type !== 'expression_statement') return false;
  const expression = statement.namedChildren[0];
  return expression?.type === 'call_expression' && expression.childForFieldName('function')?.type === 'super';
}
