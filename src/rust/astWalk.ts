import type { Annotations, LocalVar } from './annotations';
import type { Block, Expr, FormatArgs, Pattern } from './ast';

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
    case 'index': {
      visit(expr.operand);
      visit(expr.index);
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
    case 'macro': {
      const { macro } = expr;
      const format = (f: FormatArgs | undefined): void => {
        for (const arg of f?.args ?? []) visit(arg);
      };
      switch (macro.kind) {
        case 'print':
        case 'panic':
        case 'format': {
          format(macro.format);
          return;
        }
        case 'write': {
          visit(macro.target);
          format(macro.format);
          return;
        }
        case 'assert': {
          visit(macro.cond);
          format(macro.format);
          return;
        }
        case 'assertEq': {
          visit(macro.left);
          visit(macro.right);
          format(macro.format);
          return;
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
      return;
    }
    default: {
      return;
    }
  }
}

/** The variables a pattern binds, in order, each once (or-patterns bind the same variables in each alternative). */
// code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of expression.
// code-gauge-allow functionNcss 31 -- One case per kind of expression.
export function patternBindings(pattern: Pattern, annotations: Annotations): LocalVar[] {
  const locals: LocalVar[] = [];
  const visit = (p: Pattern): void => {
    const local = annotations.bindings.get(p);
    if (local && !locals.includes(local)) locals.push(local);
    switch (p.kind) {
      case 'binding': {
        if (p.sub) visit(p.sub);
        break;
      }
      case 'tuple':
      case 'tupleStruct': {
        for (const elem of p.elems) visit(elem);
        break;
      }
      case 'struct': {
        for (const field of p.fields) visit(field.pattern);
        break;
      }
      case 'ref': {
        visit(p.pattern);
        break;
      }
      case 'or': {
        for (const alternative of p.alternatives) visit(alternative);
        break;
      }
      default: {
        break;
      }
    }
  };
  visit(pattern);
  return locals;
}
