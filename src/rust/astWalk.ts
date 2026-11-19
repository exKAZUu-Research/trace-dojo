import type { Annotations, LocalVar } from './annotations';
import type { Block, Expr, MacroCall, Pattern } from './ast';
import { normalize } from './infer';
import { shallow } from './types';

export function walkBlock(block: Block, visit: (expr: Expr) => void): void {
  for (const stmt of block.stmts) {
    if (stmt.kind === 'let') {
      if (stmt.init) visit(stmt.init);
      if (stmt.else) walkBlock(stmt.else, visit);
    } else if (stmt.kind === 'expr') visit(stmt.expr);
  }
  if (block.tail) visit(block.tail);
}

/** Calls `visit` on the expressions directly inside an expression, in evaluation order. */
export function forEachDirect(expr: Expr, visit: (expr: Expr) => void): void {
  switch (expr.kind) {
    case 'unary':
    case 'ref':
    case 'cast':
    case 'try':
    case 'field': {
      visit(expr.operand);
      return;
    }
    case 'binary': {
      visit(expr.left);
      visit(expr.right);
      return;
    }
    case 'assign':
    case 'compoundAssign': {
      visit(expr.value);
      visit(expr.target);
      return;
    }
    case 'index': {
      visit(expr.operand);
      visit(expr.index);
      return;
    }
    case 'macro': {
      forEachMacroArg(expr.macro, visit);
      return;
    }
    default: {
      forEachDirectInCompound(expr, visit);
    }
  }
}

// code-gauge-allow functionNcss 35 -- One case per kind of expression.
function forEachDirectInCompound(expr: Expr, visit: (expr: Expr) => void): void {
  switch (expr.kind) {
    case 'call': {
      visit(expr.callee);
      for (const arg of expr.args) visit(arg);
      return;
    }
    case 'methodCall': {
      visit(expr.receiver);
      for (const arg of expr.args) visit(arg);
      return;
    }
    case 'range': {
      if (expr.start) visit(expr.start);
      if (expr.end) visit(expr.end);
      return;
    }
    case 'tuple':
    case 'array': {
      for (const elem of expr.elems) visit(elem);
      return;
    }
    case 'arrayRepeat': {
      visit(expr.value);
      visit(expr.count);
      return;
    }
    case 'struct': {
      for (const field of expr.fields) visit(field.value);
      if (expr.base) visit(expr.base);
      return;
    }
    default: {
      forEachDirectInControlFlow(expr, visit);
    }
  }
}

// code-gauge-allow functionNcss 37 -- One case per kind of expression.
function forEachDirectInControlFlow(expr: Expr, visit: (expr: Expr) => void): void {
  switch (expr.kind) {
    case 'block': {
      walkBlock(expr, visit);
      return;
    }
    case 'if': {
      visit(expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value);
      walkBlock(expr.consequent, visit);
      if (expr.else) visit(expr.else);
      return;
    }
    case 'match': {
      visit(expr.scrutinee);
      for (const arm of expr.arms) visit(arm.body);
      return;
    }
    case 'loop': {
      walkBlock(expr.body, visit);
      return;
    }
    case 'while': {
      visit(expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value);
      walkBlock(expr.body, visit);
      return;
    }
    case 'for': {
      visit(expr.iterable);
      walkBlock(expr.body, visit);
      return;
    }
    case 'break':
    case 'return': {
      if (expr.value) visit(expr.value);
      return;
    }
    case 'closure': {
      visit(expr.body);
      return;
    }
    default: {
      return;
    }
  }
}

function forEachMacroArg(macro: MacroCall, visit: (expr: Expr) => void): void {
  switch (macro.kind) {
    case 'write': {
      visit(macro.target);
      break;
    }
    case 'assert': {
      visit(macro.cond);
      break;
    }
    case 'assertEq': {
      visit(macro.left);
      visit(macro.right);
      break;
    }
    case 'vec': {
      for (const elem of macro.elems) visit(elem);
      return;
    }
    case 'vecRepeat': {
      visit(macro.value);
      visit(macro.count);
      return;
    }
    case 'matches': {
      visit(macro.value);
      return;
    }
    case 'dbg': {
      for (const arg of macro.args) visit(arg);
      return;
    }
  }
  for (const arg of macro.format?.args ?? []) visit(arg);
}

/** The variables a pattern binds, in order, each once (or-patterns bind the same variables in each alternative). */
export function patternBindings(pattern: Pattern, annotations: Annotations): LocalVar[] {
  return [...new Set(patternBindingParts(pattern, annotations).map((part) => part.local))];
}

/**
 * A variable a pattern binds, with the part of the matched value it binds (`''` for all of it, `.0`, `.name.1`), and
 * whether it binds it through a reference (match ergonomics, `&x`), which takes nothing out of the value.
 */
export interface PatternBindingPart {
  local: LocalVar;
  path: string;
  throughRef: boolean;
}

/** The variables a pattern binds, in order, each with the part it binds. */
// code-gauge-allow functionCognitiveComplexity 20 -- Follows rustc's binding modes case by case.
// code-gauge-allow functionNcss 33 -- Follows rustc's binding modes case by case.
export function patternBindingParts(pattern: Pattern, annotations: Annotations): PatternBindingPart[] {
  const parts: PatternBindingPart[] = [];
  const visit = (p: Pattern, path: string, throughRef: boolean): void => {
    // A pattern other than a binding matched against a reference looks through it.
    const derefs = p.kind !== 'binding' && p.kind !== 'wild' && p.ty && normalize(shallow(p.ty)).kind === 'ref';
    const under = throughRef || Boolean(derefs);
    switch (p.kind) {
      case 'binding': {
        const local = annotations.bindings.get(p);
        if (local) parts.push({ local, path, throughRef });
        if (p.sub) visit(p.sub, path, throughRef);
        return;
      }
      case 'tuple':
      case 'tupleStruct': {
        for (const [index, elem] of p.elems.entries()) visit(elem, `${path}.${index}`, under);
        return;
      }
      case 'struct': {
        for (const field of p.fields) visit(field.pattern, `${path}.${field.name}`, under);
        return;
      }
      case 'ref': {
        visit(p.pattern, path, true);
        return;
      }
      case 'or': {
        for (const alternative of p.alternatives) visit(alternative, path, throughRef);
        return;
      }
      default: {
        return;
      }
    }
  };
  visit(pattern, '', false);
  return parts;
}
