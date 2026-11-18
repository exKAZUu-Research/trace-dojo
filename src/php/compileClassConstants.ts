import type { ClassDecl, ClassRef, Expr } from './ast';
import { lower } from './bytes';
import { type ClassConstantLookup, type Constant, constantTypeName, foldedConstant } from './constantDefaults';
import { nativeClassDefinition } from './native';
import { PhpArray, PhpObject, type TypeDecl } from './values';

export class CompileClassConstants {
  private readonly bound = new Map<string, ClassDecl>();
  private readonly values = new WeakMap<ClassDecl, Map<string, Constant>>();

  lookup(scope: ClassDecl | undefined, closure = false): ClassConstantLookup {
    return (cls, name) => this.get(cls, name, scope, closure);
  }

  add(decl: ClassDecl, name: string, expression: Expr, type: TypeDecl | undefined): string | undefined {
    const value = foldedConstant(expression, { classConstant: this.lookup(decl) });
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

  bind(decl: ClassDecl): void {
    if (decl.kind === 'trait' || decl.interfaces.length > 0 || decl.traits.length > 0) return;
    if (decl.parent && !this.bound.has(lower(decl.parent)) && !nativeClassDefinition(decl.parent)) return;
    const name = lower(decl.name);
    if (!this.bound.has(name)) this.bound.set(name, decl);
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private get(cls: ClassRef, name: string, scope: ClassDecl | undefined, closure: boolean): Constant | undefined {
    const knownScope = !closure && scope?.kind !== 'trait';
    if (lower(name) === 'class') {
      if (cls.k === 'self' && knownScope) return scope?.fullName ?? scope?.name;
      if (cls.k === 'parent' && knownScope) return scope?.parent;
    }
    if (cls.k === 'self') return knownScope && scope ? this.own(scope, name, scope) : undefined;
    if (cls.k !== 'named') return;
    const classKey = lower(cls.name);
    if (scope && classKey === lower(scope.name)) return this.own(scope, name, scope);
    let key: string | undefined = classKey;
    while (key) {
      const decl = this.bound.get(key);
      if (!decl) return this.nativeConstant(key, name);
      if (decl.consts.some((constant) => constant.name === name)) return this.own(decl, name, scope);
      key = decl.parent && lower(decl.parent);
    }
  }

  private own(decl: ClassDecl, name: string, scope: ClassDecl | undefined): Constant | undefined {
    if (decl.kind === 'trait') return;
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
      if (value instanceof PhpArray || value instanceof PhpObject) return;
      return value;
    }
  }
}

function hasType(type: TypeDecl | undefined, name: string): boolean {
  if (!type) return false;
  return type.k === 'named' ? type.name === name : type.k === 'union' && type.types.some((part) => hasType(part, name));
}
