import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { named, skipParentheses } from './syntax';

/** Whether a reference cannot change after a condition tests it, as TypeScript's `isConstantReference` decides. */
export function isConstantReference(c: Checker, node: TreeNode): boolean {
  const expression = skipParentheses(node);
  switch (expression.type) {
    case 'this': {
      return true;
    }
    case 'identifier': {
      return isConstantVariable(c, expression);
    }
    case 'non_null_expression': {
      return isConstantReference(c, named(expression)[0]);
    }
    case 'member_expression':
    case 'subscript_expression': {
      const object = expression.childForFieldName('object') as TreeNode;
      const index = expression.childForFieldName('index');
      const name = index ? c.flow.constantIndexName(index) : expression.childForFieldName('property')?.text;
      if (name === undefined || !isConstantReference(c, object)) return false;
      const objectType = c.relations.removeNullish(c.expressions.checkReferenceSilently(object));
      // A union's property is read-only when some member declares it so.
      return (objectType.kind === 'union' ? objectType.types : [objectType]).some((member) => {
        const property = c.propertyOf(member, name);
        return property?.readonly === true || property?.getterOnly === true;
      });
    }
    default: {
      return false;
    }
  }
}

/** Whether a variable is a constant, a parameter or local `let` never reassigned, or a function expression's name. */
function isConstantVariable(c: Checker, identifier: TreeNode): boolean {
  const symbol = c.scopeOf(identifier).lookupValue(identifier.text);
  if (symbol?.valueEntries[0]?.kind === 'function') return symbol.valueDeclaration?.type === 'function_expression';
  return isUnchangedVariable(c, identifier);
}

/**
 * Whether a variable is a constant, or a parameter or local `let` never reassigned, which TypeScript's
 * `isMatchingReference` requires of a variable keying an element access that narrows.
 */
export function isUnchangedVariable(c: Checker, identifier: TreeNode): boolean {
  const symbol = c.scopeOf(identifier).lookupValue(identifier.text);
  switch (symbol?.valueEntries[0]?.kind) {
    case 'const': {
      return true;
    }
    case 'parameter':
    case 'catch': {
      return !symbol.isReassigned;
    }
    case 'let': {
      // A program without imports or exports is a script, whose top-level variables are global.
      return !symbol.isReassigned && symbol.valueDeclaration?.parent?.parent?.type !== 'program';
    }
    default: {
      return false;
    }
  }
}
