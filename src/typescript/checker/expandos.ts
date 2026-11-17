import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Sym } from './scopes';
import { named, stringValue } from './syntax';
import { anonymousObject, anyType, emptyStructure, type Property, type Signature, type Type, unionOf } from './types';

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
                structure.properties.set(property, {
                  ...this.c.literals.literalProperty(property, anyType, false, assignments[0]),
                  type: this.propertyType(property, assignments),
                });
              }
              return structure;
            },
            { isFunction: false }
          );
    this.typesBySymbol.set(symbol.id, result);
    return result;
  }

  /**
   * The type of an added property, the union of the values assigned to it, resolved when first read; a property read
   * in its own assignments is `any`, as TypeScript reports.
   */
  private propertyType(property: string, assignments: TreeNode[]): () => Type {
    let resolved: Type | undefined;
    let resolving = false;
    return () => {
      if (resolved) return resolved;
      if (resolving) {
        const left = assignments[0].childForFieldName('left') ?? assignments[0];
        this.c.errorWhileResolving(left, `${property} の型が、自分自身を参照しているため暗黙に any になります。`);
        resolved = anyType;
        return resolved;
      }
      resolving = true;
      const type = this.c.silently(() =>
        unionOf(
          assignments.map((assignment) =>
            this.c.widen(this.c.expressions.check(assignment.childForFieldName('right') as TreeNode))
          )
        )
      );
      resolving = false;
      resolved ??= type;
      return resolved;
    };
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
    const statements = new Set(assignments.map((assignment) => (assignment.parent as TreeNode).id));
    if (assignedBefore(node, statements, controlFlowContainer(node))) return;
    this.c.error(propertyNode, `プロパティ '${property.name}' は、代入される前に使われています。`);
  }
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

/**
 * Whether one of the assignment statements has run on every path to a node: a statement before it in a block that
 * holds it, within its control flow container, definitely runs one.
 */
function assignedBefore(node: TreeNode, statements: Set<number>, container: TreeNode): boolean {
  for (let current = node; current.parent && current.id !== container.id; current = current.parent) {
    const { parent } = current;
    if (parent.type !== 'statement_block' && parent.type !== 'program') continue;
    for (const sibling of named(parent)) {
      if (sibling.startIndex >= current.startIndex) break;
      if (definitelyRuns(sibling, statements)) return true;
    }
  }
  return false;
}

/** Whether running a statement runs one of the assignment statements on every path that completes it. */
function definitelyRuns(statement: TreeNode, statements: Set<number>): boolean {
  if (statements.has(statement.id)) return true;
  const runs = (child: TreeNode | null): boolean => child !== null && definitelyRuns(child, statements);
  // A branch that never completes, as one that throws, leaves the paths of the others.
  const covers = (child: TreeNode | null): boolean => child !== null && (runs(child) || neverCompletes(child));
  switch (statement.type) {
    case 'statement_block':
    case 'else_clause': {
      return named(statement).some((child) => definitelyRuns(child, statements));
    }
    case 'if_statement': {
      const consequence = statement.childForFieldName('consequence');
      const alternative = statement.childForFieldName('alternative');
      return covers(consequence) && covers(alternative) && (runs(consequence) || runs(alternative));
    }
    case 'do_statement': {
      return runs(statement.childForFieldName('body'));
    }
    case 'switch_statement': {
      return switchRuns(statement, statements);
    }
    case 'try_statement': {
      const handler = statement.childForFieldName('handler');
      const finalizer = statement.childForFieldName('finalizer');
      const body = runs(statement.childForFieldName('body'));
      return (
        (body && (handler === null || runs(handler.childForFieldName('body')))) ||
        (finalizer !== null && runs(finalizer.childForFieldName('body')))
      );
    }
    default: {
      return false;
    }
  }
}

/**
 * Whether a switch with a `default` runs an assignment whichever clause it enters: each clause, falling through to the
 * next until a `break`, runs one before leaving or never completes.
 */
function switchRuns(statement: TreeNode, statements: Set<number>): boolean {
  const clauses = named(statement.childForFieldName('body') ?? statement);
  if (!clauses.some((clause) => clause.type === 'switch_default')) return false;
  return clauses.every((_, start) => {
    for (const clause of clauses.slice(start)) {
      for (const child of named(clause).filter((node) => node.id !== clause.childForFieldName('value')?.id)) {
        if (definitelyRuns(child, statements) || neverCompletes(child)) return true;
        if (child.type === 'break_statement') return false;
      }
    }
    return false;
  });
}

/** Whether a statement always leaves by throwing or returning, so no code after it runs on its path. */
function neverCompletes(statement: TreeNode): boolean {
  switch (statement.type) {
    case 'throw_statement':
    case 'return_statement': {
      return true;
    }
    case 'statement_block':
    case 'else_clause': {
      return named(statement).some(neverCompletes);
    }
    case 'if_statement': {
      const consequence = statement.childForFieldName('consequence');
      const alternative = statement.childForFieldName('alternative');
      return consequence !== null && alternative !== null && neverCompletes(consequence) && neverCompletes(alternative);
    }
    default: {
      return false;
    }
  }
}

export function isImmediatelyInvoked(node: TreeNode): boolean {
  let expression = node;
  while (expression.parent?.type === 'parenthesized_expression') expression = expression.parent;
  const parent = expression.parent;
  return parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === expression.id;
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
