import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import type { Condition } from './conditions';
import { isConstantReference } from './constantReferences';
import type { State } from './flow';
import { named } from './syntax';

/** The states of a condition checked again, with the keys of the references whose narrowing it gives. */
interface InlinedCondition {
  whenTrue: State;
  whenFalse: State;
  keys: Set<string>;
}

/** The kinds of expressions that declare or assign when checked. */
const sideEffectTypes = new Set([
  'arrow_function',
  'assignment_expression',
  'augmented_assignment_expression',
  'class',
  'function_expression',
  'update_expression',
]);

/** Narrows by a condition that another expression stands for, checking that condition again. */
export class InlinedConditions {
  /** How many aliased conditions are being inlined into each other. */
  private aliasDepth = 0;

  constructor(private readonly c: Checker) {}

  /**
   * The condition a constant stands for, as `const isText = typeof x === "string"` narrows `x` where `isText` is
   * tested. As in TypeScript, it narrows only references that cannot change after it, through up to five constants.
   */
  aliasedCondition(identifier: TreeNode): Condition | undefined {
    const symbol = this.c.scopeOf(identifier).lookupValue(identifier.text);
    const declarator = symbol?.valueDeclaration;
    if (symbol?.valueKind !== 'const' || declarator?.type !== 'variable_declarator') return undefined;
    const value = declarator.childForFieldName('value');
    if (declarator.childForFieldName('name')?.type !== 'identifier' || declarator.childForFieldName('type')) {
      return undefined;
    }
    if (!value || this.aliasDepth >= 5 || hasSideEffects(value)) return undefined;
    const type = this.c.expressions.check(identifier);
    const base = this.c.flow.current;
    this.aliasDepth++;
    let inlined: InlinedCondition;
    try {
      inlined = this.inlinedCondition(value, (node) => isConstantReference(this.c, node));
    } finally {
      this.aliasDepth--;
    }
    const aliasNarrowed = (aliased: State, assumeTrue: boolean): State =>
      this.c.flow.from(this.narrowedOnly(base, aliased, inlined.keys), () =>
        this.c.flow.narrowReference(identifier, (current) => this.c.flow.narrowByTruthiness(current, assumeTrue))
      );
    return {
      whenTrue: aliasNarrowed(inlined.whenTrue, true),
      whenFalse: aliasNarrowed(inlined.whenFalse, false),
      type,
    };
  }

  /**
   * The states of `expression` checked again as a condition, with the keys of the references it narrowed that
   * `accepts` allows; the current state and diagnostics stay as they were.
   */
  private inlinedCondition(expression: TreeNode, accepts: (node: TreeNode) => boolean): InlinedCondition {
    const outerScope = this.c.flow.narrowingScope;
    const base = this.c.flow.current;
    const keys = new Set<string>();
    this.c.flow.narrowingScope = { accepts, keys };
    try {
      const { whenTrue, whenFalse } = this.c.silently(() => this.c.conditions.condition(expression, false));
      for (const key of keys) outerScope?.keys.add(key);
      return { whenTrue, whenFalse, keys };
    } finally {
      this.c.flow.narrowingScope = outerScope;
      this.c.flow.current = base;
    }
  }

  /** `base` with only the narrowing of `keys` in `narrowed`, apart from what else checking it again changed. */
  private narrowedOnly(base: State, narrowed: State, keys: Set<string>): State {
    const result = narrowed && base?.clone();
    for (const key of keys) {
      const entry = narrowed?.entries.get(key);
      if (entry) result?.entries.set(key, entry);
    }
    return result;
  }

  /**
   * The states before narrowing by `left === right` (or another equality operator) where one side is `true` or
   * `false`: as TypeScript's `narrowTypeByBooleanComparison`, the other side narrows as a condition, `c === true` and
   * `c !== false` as `c` and the others as `!c`, but not the reference it is, which narrows by equality alone.
   */
  booleanComparison(
    left: TreeNode,
    right: TreeNode,
    equal: boolean
  ): { whenTrue: State; whenFalse: State } | undefined {
    for (const [literal, other] of [
      [right, left],
      [left, right],
    ] as const) {
      if (literal.type !== 'true' && literal.type !== 'false') continue;
      if (isAccessExpression(other) || hasSideEffects(other)) return undefined;
      const base = this.c.flow.current;
      const outerScope = this.c.flow.narrowingScope;
      const inlined = this.inlinedCondition(other, (node) => outerScope?.accepts(node) ?? true);
      const otherKey = this.c.flow.referenceKey(other);
      if (otherKey) inlined.keys.delete(otherKey);
      const whenTrue = this.narrowedOnly(base, inlined.whenTrue, inlined.keys);
      const whenFalse = this.narrowedOnly(base, inlined.whenFalse, inlined.keys);
      return equal === (literal.type === 'true')
        ? { whenTrue, whenFalse }
        : { whenTrue: whenFalse, whenFalse: whenTrue };
    }
    return undefined;
  }
}

/** Whether checking an expression again would declare or assign something, which an aliased condition must not. */
function hasSideEffects(expression: TreeNode): boolean {
  return sideEffectTypes.has(expression.type) || named(expression).some((child) => hasSideEffects(child));
}

function isAccessExpression(expression: TreeNode): boolean {
  return expression.type === 'member_expression' || expression.type === 'subscript_expression';
}
