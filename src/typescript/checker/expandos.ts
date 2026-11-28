import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { mayBeUnassignedAt } from './assignmentFlow';
import type { Checker } from './checker';
import { FlowState } from './flow';
import type { Sym } from './scopes';
import { isImmediatelyInvoked, named, stringValue } from './syntax';
import { anonymousObject, anyType, emptyStructure, type Property, type Signature, type Type, unionOf } from './types';

/** Functions and blocks whose bodies run when called, after the declarations that precede the call. */
export const laterRunningTypes = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

interface ExpandoAssignments {
  nodes: TreeNode[];
  types: Map<number, Type>;
  resolved?: Type;
}

/** The properties a program adds to a function it declares, as `f.description = "..."`, which TypeScript types. */
export class Expandos {
  /** The statements that add a property to a function, by the first of them, which the property names as its declaration. */
  private readonly assignmentsByFirst = new Map<number, TreeNode[]>();
  private readonly byAssignment = new Map<number, ExpandoAssignments>();
  private readonly typesBySymbol = new Map<number, Type>();

  constructor(private readonly c: Checker) {}

  /** The type of a `const` with the properties a program adds to the function it is initialized with. */
  constType(declarator: TreeNode, symbol: Sym, type: Type): Type {
    return isExpandoInitializer(declarator)
      ? this.withExpandos(this.c.signaturesOf(type, 'call'), type, declarator.parent?.parent, symbol)
      : type;
  }

  /** A function's type with the properties a program adds to it, as `f.description = "..."` in its block. */
  withExpandos(callSignatures: Signature[], type: Type, block: TreeNode | null | undefined, symbol: Sym): Type {
    const cached = this.typesBySymbol.get(symbol.id);
    if (cached) return cached;
    const expandos = new Map<string, TreeNode[]>();
    if (block) this.collectAssignments(block, symbol, expandos);
    const result =
      expandos.size === 0
        ? type
        : anonymousObject(
            () => {
              const structure = { ...emptyStructure(), callSignatures };
              for (const [property, assignments] of expandos) {
                this.assignmentsByFirst.set(assignments[0].id, assignments);
                const group: ExpandoAssignments = { nodes: assignments, types: new Map() };
                for (const assignment of assignments) this.byAssignment.set(assignment.id, group);
                structure.properties.set(property, {
                  ...this.c.literals.literalProperty(property, anyType, false, assignments[0]),
                  type: this.propertyType(property, group),
                });
              }
              return structure;
            },
            { isFunction: false }
          );
    this.typesBySymbol.set(symbol.id, result);
    return result;
  }

  recordAssignment(assignment: TreeNode, value: Type): void {
    if (this.c.silent || this.c.flow.probing) return;
    const group = this.byAssignment.get(assignment.id);
    if (!group) return;
    const type = this.c.widen(value);
    if (group.types.get(assignment.id) === type) return;
    group.types.set(assignment.id, type);
    group.resolved = undefined;
  }

  /**
   * The type of an added property, the union of the values assigned to it, resolved when first read; a property read
   * in its own assignments is `any`, as TypeScript reports.
   */
  private propertyType(property: string, assignments: ExpandoAssignments): () => Type {
    let resolving = false;
    return () => {
      if (assignments.resolved) return assignments.resolved;
      if (resolving) {
        const first = assignments.nodes[0];
        const left = first.childForFieldName('left') ?? first;
        this.c.errorWhileResolving(left, `${property} の型が、自分自身を参照しているため暗黙に any になります。`);
        assignments.resolved = anyType;
        return anyType;
      }
      resolving = true;
      try {
        const type = this.c.silently(() =>
          unionOf(assignments.nodes.map((node) => assignments.types.get(node.id) ?? this.assignmentType(node)))
        );
        assignments.resolved ??= type;
        return assignments.resolved;
      } finally {
        resolving = false;
      }
    };
  }

  private assignmentType(assignment: TreeNode): Type {
    return this.c.flow.probe(
      () => this.c.widen(this.c.expressions.check(assignment.childForFieldName('right') as TreeNode)),
      new FlowState()
    );
  }

  /** Collects assignments that add function properties in the same execution scope. */
  private collectAssignments(node: TreeNode, symbol: Sym, expandos: Map<string, TreeNode[]>): void {
    this.c.budget.spend();
    const left = node.type === 'assignment_expression' ? node.childForFieldName('left') : undefined;
    const object = left?.childForFieldName('object');
    const property = left ? expandoPropertyName(left) : undefined;
    if (
      object?.type === 'identifier' &&
      property !== undefined &&
      this.c.scopeOf(object).lookupValue(object.text) === symbol
    ) {
      expandos.set(property, [...(expandos.get(property) ?? []), node]);
    }
    for (const child of named(node)) {
      if (laterRunningTypes.has(child.type) || child.type === 'class_declaration' || child.type === 'class') continue;
      this.collectAssignments(child, symbol, expandos);
    }
  }

  /**
   * Reports a read of a property a program adds to a function where no statement adding it has run yet, when the read
   * names the property as those statements do and runs in the same function or file as the first of them. Other
   * references to the function, such as a variable it was returned to, have the property's declared type, as
   * TypeScript's control flow analysis gives them.
   */
  checkAssignedBefore(node: TreeNode, propertyNode: TreeNode, property: Property): void {
    const assignments = property.declaration ? this.assignmentsByFirst.get(property.declaration.id) : undefined;
    if (!assignments || assignments.some((assignment) => assignment.childForFieldName('left')?.id === node.id)) return;
    const key = this.c.flow.referenceKey(node);
    if (!key || key !== this.c.flow.referenceKey(assignments[0].childForFieldName('left') as TreeNode)) return;
    if (controlFlowContainer(node).id !== controlFlowContainer(assignments[0]).id) return;
    const targets = new Set(assignments.map((assignment) => (assignment.childForFieldName('left') as TreeNode).id));
    if (!mayBeUnassignedAt(flowBody(controlFlowContainer(node)), targets, node, () => this.c.budget.spend())) return;
    this.c.error(propertyNode, `プロパティ '${property.name}' は、代入される前に使われています。`);
  }
}

/** The part of a control flow container that runs: a function's body, a field's initializer, or the program. */
function flowBody(container: TreeNode): TreeNode {
  return container.childForFieldName('body') ?? container.childForFieldName('value') ?? container;
}

/**
 * The function, field initializer, or program whose control flow holds a node, which includes the functions it calls
 * immediately.
 */
function controlFlowContainer(node: TreeNode): TreeNode {
  let current = node.parent as TreeNode;
  while (
    current.parent &&
    !(laterRunningTypes.has(current.type) && !isImmediatelyInvoked(current)) &&
    current.type !== 'field_definition'
  )
    current = current.parent;
  return current;
}

/** Whether a `const` declares a function TypeScript lets a program add properties to. */
function isExpandoInitializer(declarator: TreeNode): boolean {
  const value = declarator.childForFieldName('value');
  return (
    declarator.type === 'variable_declarator' &&
    !declarator.childForFieldName('type') &&
    ['arrow_function', 'function_expression', 'generator_function'].includes(value?.type ?? '')
  );
}

function expandoPropertyName(left: TreeNode): string | undefined {
  if (left.type === 'member_expression') {
    const property = left.childForFieldName('property');
    return property?.type === 'property_identifier' ? property.text : undefined;
  }
  const index = left.type === 'subscript_expression' ? left.childForFieldName('index') : undefined;
  return index?.type === 'string' ? stringValue(index) : undefined;
}
