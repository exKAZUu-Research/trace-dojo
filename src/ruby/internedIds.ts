import type { Expr, Program } from './ast';
import { nativeSignatures } from './nativeSignatures';
import { rt } from './runtime';

const identifierFields = new Set(['name', 'rest', 'keywordRest', 'block']);
const identifierLists = new Set(['locals', 'required', 'post']);
const coreMethodIds = Object.keys(nativeSignatures).map((name) =>
  name.slice(Math.max(name.lastIndexOf('#'), name.lastIndexOf('.')) + 1)
);

export function initializeInternedIds(program: Program): void {
  const runtime = rt();
  const previousSize = runtime.internedIds.size;
  for (const name of coreMethodIds) runtime.internedIds.add(name);
  for (const module of Object.values(runtime.c)) {
    for (const name of module.methods.keys()) runtime.internedIds.add(name);
    for (const name of module.constants.keys()) runtime.internedIds.add(name);
  }
  collectNamedIds(program);
  collectLiteralIds(program);
  runtime.chargeSlots(runtime.internedIds.size - previousSize);
}

function collectNamedIds(program: Program): void {
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    collectNodeIds(node);
    for (const value of Object.values(node)) if (value && typeof value === 'object') pending.push(value);
  }
}

function collectNodeIds(node: object): void {
  for (const [key, value] of Object.entries(node)) {
    if (identifierFields.has(key) && typeof value === 'string' && !('k' in node && node.k === 'sym'))
      rt().internedIds.add(value);
    if (identifierLists.has(key) && Array.isArray(value)) {
      for (const name of value) if (typeof name === 'string') rt().internedIds.add(name);
    }
  }
}

function collectLiteralIds(program: Program): void {
  const pending: [unknown, boolean][] = [[program, true]];
  while (pending.length > 0) {
    const [node, needed] = pending.pop()!;
    if (!node || typeof node !== 'object') continue;
    if ('k' in node && node.k === 'sym' && 'name' in node && typeof node.name === 'string') {
      if (needed) rt().internedIds.add(node.name);
      continue;
    }
    for (const child of literalChildren(node, needed)) pending.push(child);
  }
}

function literalChildren(node: object, needed: boolean): [unknown, boolean][] {
  if ('e' in node && 'use' in node) return [[node.e, node.use === 1 || (node.use === 2 && needed)]];
  if ('k' in node && node.k === 'array' && 'items' in node) return [[node.items, needed]];
  if ('k' in node && (node.k === 'and' || node.k === 'or') && 'l' in node && 'r' in node)
    return [
      [node.l, needed],
      [node.r, needed],
    ];
  if ('k' in node && node.k === 'if' && 'cond' in node)
    return literalIfChildren(node as Extract<Expr, { k: 'if' }>, needed);
  return Object.values(node).map((value) => [value, Array.isArray(node) ? needed : true]);
}

function literalIfChildren(node: Extract<Expr, { k: 'if' }>, needed: boolean): [unknown, boolean][] {
  if (node.cond.k === 'true') return [[node.consequent, needed]];
  if (node.cond.k === 'false' || node.cond.k === 'nil') return [[node.alternative, needed]];
  return [
    [node.cond, false],
    [node.consequent, needed],
    [node.alternative, needed],
  ];
}

export function internId(name: string): void {
  const runtime = rt();
  if (runtime.internedIds.has(name)) return;
  runtime.chargeSlots(1);
  runtime.internedIds.add(name);
}
