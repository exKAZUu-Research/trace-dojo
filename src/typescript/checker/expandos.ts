import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Sym } from './scopes';
import { named, stringValue } from './syntax';
import { anonymousObject, emptyStructure, type Property, type Signature, type Type, unionOf } from './types';

/** Functions and blocks whose bodies run when called, after the declarations that precede the call. */
export const laterRunningTypes = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
]);

/** The properties a program adds to a function it declares, as `f.description = "..."`, which TypeScript types. */
export class Expandos {
  /** The statements that add a property to a function, by the first of them, which the property names as its declaration. */
  private readonly assignmentsByFirst = new Map<number, TreeNode[]>();

  constructor(private readonly c: Checker) {}

  /** The type of a `const` with the properties a program adds to the function it is initialized with. */
  constType(declarator: TreeNode, symbol: Sym, type: Type): Type {
    return isExpandoInitializer(declarator)
      ? this.withExpandos(this.c.signaturesOf(type, 'call'), type, declarator.parent?.parent, symbol)
      : type;
  }

  /** A function's type with the properties a program adds to it, as `f.description = "..."` in its block. */
  withExpandos(callSignatures: Signature[], type: Type, block: TreeNode | null | undefined, symbol: Sym): Type {
    const expandos = new Map<string, TreeNode[]>();
    if (block) this.collectAssignments(block, symbol, expandos);
    if (expandos.size === 0) return type;
    return anonymousObject(
      () => {
        const structure = { ...emptyStructure(), callSignatures };
        for (const [property, assignments] of expandos) {
          this.assignmentsByFirst.set(assignments[0].id, assignments);
          const valueType = this.c.silently(() =>
            unionOf(
              assignments.map((assignment) =>
                this.c.widen(this.c.expressions.check(assignment.childForFieldName('right') as TreeNode))
              )
            )
          );
          structure.properties.set(
            property,
            this.c.literals.literalProperty(property, valueType, false, assignments[0])
          );
        }
        return structure;
      },
      { isFunction: false }
    );
  }

  /** Collects the assignment statements of a block, outside its nested functions, that add properties to a function. */
  private collectAssignments(node: TreeNode, symbol: Sym, expandos: Map<string, TreeNode[]>): void {
    for (const child of named(node)) {
      if (laterRunningTypes.has(child.type) || child.type === 'class_declaration') continue;
      const assignment = child.type === 'expression_statement' ? named(child)[0] : undefined;
      const left = assignment?.type === 'assignment_expression' ? assignment.childForFieldName('left') : undefined;
      const object = left?.childForFieldName('object');
      const property = left ? expandoPropertyName(left) : undefined;
      if (
        assignment &&
        object?.type === 'identifier' &&
        property !== undefined &&
        this.c.scopeOf(object).lookupValue(object.text) === symbol
      ) {
        expandos.set(property, [...(expandos.get(property) ?? []), assignment]);
        continue;
      }
      this.collectAssignments(child, symbol, expandos);
    }
  }

  /**
   * Reports a read of a property a program adds to a function where no statement adding it has run yet: before
   * them, or after them only in a block that does not hold the read.
   */
  checkAssignedBefore(node: TreeNode, propertyNode: TreeNode, property: Property): void {
    const assignments = property.declaration ? this.assignmentsByFirst.get(property.declaration.id) : undefined;
    if (!assignments || assignments.some((assignment) => assignment.childForFieldName('left')?.id === node.id)) return;
    const assignedBefore = assignments.some((assignment) => {
      const statement = assignment.parent as TreeNode;
      const container = statement.parent as TreeNode;
      return (
        statement.endIndex <= node.startIndex &&
        container.startIndex <= node.startIndex &&
        node.endIndex <= container.endIndex
      );
    });
    if (assignedBefore) return;
    for (let current = node.parent; current; current = current.parent) if (laterRunningTypes.has(current.type)) return;
    this.c.error(propertyNode, `プロパティ '${property.name}' は、代入される前に使われています。`);
  }
}

/** Whether a `const` declares a function TypeScript lets a program add properties to. */
function isExpandoInitializer(declarator: TreeNode): boolean {
  const value = declarator.childForFieldName('value');
  return (
    declarator.type === 'variable_declarator' &&
    !declarator.childForFieldName('type') &&
    (value?.type === 'arrow_function' || value?.type === 'function_expression')
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
