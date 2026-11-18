import type { Arg, ClassRef, Expr } from './ast';
import { formatFloatRepr } from './conversions';

/** The priority and operand priorities of each binary operator, as PHP's `zend_ast_export` writes code. */
const BINARY: Record<string, [number, number, number]> = {
  '+': [200, 200, 201],
  '-': [200, 200, 201],
  '*': [210, 210, 211],
  '/': [210, 210, 211],
  '%': [210, 210, 211],
  '<<': [190, 190, 191],
  '>>': [190, 190, 191],
  '.': [185, 185, 186],
  '|': [140, 140, 141],
  '&': [160, 160, 161],
  '^': [150, 150, 151],
  '===': [170, 171, 171],
  '!==': [170, 171, 171],
  '==': [170, 171, 171],
  '!=': [170, 171, 171],
  '<': [180, 181, 181],
  '<=': [180, 181, 181],
  '>': [180, 181, 181],
  '>=': [180, 181, 181],
  '<=>': [180, 181, 181],
  '**': [250, 251, 250],
  xor: [40, 40, 41],
  '&&': [130, 130, 131],
  and: [130, 130, 131],
  '||': [120, 120, 121],
  or: [120, 120, 121],
  '??': [110, 111, 110],
};

/** Writes an expression back as PHP code, as the message of a failed `assert` shows it. */
export function exportExpr(e: Expr, priority = 0): string {
  const wrap = (own: number, text: string): string => (priority > own ? `(${text})` : text);
  switch (e.k) {
    case 'lit': {
      return exportLiteral(e.v);
    }
    case 'var': {
      return `$${e.name}`;
    }
    case 'bin': {
      const [own, left, right] = BINARY[e.op] ?? [200, 200, 201];
      const op = e.op === 'and' ? '&&' : e.op === 'or' ? '||' : e.op;
      return wrap(own, `${exportExpr(e.l, left)} ${op} ${exportExpr(e.r, right)}`);
    }
    case 'unary': {
      return wrap(240, `${e.op}${exportExpr(e.e, 241)}`);
    }
    case 'cond': {
      const middle = e.consequent ? ` ? ${exportExpr(e.consequent, 101)} : ` : ' ?: ';
      return wrap(100, `${exportExpr(e.test, 100)}${middle}${exportExpr(e.alternate, 101)}`);
    }
    case 'call': {
      const name = 'k' in e.fn ? exportExpr(e.fn, 260) : e.fn.name;
      return `${name}(${exportArgs(e.args)})`;
    }
    case 'mcall': {
      return `${exportExpr(e.obj, 260)}${e.nullsafe ? '?->' : '->'}${typeof e.name === 'string' ? e.name : `{${exportExpr(e.name)}}`}(${exportArgs(e.args)})`;
    }
    case 'scall': {
      return `${exportClass(e.cls)}::${typeof e.name === 'string' ? e.name : exportExpr(e.name)}(${exportArgs(e.args)})`;
    }
    case 'prop': {
      return `${exportExpr(e.obj, 260)}${e.nullsafe ? '?->' : '->'}${typeof e.name === 'string' ? e.name : `{${exportExpr(e.name)}}`}`;
    }
    case 'sprop': {
      return `${exportClass(e.cls)}::$${typeof e.name === 'string' ? e.name : exportExpr(e.name)}`;
    }
    case 'idx': {
      return `${exportExpr(e.base, 260)}[${e.index ? exportExpr(e.index) : ''}]`;
    }
    case 'const': {
      return e.name.fallback ?? e.name.name;
    }
    case 'cconst': {
      return `${exportClass(e.cls)}::${typeof e.name === 'string' ? e.name : `{${exportExpr(e.name)}}`}`;
    }
    case 'array': {
      const items = e.items.map((item) => {
        if (item.spread) return `...${exportExpr(item.value)}`;
        const value = `${item.byRef ? '&' : ''}${exportExpr(item.value, 80)}`;
        return item.key ? `${exportExpr(item.key, 80)} => ${value}` : value;
      });
      return `[${items.join(', ')}]`;
    }
    case 'new': {
      return `new ${exportClass(e.cls)}(${exportArgs(e.args)})`;
    }
    case 'instanceof': {
      return wrap(230, `${exportExpr(e.e, 231)} instanceof ${exportClass(e.cls)}`);
    }
    case 'isset': {
      return `isset(${e.items.map((item) => exportExpr(item)).join(', ')})`;
    }
    case 'empty': {
      return `empty(${exportExpr(e.e)})`;
    }
    case 'cast': {
      return wrap(240, `(${e.type})${exportExpr(e.e, 241)}`);
    }
    case 'assign':
    case 'assignOp':
    case 'assignRef': {
      return wrap(90, exportAssignment(e));
    }
    case 'clone': {
      return `\\clone(${exportExpr(e.e)})`;
    }
    case 'match': {
      return exportMatch(e);
    }
    case 'incdec': {
      const op = e.inc ? '++' : '--';
      return wrap(240, e.prefix ? `${op}${exportExpr(e.target, 241)}` : `${exportExpr(e.target, 241)}${op}`);
    }
    default: {
      return '...';
    }
  }
}

function exportAssignment(e: Extract<Expr, { k: 'assign' | 'assignOp' | 'assignRef' }>): string {
  const target = exportExpr(e.target, 91);
  if (e.k === 'assignRef') return `${target} =& ${exportExpr(e.source, 90)}`;
  const operator = e.k === 'assignOp' ? `${e.op}=` : '=';
  return `${target} ${operator} ${exportExpr(e.value, 90)}`;
}

function exportMatch(e: Extract<Expr, { k: 'match' }>): string {
  const arms = e.arms.map(({ conditions, body }) => {
    const label = conditions ? conditions.map((condition) => exportExpr(condition)).join(', ') : 'default';
    return `    ${label} => ${exportExpr(body)},\n`;
  });
  return `match (${exportExpr(e.subject)}) {\n${arms.join('')}}`;
}

function exportArgs(args: Arg[]): string {
  return args
    .map((arg) => `${arg.name ? `${arg.name}: ` : ''}${arg.spread ? '...' : ''}${exportExpr(arg.e)}`)
    .join(', ');
}

function exportClass(cls: ClassRef): string {
  switch (cls.k) {
    case 'named': {
      return cls.name;
    }
    case 'expr': {
      return exportExpr(cls.e, 260);
    }
    default: {
      return cls.k;
    }
  }
}

function exportLiteral(value: null | boolean | bigint | number | string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return formatFloatRepr(value, 'E', true);
  return `'${value.replaceAll(/['\\]/g, String.raw`\$&`)}'`;
}
