import { CompileError } from '../interpreter/diagnostics';
import type { NameRef, ScopeInfo } from './ast';

type Declaration = 'global' | 'nonlocal';

/** The names one scope binds, declares, and uses, collected while converting the program. */
export class ScopeBuilder {
  readonly info: ScopeInfo;
  readonly children: ScopeBuilder[] = [];
  /** Names bound in this scope, in the order of their first binding. */
  readonly bound = new Map<string, number>();
  readonly parameters = new Set<string>();
  readonly declarations = new Map<string, Declaration>();
  /** The rows of the first use of each name, to reject a later `global` of it. */
  readonly used = new Map<string, number>();
  readonly refs: NameRef[] = [];
  /** Comprehension iteration variables, which an assignment expression must not rebind. */
  readonly iterationVariables = new Set<string>();

  constructor(
    kind: ScopeInfo['kind'],
    readonly parent: ScopeBuilder | undefined
  ) {
    this.info = { kind, locals: [], cells: [], frees: [], isGenerator: false };
    parent?.children.push(this);
  }

  get isFunctionLike(): boolean {
    return this.info.kind === 'function' || this.info.kind === 'comprehension';
  }

  bind(ref: NameRef): void {
    if (!this.bound.has(ref.name)) this.bound.set(ref.name, ref.row);
    this.refs.push(ref);
  }

  use(ref: NameRef): void {
    if (!this.used.has(ref.name)) this.used.set(ref.name, ref.row);
    this.refs.push(ref);
  }

  declare(name: string, declaration: Declaration, row: number): void {
    const previous = this.declarations.get(name);
    if (this.parameters.has(name)) fail(row, `${name} は引数なので、${declaration} 宣言はできません。`);
    if (previous && previous !== declaration) fail(row, `${name} を global と nonlocal の両方で宣言しています。`);
    if (this.declarations.has(name)) return;
    if (this.bound.has(name)) fail(row, `${name} は ${declaration} 宣言より前に代入されています。`);
    if (this.used.has(name)) fail(row, `${name} は ${declaration} 宣言より前に使われています。`);
    if (declaration === 'nonlocal' && this.info.kind === 'module') {
      fail(row, 'nonlocal 宣言はモジュールの最上位では使えません。');
    }
    this.declarations.set(name, declaration);
  }

  /** Whether this scope owns `name` as a variable of its own, which nested functions may capture. */
  owns(name: string): boolean {
    return this.bound.has(name) && !this.declarations.has(name);
  }
}

export function fail(row: number, message: string): never {
  throw new CompileError([{ row, message }]);
}

/** Settles how every name of the program is accessed, once all scopes have been collected. */
export function resolveScopes(module: ScopeBuilder): void {
  checkNonlocals(module);
  resolve(module);
}

function checkNonlocals(scope: ScopeBuilder): void {
  for (const [name, declaration] of scope.declarations) {
    if (declaration === 'nonlocal' && !ownerOf(scope.parent, name)) {
      const row = scope.refs.find((ref) => ref.name === name)?.row ?? 0;
      fail(row, `nonlocal で宣言した ${name} が、外側の関数に見つかりません。`);
    }
  }
  for (const child of scope.children) checkNonlocals(child);
}

/** The nearest enclosing function that owns `name`, skipping class bodies, which nested functions do not see. */
function ownerOf(scope: ScopeBuilder | undefined, name: string): ScopeBuilder | undefined {
  for (let current = scope; current; current = current.parent) {
    // A class body owns the implicit `__class__` cell its methods read, and no other name nested functions see.
    if (current.info.kind === 'class') {
      if (name === '__class__') return current;
      continue;
    }
    if (current.info.kind === 'module') return undefined;
    if (current.declarations.get(name) === 'global') return undefined;
    if (current.owns(name)) return current;
  }
  return undefined;
}

function resolve(scope: ScopeBuilder): void {
  const { info } = scope;
  info.locals = [...scope.bound.keys()].filter((name) => !scope.declarations.has(name));
  for (const ref of scope.refs) ref.access = accessOf(scope, ref.name);
  for (const child of scope.children) resolve(child);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Follows CPython's rules for resolving a name to local, cell, free, or global.
function accessOf(scope: ScopeBuilder, name: string): NameRef['access'] {
  const declaration = scope.declarations.get(name);
  if (declaration === 'global') return 'global';
  if (scope.info.kind === 'module') return 'global';
  if (declaration !== 'nonlocal' && scope.owns(name)) {
    if (scope.info.kind === 'class') return 'name';
    return capturedBelow(scope, name) ? markCell(scope, name) : 'local';
  }
  const owner = ownerOf(scope.parent, name);
  if (!owner) return scope.info.kind === 'class' ? 'name' : 'global';
  markCell(owner, name);
  for (let current: ScopeBuilder | undefined = scope; current && current !== owner; current = current.parent) {
    if (!current.info.frees.includes(name)) current.info.frees.push(name);
  }
  return scope.info.kind === 'class' ? 'classCell' : 'cell';
}

function markCell(scope: ScopeBuilder, name: string): 'cell' {
  if (!scope.info.cells.includes(name)) scope.info.cells.push(name);
  return 'cell';
}

/** Whether a scope nested in `scope` reads `name` as a variable of `scope`. */
function capturedBelow(scope: ScopeBuilder, name: string): boolean {
  return scope.children.some((child) => readsFromOutside(child, name));
}

function readsFromOutside(scope: ScopeBuilder, name: string): boolean {
  const declaration = scope.declarations.get(name);
  if (declaration === 'global') return false;
  if (declaration === 'nonlocal') return true;
  if (scope.info.kind !== 'class' && scope.owns(name)) return false;
  if (scope.refs.some((ref) => ref.name === name)) return true;
  return scope.children.some((child) => readsFromOutside(child, name));
}
