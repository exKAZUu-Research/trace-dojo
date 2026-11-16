import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ClassInfo, Type, TypeParameter } from './types';

export type ValueKind = 'let' | 'const' | 'var' | 'parameter' | 'function' | 'class' | 'catch' | 'declared';
export type TypeKind = 'interface' | 'alias' | 'class' | 'typeParameter';

let nextSymbolId = 1;

/** A name a program or the library declares, as a value, a type, or both. */
export class Sym {
  readonly id = nextSymbolId++;
  valueKind?: ValueKind;
  typeKind?: TypeKind;
  valueDeclarations: TreeNode[] = [];
  typeDeclarations: TreeNode[] = [];
  /** Each value declaration's kind and the name it declares, which duplicate declarations are reported at. */
  readonly valueEntries: { kind: ValueKind; name: TreeNode }[] = [];
  readonly typeEntries: { kind: TypeKind; name: TreeNode }[] = [];
  /** The type of the value, once resolved. */
  valueType?: Type;
  /** The type the name stands for, once resolved. */
  declaredType?: Type;
  typeParameter?: TypeParameter;
  classInfo?: ClassInfo;
  /** Whether the program assigns the variable anywhere but its declaration. */
  isReassigned = false;
  /** Whether resolving its type is in progress, to detect a type that depends on itself. */
  resolving = false;
  /** The feature name when using this library value is not supported yet. */
  unsupported?: string;
  /** For a value whose declaration has no annotation, whose type the initializer gives. */
  isLibrary = false;

  constructor(
    readonly name: string,
    readonly scope: Scope
  ) {}

  get valueDeclaration(): TreeNode | undefined {
    return this.valueDeclarations[0];
  }
}

export class Scope {
  readonly values = new Map<string, Sym>();
  readonly types = new Map<string, Sym>();

  constructor(
    readonly kind: 'global' | 'module' | 'function' | 'block' | 'class',
    readonly parent: Scope | undefined,
    readonly node: TreeNode | undefined
  ) {}

  lookupValue(name: string): Sym | undefined {
    return this.values.get(name) ?? this.parent?.lookupValue(name);
  }

  lookupType(name: string): Sym | undefined {
    return this.types.get(name) ?? this.parent?.lookupType(name);
  }

  /** The nearest function (or the module) scope, where `var` and function declarations live. */
  get functionScope(): Scope {
    return (this.kind === 'block' || this.kind === 'class') && this.parent ? this.parent.functionScope : this;
  }

  declareValue(name: string, kind: ValueKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    let symbol = this.values.get(name);
    if (!symbol) {
      symbol = new Sym(name, this);
      this.values.set(name, symbol);
    }
    symbol.valueKind ??= kind;
    symbol.valueDeclarations.push(declaration);
    symbol.valueEntries.push({ kind, name: nameNode });
    return symbol;
  }

  declareType(name: string, kind: TypeKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    let symbol = this.types.get(name);
    if (!symbol) {
      // A class is a value and a type of the same name.
      symbol = kind === 'class' ? (this.values.get(name) ?? new Sym(name, this)) : new Sym(name, this);
      this.types.set(name, symbol);
    }
    symbol.typeKind ??= kind;
    symbol.typeDeclarations.push(declaration);
    symbol.typeEntries.push({ kind, name: nameNode });
    return symbol;
  }
}
