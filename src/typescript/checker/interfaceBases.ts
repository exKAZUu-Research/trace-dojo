import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import type { Checker } from './checker';
import { isGenericObjectOrIndexType } from './genericTypes';
import { withDomMembers } from './library';
import type { Sym } from './scopes';
import { named } from './syntax';
import { anyType, isAnyLike, nonPrimitiveType, type ObjectType, type Type } from './types';

interface BaseResolution {
  /** The base types, unset while they resolve. */
  types?: Type[];
  circular: boolean;
}

/** Resolves the types interfaces extend, as TypeScript's `getBaseTypes` does, reporting invalid and circular bases. */
export class InterfaceBases {
  private readonly symbols = new WeakMap<ObjectType, Sym>();
  /** The base types of interfaces, by symbol id. */
  private readonly resolutions = new Map<number, BaseResolution>();
  /** The interfaces whose base types are resolving, outermost first. */
  private readonly stack: BaseResolution[] = [];
  private deferredChecks: (() => void)[] = [];
  /** The member types of the DOM interfaces that a merged DOM interface extends, by symbol id. */
  private readonly domBaseTypes = new Map<number, Type>();

  constructor(private readonly c: Checker) {}

  /** Records the interface a declared interface type stands for, so that a base referring to it is followed. */
  register(type: ObjectType, symbol: Sym): void {
    this.symbols.set(type, symbol);
  }

  /**
   * The types an interface extends: an interface whose bases need its own bases, directly or through other interfaces,
   * is reported as each interface in the cycle is, and loses those bases.
   */
  baseTypesOf(symbol: Sym): Type[] {
    const existing = this.resolutions.get(symbol.id);
    if (existing?.types) return existing.types;
    if (existing) {
      for (const resolution of this.stack.slice(this.stack.indexOf(existing))) resolution.circular = true;
      return [];
    }
    const resolution: BaseResolution = { circular: false };
    this.resolutions.set(symbol.id, resolution);
    this.stack.push(resolution);
    const types = this.basesOf(symbol.typeDeclarations).filter((base) => {
      if (!this.hasBaseType(base, symbol, new Set())) return true;
      resolution.circular = true;
      return false;
    });
    this.stack.pop();
    resolution.types = types;
    if (resolution.circular) this.reportCircularBases(symbol);
    if (this.stack.length === 0) this.runDeferredChecks();
    return types;
  }

  /** The valid types the `extends` clauses of interface declarations name, reporting the others. */
  basesOf(declarations: TreeNode[]): Type[] {
    return declarations
      .flatMap((declaration) => heritageNodes(withDomMembers(declaration)))
      .flatMap((node) => this.validBase(node));
  }

  /**
   * Runs a check once the interface bases resolving, if any, are resolved, as one that needs their members, such as a
   * type argument's constraint `keyof` an interface, would otherwise find a cycle TypeScript does not.
   */
  afterResolving(check: () => void): void {
    if (this.stack.length === 0) {
      check();
      return;
    }
    const { silent } = this.c;
    this.deferredChecks.push(() => {
      const outer = this.c.silent;
      this.c.silent = silent;
      try {
        check();
      } finally {
        this.c.silent = outer;
      }
    });
  }

  private runDeferredChecks(): void {
    const checks = this.deferredChecks;
    this.deferredChecks = [];
    for (const check of checks) check();
  }

  private reportCircularBases(symbol: Sym): void {
    for (const declaration of symbol.typeDeclarations) {
      if (declaration.type !== 'interface_declaration') continue;
      const typeParameters = declaration.childForFieldName('type_parameters')?.text ?? '';
      this.c.errorWhileResolving(
        declaration.childForFieldName('name') ?? declaration,
        `型 '${symbol.name}${typeParameters}' は、自分自身を基底型として参照しています。`
      );
    }
  }

  /**
   * Whether a base type is the interface or extends it, through the interfaces it extends, skipping the interfaces
   * already searched, as interfaces sharing bases would otherwise be searched once per path.
   */
  private hasBaseType(type: Type, symbol: Sym, searched: Set<Sym>): boolean {
    this.c.budget.spend();
    if (type.kind === 'intersection') return type.types.some((member) => this.hasBaseType(member, symbol, searched));
    if (type.kind !== 'object') return false;
    const target = this.symbols.get(type.target ?? type.origin ?? type);
    if (!target || searched.has(target)) return false;
    searched.add(target);
    return target === symbol || this.baseTypesOf(target).some((base) => this.hasBaseType(base, symbol, searched));
  }

  /** A DOM interface the library extends lends its members, though it stands for `any` where a program names it. */
  private baseType(base: TreeNode): Type {
    const symbol = this.c.isLibrary(base) ? this.c.scopeOf(base).lookupType(base.text) : undefined;
    if (!symbol || !this.c.typeNodes.isOpaqueDomInterface(symbol)) return this.c.typeNodes.typeFromNode(base);
    let type = this.domBaseTypes.get(symbol.id);
    if (!type) {
      type = this.c.typeNodes.interfaceType(symbol);
      this.domBaseTypes.set(symbol.id, type);
    }
    return type;
  }

  private validBase(baseNode: TreeNode): Type[] {
    const base = this.baseType(baseNode);
    if (this.isValidBaseType(base)) return [base];
    this.c.errorWhileResolving(
      baseNode,
      'インターフェースが継承できるのは、メンバーが静的に決まるオブジェクト型か、その交差型だけです。'
    );
    return [];
  }

  /**
   * Whether a type may be a base type, as TypeScript's `isValidBaseType` decides: an object type other than a generic
   * mapped type, `object`, `any`, an intersection of such types, or a type parameter whose non-circular constraint is
   * one.
   */
  isValidBaseType(type: Type): boolean {
    this.c.budget.spend();
    switch (type.kind) {
      case 'intrinsic': {
        return isAnyLike(type) || type === nonPrimitiveType;
      }
      case 'object': {
        return type.objectKind !== 'mapped' || !isGenericObjectOrIndexType(type.mapped?.constraint ?? anyType);
      }
      case 'intersection': {
        return type.types.every((member) => this.isValidBaseType(member));
      }
      case 'typeParameter': {
        const constraint = this.c.constraintOf(type);
        return constraint !== undefined && this.isValidBaseType(constraint);
      }
      default: {
        return false;
      }
    }
  }
}

/** The type nodes of the `extends` clause of an interface declaration. */
function heritageNodes(declaration: TreeNode): TreeNode[] {
  const clause = declaration.namedChildren.find((child) => child?.type === 'extends_type_clause');
  return clause ? named(clause) : [];
}
