import type { Annotations, LocalVar } from './annotations';
import type { Block, Condition, Expr, MacroCall, Pattern } from './ast';
import { normalize } from './infer';
import { shallow } from './types';

type PatternSource = (pattern: Pattern, source: Expr) => boolean;

export function walkBlock(block: Block, visit: (expr: Expr) => void, patternSource?: PatternSource): void {
  for (const stmt of block.stmts) {
    if (stmt.kind === 'let') {
      if (stmt.init) visitPatternSource(stmt.pattern, stmt.init, visit, patternSource);
      if (stmt.else) walkBlock(stmt.else, visit, patternSource);
    } else if (stmt.kind === 'expr') visit(stmt.expr);
  }
  if (block.tail) visit(block.tail);
}

export function forEachResult(expr: Expr, visit: (expr: Expr) => void): void {
  if (expr.kind === 'block') {
    if (expr.tail) forEachResult(expr.tail, visit);
  } else if (expr.kind === 'if' && expr.else) {
    forEachResult(expr.consequent, visit);
    forEachResult(expr.else, visit);
  } else if (expr.kind === 'match') {
    for (const arm of expr.arms) forEachResult(arm.body, visit);
  } else if (expr.kind === 'loop') {
    forEachLoopResult(expr, visit);
  } else {
    visit(expr);
  }
}

// code-gauge-allow functionCognitiveComplexity -- The traversal keeps the active labels and evaluation order together.
function forEachLoopResult(loop: Extract<Expr, { kind: 'loop' }>, visit: (expr: Expr) => void): void {
  const labels = [loop.label];
  const walk = (expr: Expr): void => {
    if (expr.kind === 'closure') return;
    if (expr.kind === 'break' && expr.value) {
      const target = expr.label === undefined ? labels.length - 1 : labels.lastIndexOf(expr.label);
      if (target === 0) forEachResult(expr.value, visit);
    }
    if (expr.kind !== 'for' && expr.kind !== 'while' && expr.kind !== 'loop') {
      forEachDirect(expr, walk);
      return;
    }
    if (expr.kind === 'for') walk(expr.iterable);
    if (expr.kind === 'while') walk(expr.cond.kind === 'expr' ? expr.cond.expr : expr.cond.value);
    labels.push(expr.label);
    walkBlock(expr.body, walk);
    labels.pop();
  };
  walkBlock(loop.body, walk);
}

/** Calls `visit` on the expressions directly inside an expression, in evaluation order. */
export function forEachDirect(expr: Expr, visit: (expr: Expr) => void, patternSource?: PatternSource): void {
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
      forEachDirectInCompound(expr, visit, patternSource);
    }
  }
}

// code-gauge-allow functionNcss -- One case per kind of expression.
function forEachDirectInCompound(expr: Expr, visit: (expr: Expr) => void, patternSource?: PatternSource): void {
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
      forEachDirectInControlFlow(expr, visit, patternSource);
    }
  }
}

// code-gauge-allow functionNcss -- One case per kind of expression.
function forEachDirectInControlFlow(expr: Expr, visit: (expr: Expr) => void, patternSource?: PatternSource): void {
  switch (expr.kind) {
    case 'block': {
      walkBlock(expr, visit, patternSource);
      return;
    }
    case 'if': {
      visitCondition(expr.cond, visit, patternSource);
      walkBlock(expr.consequent, visit, patternSource);
      if (expr.else) visit(expr.else);
      return;
    }
    case 'match': {
      if (expr.arms.length === 1) visitPatternSource(expr.arms[0].pattern, expr.scrutinee, visit, patternSource);
      else visit(expr.scrutinee);
      for (const arm of expr.arms) {
        if (arm.guard) visit(arm.guard);
        visit(arm.body);
      }
      return;
    }
    case 'loop': {
      walkBlock(expr.body, visit, patternSource);
      return;
    }
    case 'while': {
      visitCondition(expr.cond, visit, patternSource);
      walkBlock(expr.body, visit, patternSource);
      return;
    }
    case 'for': {
      visit(expr.iterable);
      walkBlock(expr.body, visit, patternSource);
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

function visitCondition(cond: Condition, visit: (expr: Expr) => void, patternSource?: PatternSource): void {
  if (cond.kind === 'expr') visit(cond.expr);
  else visitPatternSource(cond.pattern, cond.value, visit, patternSource);
}

function visitPatternSource(
  pattern: Pattern,
  source: Expr,
  visit: (expr: Expr) => void,
  capture?: PatternSource
): void {
  if (!capture?.(pattern, source)) visit(source);
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
// code-gauge-allow functionCognitiveComplexity -- Follows rustc's binding modes case by case.
// code-gauge-allow functionNcss -- Follows rustc's binding modes case by case.
export function patternBindingParts(pattern: Pattern, annotations: Annotations): PatternBindingPart[] {
  const parts: PatternBindingPart[] = [];
  const visit = (p: Pattern, path: string, throughRef: boolean): void => {
    // A pattern other than a binding matched against a reference looks through it.
    const derefs = p.kind !== 'binding' && p.kind !== 'wild' && p.ty && normalize(shallow(p.ty)).kind === 'ref';
    const under = throughRef || Boolean(derefs);
    switch (p.kind) {
      case 'binding': {
        const local = annotations.bindings.get(p);
        if (local) parts.push({ local, path, throughRef: throughRef || p.byRef !== undefined });
        if (p.sub) visit(p.sub, path, throughRef);
        return;
      }
      case 'slice': {
        for (const [index, elem] of p.elems.entries()) visit(elem, `${path}.${index}`, under);
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
