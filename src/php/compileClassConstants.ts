import type { ExecutionBudget } from '../interpreter/limits';
import type { ClassDecl, ClassRef, Expr } from './ast';
import { canBindClass } from './astAnalysis';
import { lower } from './bytes';
import { type ClassConstantLookup, type Constant, constantTypeName, foldedConstant } from './constantDefaults';
import { nativeClassDefinition } from './native';
import { PhpArray, PhpObject, type TypeDecl, UNDEFINED_RESULT } from './values';

export class CompileClassConstants {
  private readonly bound = new Map<string, ClassDecl>();
  private readonly values = new WeakMap<ClassDecl, Map<string, Constant>>();

  constructor(private readonly budget: () => ExecutionBudget) {}

  lookup(scope: ClassDecl | undefined, closure = false): ClassConstantLookup {
    return (cls, name) => this.get(cls, name, scope, closure);
  }

  add(
    decl: ClassDecl,
    name: string,
    expression: Expr,
    type: TypeDecl | undefined,
    magic: (token: Extract<Expr, { k: 'magic' }>['name']) => string | undefined
  ): string | undefined {
    const value = foldedConstant(expression, {
      budget: this.budget(),
      magic,
      classConstant: this.lookup(decl),
      className: (cls) => this.className(cls, decl),
    });
    if (value === undefined) return;
    let constants = this.values.get(decl);
    if (!constants) {
      constants = new Map();
      this.values.set(decl, constants);
    }
    const widen =
      typeof value === 'bigint' && hasType(type, 'float') && !hasType(type, 'int') && !hasType(type, 'mixed');
    const stored = widen ? Number(value) : value;
    constants.set(name, stored);
    return constantTypeName(stored);
  }

  bind(decl: ClassDecl): boolean {
    if (!canBindClass(decl, (parent) => this.bound.has(parent) || nativeClassDefinition(parent) !== undefined))
      return false;
    const name = lower(decl.name);
    if (this.bound.has(name) || nativeClassDefinition(name)) return false;
    this.bound.set(name, decl);
    return true;
  }

  className(cls: ClassRef, scope: ClassDecl | undefined, closure = false): string | undefined {
    if (closure || scope?.kind === 'trait') return undefined;
    if (cls.k === 'self') return scope?.fullName ?? scope?.name;
    if (cls.k === 'parent') return scope?.parent;
    return undefined;
  }

  private get(cls: ClassRef, name: string, scope: ClassDecl | undefined, closure: boolean): Constant | undefined {
    const knownScope = !closure && scope?.kind !== 'trait';
    if (cls.k === 'self') return knownScope && scope ? this.own(scope, name, scope) : undefined;
    if (cls.k !== 'named') return;
    const classKey = lower(cls.name);
    if (scope && classKey === lower(scope.name)) return this.own(scope, name, scope);
    let key: string | undefined = classKey;
    while (key) {
      const decl = this.bound.get(key);
      if (!decl) return this.nativeConstant(key, name);
      this.budget().spend(1 + Math.ceil(decl.consts.length / 64));
      if (decl.consts.some((constant) => constant.name === name)) return this.own(decl, name, scope);
      key = decl.parent && lower(decl.parent);
    }
  }

  private own(decl: ClassDecl, name: string, scope: ClassDecl | undefined): Constant | undefined {
    if (decl.kind === 'trait') return;
    this.budget().spend(1 + Math.ceil(decl.consts.length / 64));
    const constant = decl.consts.find((item) => item.name === name);
    if (!constant) return;
    if (constant.visibility !== 'public' && decl !== scope) {
      if (constant.visibility === 'private') return;
      let parent = decl.parent;
      while (parent && lower(parent) !== lower(scope?.name ?? '')) parent = this.bound.get(lower(parent))?.parent;
      if (!parent) return;
    }
    return this.values.get(decl)?.get(name);
  }

  private nativeConstant(className: string, name: string): Constant | undefined {
    for (
      let definition = nativeClassDefinition(className);
      definition;
      definition = definition.parent ? nativeClassDefinition(definition.parent) : undefined
    ) {
      const value = definition.consts?.[name];
      if (value === undefined) continue;
      if (value === UNDEFINED_RESULT || value instanceof PhpArray || value instanceof PhpObject) return;
      return value;
    }
  }
}

function hasType(type: TypeDecl | undefined, name: string): boolean {
  if (!type) return false;
  return type.k === 'named' ? type.name === name : type.k === 'union' && type.types.some((part) => hasType(part, name));
}
