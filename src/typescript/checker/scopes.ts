import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { ExecutionBudget } from '../../interpreter/limits';
import { nameOf } from '../../javascript/convertNodes';
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
export type NamespaceKind = 'namespace' | 'importAlias' | 'import';
export type MeaningSpace = 'value' | 'type' | 'namespace';

let nextSymbolId = 1;

const mergesIntoNamespace = new Set<ValueKind>(['enum', 'function', 'class']);
const sharesNamespaceSymbol = new Set<ValueKind>(['namespace', 'enum', 'function', 'class']);

/** A name a program or the library declares, as a value, a type, a namespace, or a combination of them. */
export class Sym {
  readonly id = nextSymbolId++;
  valueKind?: ValueKind;
  typeKind?: TypeKind;
  namespaceKind?: NamespaceKind;
  valueDeclarations: TreeNode[] = [];
  typeDeclarations: TreeNode[] = [];
  namespaceDeclarations: TreeNode[] = [];
  /** Each value declaration's kind and the name it declares, which duplicate declarations are reported at. */
  readonly valueEntries: { kind: ValueKind; name: TreeNode }[] = [];
  readonly typeEntries: { kind: TypeKind; name: TreeNode }[] = [];
  readonly namespaceEntries: { kind: NamespaceKind; name: TreeNode }[] = [];
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
  readonly namespaces = new Map<string, Sym>();

