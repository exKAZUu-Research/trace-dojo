import type { Annotations } from './annotations';
import type { Expr } from './ast';
import { constInteger } from './constExpressions';
import { normalize } from './infer';
import { type ConstDef, intMax, intMin, shallow } from './types';

// code-gauge-allow functionCognitiveComplexity 18 -- Traverses the expression forms that extend temporary scopes.
// code-gauge-allow functionNcss 37 -- Traverses the expression forms that extend temporary scopes.
export function markExtendedTemporaries(expr: Expr, annotations: Annotations, mark: (operand: Expr) => void): void {
  const visit = (child: Expr): void => markExtendedTemporaries(child, annotations, mark);
  switch (expr.kind) {
    case 'ref': {
      extendOperand(expr.operand, mark);
      visit(expr.operand);
      return;
    }
    case 'cast': {
      visit(expr.operand);
      return;
    }
    case 'array':
    case 'tuple': {
      for (const child of expr.elems) visit(child);
      return;
    }
    case 'struct': {
      for (const { value } of expr.fields) visit(value);
      return;
    }
    case 'call': {
      if (annotations.paths.get(expr.callee)?.kind === 'ctor') {
        for (const child of expr.args) visit(child);
      }
      return;
    }
    case 'block': {
      if (expr.tail) visit(expr.tail);
      return;
    }
    case 'if': {
      if (expr.consequent.tail) visit(expr.consequent.tail);
      if (expr.else) visit(expr.else);
      return;
    }
    case 'match': {
      for (const arm of expr.arms) visit(arm.body);
    }
  }
}

function extendOperand(expr: Expr, mark: (operand: Expr) => void): void {
  mark(expr);
  if (
    expr.kind === 'ref' ||
    expr.kind === 'field' ||
    expr.kind === 'index' ||
    (expr.kind === 'unary' && expr.op === '*')
  ) {
    extendOperand(expr.operand, mark);
  }
}

// code-gauge-allow functionCognitiveComplexity 20 -- Each kind has its own constant-promotion condition.
// code-gauge-allow functionNcss 46 -- Each kind has its own constant-promotion condition.
export function promotable(expr: Expr, annotations: Annotations, constants: Set<ConstDef> = new Set()): boolean {
  const child = (value: Expr): boolean => promotable(value, annotations, constants);
  switch (expr.kind) {
    case 'int':
    case 'float':
    case 'bool':
    case 'char':
    case 'str': {
      return true;
    }
    case 'array':
    case 'tuple': {
      return expr.elems.every(child);
    }
    case 'arrayRepeat': {
      return child(expr.value) && child(expr.count);
    }
    case 'ref': {
      return !expr.mutable && child(expr.operand);
    }
    case 'unary': {
      return expr.op !== '*' && child(expr.operand);
    }
    case 'binary': {
      return promotableBinary(expr, annotations) && child(expr.left) && child(expr.right);
    }
    case 'block': {
      return expr.stmts.length === 0 && (!expr.tail || child(expr.tail));
    }
    case 'cast':
    case 'field': {
      return child(expr.operand);
    }
    case 'index': {
      const type = expr.operand.ty && normalize(shallow(expr.operand.ty));
      const index = promotionInteger(expr.index, annotations);
      return (
        type?.kind === 'array' && index !== undefined && index >= 0n && index < BigInt(type.len) && child(expr.operand)
      );
    }
    case 'struct': {
      return (!expr.base || child(expr.base)) && expr.fields.every(({ value }) => child(value));
    }
    case 'call': {
      return (
        expr.callee.kind === 'path' && annotations.paths.get(expr.callee)?.kind === 'ctor' && expr.args.every(child)
      );
    }
    case 'path': {
      const resolved = annotations.paths.get(expr);
      if (resolved?.kind === 'ctor' || resolved?.kind === 'builtinConst') return true;
      const def = resolved?.kind === 'const' ? resolved.def : undefined;
      if (!def?.ast.value || constants.has(def) || constants.size >= 64) return false;
      constants.add(def);
      const result = child(def.ast.value);
      constants.delete(def);
      return result;
    }
    default: {
      return false;
    }
  }
}

function promotableBinary(expr: Extract<Expr, { kind: 'binary' }>, annotations: Annotations): boolean {
  const type = expr.left.ty && normalize(shallow(expr.left.ty));
  if (expr.op === '&&' || expr.op === '||') return false;
  if (!type || !['int', 'float', 'bool', 'char'].includes(type.kind)) return false;
  if (type.kind !== 'int' || (expr.op !== '/' && expr.op !== '%')) return true;
  const divisor = promotionInteger(expr.right, annotations);
  if (divisor === undefined || divisor === 0n) return false;
  if (divisor !== -1n) return true;
  const dividend = promotionInteger(expr.left, annotations);
  return dividend !== undefined && dividend !== intMin(type.name);
}

function promotionInteger(expr: Expr, annotations: Annotations): bigint | undefined {
  if (expr.kind === 'int') return expr.value;
  if (expr.kind === 'unary' && expr.op === '-' && expr.operand.kind === 'int') return -expr.operand.value;
  const constant = annotations.paths.get(expr);
  if (constant?.kind === 'builtinConst' && constant.type.kind === 'int') {
    if (constant.name === 'MIN') return intMin(constant.type.name);
    if (constant.name === 'MAX') return intMax(constant.type.name);
  }
  if (constant?.kind !== 'const' || constant.type.kind !== 'int') return;
  const { def, type } = constant;
  const initializer = def.ast.value;
  if (!initializer) return;
  const params = new Map(def.impl?.params.map((param) => [param.name, param]));
  return constInteger(initializer, { module: def.module, params, selfType: def.impl?.selfType }, type);
}
