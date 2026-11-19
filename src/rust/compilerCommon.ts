import type { Annotations } from './annotations';
import type { Expr } from './ast';
import { claimStrings } from './capacity';
import { normalize } from './infer';
import { type Frame, UNASSIGNED } from './runtime';
import { type AdtDef, shallow, type Type } from './types';
import { EnumValue, isPlace, type Place, StructValue, type Value } from './values';

export class LocalPlace implements Place {
  readonly isPlace = true;
  constructor(
    private readonly frame: Frame,
    private readonly slot: number
  ) {}

  get(): Value {
    const value = this.frame.locals[this.slot];
    return value === UNASSIGNED ? undefined : value;
  }

  set(value: Value): void {
    this.frame.locals[this.slot] = value;
  }

  storage(): [object, number] {
    return [this.frame.locals, this.slot];
  }
}

export function construct(def: AdtDef, variant: number, args: Value[]): Value {
  claimStrings(args);
  return def.kind === 'enum' ? new EnumValue(def, variant, args) : new StructValue(def, args);
}

export function derefAll(value: Value): Value {
  let current = value;
  while (isPlace(current)) current = current.get();
  return current;
}

/** For comparisons of string-like types (`String == &str`), the type `str` that compares them alike. */
export function stringish(type: Type): Type | undefined {
  const t = stripRefs(type);
  if (t.kind === 'str' || (t.kind === 'adt' && t.def.builtin === 'String')) return { kind: 'str' };
  return undefined;
}

export function stripRefs(type: Type): Type {
  let t = normalize(shallow(type));
  while (t.kind === 'ref') t = normalize(shallow(t.target));
  return t;
}

export function isStringType(type: Type): boolean {
  const t = normalize(shallow(type));
  return t.kind === 'adt' && t.def.builtin === 'String';
}

export function isRefType(type: Type): boolean {
  return normalize(shallow(type)).kind === 'ref';
}

export function isPlaceExpr(expr: Expr, annotations: Annotations): boolean {
  if (expr.kind === 'path') {
    const res = annotations.paths.get(expr);
    return res?.kind === 'local' || res?.kind === 'capture';
  }
  if (expr.kind === 'field') return true;
  if (expr.kind === 'index') return !annotations.indexes.get(expr)?.range;
  return expr.kind === 'unary' && expr.op === '*';
}
