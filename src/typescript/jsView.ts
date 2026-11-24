import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../interpreter/limits';
import { nameOf, type Node } from '../javascript/convertNodes';
import { isConstructorDefinition } from '../javascript/programConverter';
import { Binder } from './checker/binder';
import { Scope } from './checker/scopes';
import { isParameterProperty } from './checker/syntax';
import {
  assertedExpression,
  assertionTypes,
  erasedClassMembers,
  erasedStatementTypes,
  erasedTypeNodes,
} from './erasedSyntax';

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

function view(node: TreeNode, binder: Binder): ViewNode {
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
    case 'identifier': {
      // esbuild only lowers the unbound global to void 0; local bindings retain their values and assignment targets.
      return nameOf(node) === 'undefined' && !binder.lookupValue(node, 'undefined')
        ? leaf(node, 'undefined', '(void 0)')
        : generic(node, node.type, binder);
    }
    default: {
      return erasedStatementTypes.has(node.type) ? leaf(node, 'empty_statement') : generic(node, node.type, binder);
    }
  }
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
  const parts: Part[] = [];
  for (const [index, child] of node.children.entries()) {
    if (!child) continue;
    const fieldName = node.fieldNameForChild(index);
    if (!isErased(node, type, child, fieldName ?? undefined)) parts.push({ node: view(child, binder), fieldName });
  }
  return assemble(node, type, parts);
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