  private readonly clauseOnlyValues = new Set<string>();
  private readonly clauseOnlyTypes = new Set<string>();
  private readonly clauseOnlyNamespaces = new Set<string>();
  private readonly declarationExportedValues = new Set<string>();
  private readonly declarationExportedTypes = new Set<string>();
  private readonly declarationExportedNamespaces = new Set<string>();
  readonly clauseExportSpecifiers: { name: string; site: TreeNode; value?: Sym; type?: Sym; namespace?: Sym }[] = [];
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
    const own = this.clauseOnlyValues.has(name) ? undefined : this.values.get(name);
    return own ?? this.augmented(name)?.values.get(name) ?? this.parent?.lookupValue(name, budget);
  }

  lookupType(name: string): Sym | undefined {
    const own = this.clauseOnlyTypes.has(name) ? undefined : this.types.get(name);
    return own ?? this.augmented(name)?.types.get(name) ?? this.parent?.lookupType(name);
  }

  lookupNamespace(name: string, budget?: ExecutionBudget): Sym | undefined {
    budget?.spend();
    const own = this.clauseOnlyNamespaces.has(name) ? undefined : this.namespaces.get(name);
    return own ?? this.augmented(name)?.namespaces.get(name) ?? this.parent?.lookupNamespace(name, budget);
  }

  /** Finds the innermost namespace, enum, or import container named `name` along the lexical scope chain. */
  lookupContainer(name: string, budget?: ExecutionBudget): Sym | undefined {
    budget?.spend();
    const ownNamespace = this.clauseOnlyNamespaces.has(name) ? undefined : this.namespaces.get(name);
    if (ownNamespace) return ownNamespace;
    const ownValue = this.clauseOnlyValues.has(name) ? undefined : this.values.get(name);
    if (ownValue && isContainerValueKind(ownValue.valueKind)) return ownValue;
    const augmented = this.augmented(name);
    if (augmented) {
      const augNamespace = augmented.namespaces.get(name);
      if (augNamespace) return augNamespace;
      const augValue = augmented.values.get(name);
      if (augValue && isContainerValueKind(augValue.valueKind)) return augValue;
    }
    return this.parent?.lookupContainer(name, budget);
  }

  exportViaDeclaration(name: string, symbol: Sym, meaning: MeaningSpace): void {
    const { table, clauseOnly, declarationExported } = this.spaceSets(meaning);
    declarationExported.add(name);
    if (!clauseOnly.has(name)) table.set(name, symbol);
  }

  exportViaClause(name: string, symbol: Sym, meaning: MeaningSpace): void {
    const { table, clauseOnly } = this.spaceSets(meaning);
    if (table.has(name)) return;
    clauseOnly.add(name);
    table.set(name, symbol);
  }

  recordClauseExport(name: string, site: TreeNode, symbols: { value?: Sym; type?: Sym; namespace?: Sym }): void {
    this.clauseExportSpecifiers.push({ name, site, ...symbols });
  }

  hasDeclarationExport(name: string, meaning: MeaningSpace): boolean {
    return this.spaceSets(meaning).declarationExported.has(name);
  }

  deleteClauseExportSymbol(symbol: Sym, meaning: MeaningSpace): void {
    const { table, clauseOnly } = this.spaceSets(meaning);
    for (const [exportName, exported] of table) {
      if (exported !== symbol) continue;
      table.delete(exportName);
      clauseOnly.delete(exportName);
    }
  }

  isClauseOnlyExport(name: string, meaning: MeaningSpace): boolean {
    return this.spaceSets(meaning).clauseOnly.has(name);
  }

  tableOf(meaning: MeaningSpace): Map<string, Sym> {
    return meaning === 'value' ? this.values : meaning === 'type' ? this.types : this.namespaces;
  }

  private spaceSets(meaning: MeaningSpace): {
    table: Map<string, Sym>;
    clauseOnly: Set<string>;
    declarationExported: Set<string>;
  } {
    if (meaning === 'value') {
      return {
        table: this.values,
        clauseOnly: this.clauseOnlyValues,
        declarationExported: this.declarationExportedValues,
      };
    }
    if (meaning === 'type') {
      return {
        table: this.types,
        clauseOnly: this.clauseOnlyTypes,
        declarationExported: this.declarationExportedTypes,
      };
    }
    return {
      table: this.namespaces,
      clauseOnly: this.clauseOnlyNamespaces,
      declarationExported: this.declarationExportedNamespaces,
    };
  }

  private augmented(name: string): Scope | undefined {
    return this.augmentedNames.has(name) ? this.augments : undefined;
  }

  declareAmbientValue(name: string, kind: 'var' | 'let' | 'const', declaration: TreeNode, nameNode: TreeNode): void {
    const symbol = this.declareValue(name, 'declared', declaration, nameNode);
    symbol.valueEntries.at(-1)!.kind = kind;
  }

  declareValue(rawName: string, kind: ValueKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    const name = canonicalIdentifier(rawName, nameNode);
    if (this.augments)
      return this.forwardAugmented(name, (augments) => augments.declareValue(name, kind, declaration, nameNode));
    const symbol = this.resolveDeclaredSymbol(name, 'value', declaration, () => {
      const existing = sharesNamespaceSymbol.has(kind) ? this.namespaces.get(name) : undefined;
      return existing?.namespaceKind === 'namespace' ? existing : undefined;
    });
    // An enum, a function, or a class merges into a namespace declared before it, whose exports it then holds too.
    if (symbol.valueKind === undefined || (symbol.valueKind === 'namespace' && mergesIntoNamespace.has(kind)))
      symbol.valueKind = kind;
    symbol.valueDeclarations.push(declaration);
    symbol.valueEntries.push({ kind, name: nameNode });
    return symbol;
  }

  declareNamespace(rawName: string, kind: NamespaceKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    const name = canonicalIdentifier(rawName, nameNode);
    if (this.augments)
      return this.forwardAugmented(name, (augments) => augments.declareNamespace(name, kind, declaration, nameNode));
    const symbol = this.resolveDeclaredSymbol(name, 'namespace', declaration, () => {
      const existing = kind === 'namespace' ? this.values.get(name) : undefined;
      return existing && (!existing.valueKind || sharesNamespaceSymbol.has(existing.valueKind)) ? existing : undefined;
    });
    symbol.namespaceKind ??= kind;
    symbol.namespaceDeclarations.push(declaration);
    symbol.namespaceEntries.push({ kind, name: nameNode });
    return symbol;
  }

  declareType(rawName: string, kind: TypeKind, declaration: TreeNode, nameNode: TreeNode = declaration): Sym {
    const name = canonicalIdentifier(rawName, nameNode);
    if (this.augments)
      return this.forwardAugmented(name, (augments) => augments.declareType(name, kind, declaration, nameNode));
    // A class or an enum is a value and a type of the same name.
    const symbol = this.resolveDeclaredSymbol(name, 'type', declaration, () =>
      kind === 'class' || kind === 'enum' ? this.values.get(name) : undefined
    );
    // An interface declared before the class of its name merges into the class.
    symbol.typeKind = kind === 'class' && symbol.typeKind === 'interface' ? 'class' : (symbol.typeKind ?? kind);
    symbol.typeDeclarations.push(declaration);
    symbol.typeEntries.push({ kind, name: nameNode });
    return symbol;
  }

  private forwardAugmented(name: string, declare: (augments: Scope) => Sym): Sym {
    this.augmentedNames.add(name);
    return declare(this.augments as Scope);
  }

  private resolveDeclaredSymbol(
    name: string,
    meaning: MeaningSpace,
    declaration: TreeNode,
    reuseShared: () => Sym | undefined
  ): Sym {
    const table = this.tableOf(meaning);
    let symbol = table.get(name) ?? this.exportedNamespaceSymbol(name, declaration, meaning);
    if (!symbol) {
      symbol = reuseShared() ?? new Sym(name, this);
      table.set(name, symbol);
    }
    return symbol;
  }

  /** The symbol another body of this namespace already exported under `name`, when `declaration` is exported too. */
  private exportedNamespaceSymbol(name: string, declaration: TreeNode, meaning: MeaningSpace): Sym | undefined {
    if (!this.namespace || !isExportedFromNamespace(this.isAmbient, declaration)) return undefined;
    const exports = this.namespace.namespaceExports;
    if (!exports || exports.isClauseOnlyExport(name, meaning)) return undefined;
    const exported = exports.tableOf(meaning).get(name);
    if (!exported) return undefined;
    this.tableOf(meaning).set(name, exported);
    return exported;
  }
}

function isContainerValueKind(kind: ValueKind | undefined): boolean {
  return kind === 'enum' || kind === 'import' || kind === 'importAlias';
}

export function canonicalIdentifier(name: string, nameNode: TreeNode): string {
  if (!name.includes('\\')) return name;
  try {
    return nameOf(nameNode);
  } catch {
    return name;
  }
}

function isExportedFromNamespace(isAmbientScope: boolean, declaration: TreeNode): boolean {
  if (isAmbientScope) return true;
  let current: TreeNode | null = declaration;
  if (current.type === 'variable_declarator') current = current.parent;
  if (current?.type === 'expression_statement' || current?.type === 'ambient_declaration') current = current.parent;
  return current?.parent?.type === 'export_statement';
}
