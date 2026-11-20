import type { TypeSymbol } from './types';

/** A namespace and the types and namespaces it contains. */
export class NamespaceSymbol {
  readonly namespaces = new Map<string, NamespaceSymbol>();
  /** The types by name, several of which may share a name with different numbers of type parameters. */
  readonly types = new Map<string, TypeSymbol[]>();

  constructor(
    readonly name: string,
    readonly parent: NamespaceSymbol | undefined
  ) {}

  get fullName(): string {
    if (!this.parent || !this.parent.parent) return this.name;
    return `${this.parent.fullName}.${this.name}`;
  }

  child(name: string): NamespaceSymbol {
    let child = this.namespaces.get(name);
    if (!child) {
      child = new NamespaceSymbol(name, this);
      this.namespaces.set(name, child);
    }
    return child;
  }

  /** The namespace at a dotted path below this one, creating it when `create`. */
  resolve(path: readonly string[], create: boolean): NamespaceSymbol | undefined {
    let current: NamespaceSymbol | undefined;
    for (const name of path) {
      const parent: NamespaceSymbol = current ?? this;
      current = create ? parent.child(name) : parent.namespaces.get(name);
      if (!current) return undefined;
    }
    return current ?? this;
  }

  addType(symbol: TypeSymbol): void {
    const list = this.types.get(symbol.name) ?? [];
    list.push(symbol);
    this.types.set(symbol.name, list);
  }

  findType(name: string, arity: number): TypeSymbol | undefined {
    return this.types.get(name)?.find((symbol) => symbol.typeParameters.length === arity);
  }
}

/** The namespaces that a file-based app imports without `using` (its implicit global usings). */
export const IMPLICIT_USINGS = [
  ['System'],
  ['System', 'Collections', 'Generic'],
  ['System', 'IO'],
  ['System', 'Linq'],
  ['System', 'Net', 'Http'],
  ['System', 'Threading'],
  ['System', 'Threading', 'Tasks'],
];
