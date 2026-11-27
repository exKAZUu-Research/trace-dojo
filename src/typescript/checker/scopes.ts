import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import type { ClassInfo, Type, TypeParameter, UnionType } from './types';

export type ValueKind =
  | 'let'
  | 'const'
  | 'var'
  | 'parameter'
  | 'function'
  | 'class'
  | 'catch'
  | 'declared'
  | 'enum'
  | 'enumMember'
  | 'namespace'
  | 'importAlias'
  | 'import';
export type TypeKind = 'interface' | 'alias' | 'class' | 'typeParameter' | 'enum' | 'importAlias' | 'import';

let nextSymbolId = 1;

const mergesIntoNamespace = new Set<ValueKind>(['enum', 'function', 'class']);

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
  /** Whether the program assigns the variable anywhere with `=`, a logical assignment, or a destructuring or `for` head. */
  isDefinitelyAssigned = false;
  /** The end of the last ordered write, or infinity when a nested function may write later. */
  lastAssignment = -1;
  /** Whether a nested function uses this variable, whose type then cannot always be followed. */
  usedInClosure = false;
  /** Whether resolving its type is in progress, to detect a type that depends on itself. */
  resolving = false;
  /**
   * While a union alias resolves, the union that references to it inside array, tuple, and type argument positions
   * stand for, which receives the alias's members once they are known.
   */
  pendingUnion?: UnionType;
  /** The feature name when using this library value is not supported yet. */
  unsupported?: string;
  /** Whether only calling or constructing the value is unavailable, as with `Function`, whose references still work. */
  unsupportedCallOnly?: boolean;
  /** For a value whose declaration has no annotation, whose type the initializer gives. */
  isLibrary = false;
  /** For an enum, the scope its members are declared in, which every declaration of it shares. */
  enumMembers?: Scope;
  /** For a namespace, the names its declarations export, which every declaration of it sees. */
  namespaceExports?: Scope;
  /** The namespace that exports this name, which its declarations refer to it through. */
  exportedFrom?: Sym;
  /** For a name an `import` declares, the module and the export it names: `*` for the module, `default` for its default. */
  importTarget?: { module: string; name: string; typeOnly?: boolean };

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

  /** The names a `declare global` block declares, which inside it stand for the global symbols of those names. */
  private readonly augmentedNames = new Set<string>();
  /** The nearest function or module scope, where `var` and function declarations live. */
  readonly functionScope: Scope;
  /** For the body of a namespace declaration, the namespace, to which its `export` declarations add names. */
  namespace?: Sym;
  /** Whether the declarations in it are ambient, as in a `declare namespace`, where every declaration is exported. */
  isAmbient = false;

  /** @param augments For a `declare global` block, the global scope its declarations go to. */
  constructor(
    readonly kind: 'global' | 'module' | 'function' | 'block' | 'class',
    readonly parent: Scope | undefined,
    readonly node: TreeNode | undefined,
    private readonly augments?: Scope
  ) {
    this.functionScope = (kind === 'block' || kind === 'class') && parent ? parent.functionScope : this;
  }

  lookupValue(name: string, budget?: ExecutionBudget): Sym | undefined {
    budget?.spend();
    return this.values.get(name) ?? this.augmented(name)?.values.get(name) ?? this.parent?.lookupValue(name, budget);
  }

  lookupType(name: string): Sym | undefined {
    return this.types.get(name) ?? this.augmented(name)?.types.get(name) ?? this.parent?.lookupType(name);
  }

  private augmented(name: string): Scope | undefined {
    return this.augmentedNames.has(name) ? this.augments : undefined;
  }

  declareAmbientValue(name: string, kind: 'var' | 'let' | 'const', declaration: TreeNode, nameNode: TreeNode): void {
    const symbol = this.declareValue(name, 'declared', declaration, nameNode);
    symbol.valueEntries.at(-1)!.kind = kind;
  }

  declareValue(name: string, kind: ValueKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    if (this.augments) {
      this.augmentedNames.add(name);
      return this.augments.declareValue(name, kind, declaration, nameNode);
    }
    let symbol = this.values.get(name) ?? this.exportedNamespaceSymbol(name, declaration, 'value');
    if (!symbol) {
      symbol = new Sym(name, this);
      this.values.set(name, symbol);
    }
    // An enum, a function, or a class merges into a namespace declared before it, whose exports it then holds too.
    if (symbol.valueKind === undefined || (symbol.valueKind === 'namespace' && mergesIntoNamespace.has(kind)))
      symbol.valueKind = kind;
    symbol.valueDeclarations.push(declaration);
    symbol.valueEntries.push({ kind, name: nameNode });
    return symbol;
  }

  declareType(name: string, kind: TypeKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    if (this.augments) {
      this.augmentedNames.add(name);
      return this.augments.declareType(name, kind, declaration, nameNode);
    }
    let symbol = this.types.get(name) ?? this.exportedNamespaceSymbol(name, declaration, 'type');
    if (!symbol) {
      // A class or an enum is a value and a type of the same name.
      symbol =
        kind === 'class' || kind === 'enum' ? (this.values.get(name) ?? new Sym(name, this)) : new Sym(name, this);
      this.types.set(name, symbol);
    }
    // An interface declared before the class of its name merges into the class.
    if (kind === 'class' && symbol.typeKind === 'interface') symbol.typeKind = 'class';
    else symbol.typeKind ??= kind;
    symbol.typeDeclarations.push(declaration);
    symbol.typeEntries.push({ kind, name: nameNode });
    return symbol;
  }

  /** The symbol another body of this namespace already exported under `name`, when `declaration` is exported too. */
  private exportedNamespaceSymbol(name: string, declaration: TreeNode, meaning: 'value' | 'type'): Sym | undefined {
    if (!this.namespace || !isExportedFromNamespace(this.isAmbient, declaration)) return undefined;
    const exports = this.namespace.namespaceExports;
    const exported = meaning === 'value' ? exports?.values.get(name) : exports?.types.get(name);
    if (!exported) return undefined;
    (meaning === 'value' ? this.values : this.types).set(name, exported);
    return exported;
  }
}

function isExportedFromNamespace(isAmbientScope: boolean, declaration: TreeNode): boolean {
  if (isAmbientScope) return true;
  let current: TreeNode | null = declaration;
  if (current.type === 'variable_declarator') current = current.parent;
  if (current?.type === 'expression_statement' || current?.type === 'ambient_declaration') current = current.parent;
  return current?.parent?.type === 'export_statement';
}
