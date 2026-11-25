import type { Node as TreeNode } from '@willbooster/web-tree-sitter';

import { unsupportedMessage } from '../unsupported';
import type { Checker } from './checker';
import { FlowState } from './flow';
import { unavailableNodeMember } from './nodeLibrary';
import type { Scope, Sym } from './scopes';
import { named, stringValue } from './syntax';
import {
  anonymousObject,
  anyType,
  emptyStructure,
  intersectionOf,
  type ObjectType,
  simpleProperty,
  type Type,
} from './types';

/** The declarations that declare only types, which leave a namespace without an object at run time. */
const typeOnlyDeclarations = new Set(['interface_declaration', 'type_alias_declaration', 'comment']);

/**
 * Namespaces: the object a namespace's exported values make, the types it exports, and the checks of its declarations.
 */
export class Namespaces {
  private readonly objectTypes = new Map<number, ObjectType>();
  private readonly resolvingAliases = new Set<number>();

  constructor(private readonly c: Checker) {}

  /** The type of a namespace's object: its exported values, as properties that `const` and functions make read-only. */
  objectType(symbol: Sym): ObjectType {
    const cached = this.objectTypes.get(symbol.id);
    if (cached) return cached;
    const exports = symbol.namespaceExports;
    const type = anonymousObject(
      () => {
        const structure = emptyStructure();
        for (const [name, member] of exports?.values ?? []) {
          if (member.valueKind === 'namespace' && !this.isInstantiated(member)) continue;
          const readonly = member.valueEntries.every((entry) => entry.kind !== 'let' && entry.kind !== 'var');
          structure.properties.set(name, {
            ...simpleProperty(name, anyType, { readonly, declaration: member.valueDeclaration }),
            type: () => this.c.expressions.valueTypeOf(member),
          });
        }
        return structure;
      },
      { valueName: qualifiedName(symbol), nonGeneric: true }
    );
    this.objectTypes.set(symbol.id, type);
    return type;
  }

  /** The type of a function, class, or enum merged with a namespace, which has the namespace's exports too. */
  withExports(symbol: Sym, type: Type): Type {
    if (!symbol.namespaceExports || symbol.valueKind === 'namespace' || !this.isInstantiated(symbol)) return type;
    return intersectionOf([type, this.objectType(symbol)], this.c);
  }

  /** Whether a namespace has values, which give it an object; one that only declares types has none. */
  isInstantiated(symbol: Sym): boolean {
    return symbol.valueDeclarations.some(
      (declaration) =>
        (declaration.type === 'internal_module' || declaration.type === 'module') &&
        (isAmbient(declaration) || this.bodyHasValues(declaration, symbol))
    );
  }

  private bodyHasValues(declaration: TreeNode, symbol: Sym): boolean {
    const name = declaration.childForFieldName('name');
    // In `namespace A.B { ... }`, the body belongs to the last name, and `A` holds the namespace `B`.
    if (name?.type === 'nested_identifier' && name.childForFieldName('property')?.text !== symbol.name) {
      const exports = symbol.namespaceExports;
      return [...(exports?.values.values() ?? [])].some((member) => this.isInstantiated(member));
    }
    const body = declaration.childForFieldName('body');
    return named(body ?? declaration).some((statement) => {
      const declared = statement.type === 'export_statement' ? statement.childForFieldName('declaration') : statement;
      if (!declared || typeOnlyDeclarations.has(declared.type)) return false;
      const inner = declared.type === 'expression_statement' ? named(declared)[0] : declared;
      if (inner?.type !== 'internal_module') return true;
      const innerName = inner.childForFieldName('name');
      const innerSymbol = innerName ? this.c.scopeOf(inner).lookupValue(innerName.text) : undefined;
      return !innerSymbol || this.isInstantiated(innerSymbol);
    });
  }

  /** A namespace that only declares types has no object to use as a value. */
  checkValueUse(node: TreeNode, symbol: Sym): void {
    if (symbol.valueEntries.every((entry) => entry.kind === 'namespace') && !this.isInstantiated(symbol))
      this.c.error(node, `名前空間 '${symbol.name}' は値として使えません。`);
  }

  /** What `import X = N.Y` names, as a value or as a type, or undefined when its path names nothing. */
  aliasTarget(alias: Sym, meaning: 'value' | 'type'): Sym | undefined {
    const declaration = alias.valueDeclaration ?? alias.typeDeclarations[0];
    const target = declaration && named(declaration)[1];
    if (!target || this.resolvingAliases.has(alias.id)) return undefined;
    this.resolvingAliases.add(alias.id);
    try {
      return this.resolvePath(qualifiedPath(target), meaning).symbol;
    } finally {
      this.resolvingAliases.delete(alias.id);
    }
  }

  /** Reports the path of `import X = N.Y` that names nothing. */
  checkImportAlias(node: TreeNode): void {
    const target = named(node)[1];
    if (!target) return;
    const path = qualifiedPath(target);
    const value = this.resolvePath(path, 'value');
    if (value.symbol) return;
    const type = this.resolvePath(path, 'type');
    if (!type.symbol && value.error) this.c.error(target, value.error);
  }

  /** The symbol the last name of a path names, as a value or a type, through the namespaces of the names before it. */
  private resolvePath(path: TreeNode[], meaning: 'value' | 'type'): { symbol?: Sym; error?: string } {
    const [root, ...rest] = path;
    const rootValue = this.unaliased(this.c.scopeOf(root).lookupValue(root.text), 'value');
    if (rest.length === 0)
      return {
        symbol: meaning === 'value' ? rootValue : this.unaliased(this.c.scopeOf(root).lookupType(root.text), 'type'),
      };
    if (!rootValue?.namespaceExports) return { error: `名前空間 ${root.text} が見つかりません。` };
    let current: Sym = rootValue;
    for (const [index, part] of rest.entries()) {
      const remaining = rest.length - 1 - index;
      const next = this.pathMember(current, part.text, remaining === 0 ? meaning : 'value');
      if (next.error) return next;
      const symbol = next.symbol as Sym;
      // An enum's members are the last name of a path, as in `import X = N.E.A`.
      if (remaining > 0 && !symbol.namespaceExports && !(symbol.valueKind === 'enum' && remaining === 1))
        return { error: missingMemberError(current, part.text) };
      current = symbol;
    }
    return { symbol: current };
  }

  /** What a name of a path names in the namespace or enum before it, or why it names nothing there. */
  private pathMember(container: Sym, name: string, meaning: 'value' | 'type'): { symbol?: Sym; error?: string } {
    const symbol = container.namespaceExports
      ? this.exportedMember(container, name, meaning)
      : container.enumMembers?.values.get(name);
    if (symbol) return { symbol };
    return { error: missingMemberError(container, name) };
  }

  private exportedMember(namespace: Sym, name: string, meaning: 'value' | 'type'): Sym | undefined {
    const exports = namespace.namespaceExports as Scope;
    return this.unaliased((meaning === 'type' ? exports.types : exports.values).get(name), meaning);
  }

  private unaliased(symbol: Sym | undefined, meaning: 'value' | 'type'): Sym | undefined {
    const kind = meaning === 'value' ? symbol?.valueKind : symbol?.typeKind;
    return symbol && (kind === 'import' || kind === 'importAlias') ? this.imported(symbol, meaning) : symbol;
  }

  /** What a name that `import` or `import X = N.Y` declares stands for, as a value or as a type. */
  imported(symbol: Sym, meaning: 'value' | 'type'): Sym | undefined {
    return symbol.importTarget ? this.importTarget(symbol, meaning) : this.aliasTarget(symbol, meaning);
  }

  /** What a name an `import` declares stands for: the module, or what the module exports by that name. */
  importTarget(symbol: Sym, meaning: 'value' | 'type'): Sym | undefined {
    const target = symbol.importTarget;
    const module = target && this.moduleNamed(target.module);
    if (!target || !module) return undefined;
    if (target.name === '*' || this.isSyntheticDefault(module, target.name)) return module;
    const exports = module.namespaceExports as Scope;
    return (meaning === 'value' ? exports.values : exports.types).get(target.name);
  }

  /**
   * Whether `import x from "m"` names the whole of a Node module, which has no default export of its own: tsc's default
   * `esModuleInterop` lets a default import stand for a CommonJS module.
   */
  private isSyntheticDefault(module: Sym, name: string): boolean {
    return name === 'default' && !module.namespaceExports?.values.has('default') && this.isLibraryModule(module);
  }

  private isLibraryModule(module: Sym): boolean {
    return this.c.libraryBinder.ambientModules.get(module.name) === module;
  }

  /** The object of a module the library declares, as `import * as` gives it, or undefined for another module. */
  moduleObjectType(name: string): Type | undefined {
    const module = this.c.libraryBinder.ambientModules.get(name);
    return module && this.objectType(module);
  }

  private moduleNamed(name: string): Sym | undefined {
    return this.c.libraryBinder.ambientModules.get(name) ?? this.c.binder.ambientModules.get(name);
  }

  /** Reports a default import of a module without a default export, and a name a module does not export. */
  checkImport(node: TreeNode): void {
    const attributes = named(node).find((child) => child.type === 'import_attribute');
    if (attributes)
      this.c.error(
        attributes,
        "インポート属性は、'--module' オプションが 'esnext'、'node18'、'node20'、'nodenext'、'preserve' のどれかのときしか使えません。"
      );
    const source = node.childForFieldName('source');
    const clause = node.childForFieldName('import_clause');
    // tsc without `--module` compiles to ECMAScript modules, which have no `import x = require("m")`.
    if (clause?.type === 'import_require_clause')
      this.c.error(
        node,
        `ECMAScript モジュールを対象にする場合は、インポート代入を使用できません。代わりに 'import * as ns from "mod"'、'import {a} from "mod"'、'import d from "mod"' などのモジュール書式の使用をご検討ください。`
      );
    if (!source || !clause || clause.type === 'import_require_clause') return;
    const module = this.moduleNamed(stringValue(source));
    if (!module) return;
    const moduleName = `'"${stringValue(source)}"'`;
    for (const part of named(clause)) {
      if (part.type === 'identifier' && !this.isSyntheticDefault(module, 'default'))
        this.c.error(part, `モジュール ${moduleName} には既定のエクスポートがありません。`);
      if (part.type === 'named_imports') this.checkNamedImports(part, module, moduleName);
    }
  }

  private checkNamedImports(imports: TreeNode, module: Sym, moduleName: string): void {
    const exports = module.namespaceExports as Scope;
    for (const specifier of named(imports)) {
      const name = specifier.childForFieldName('name');
      const unavailable = name && this.isLibraryModule(module) && unavailableNodeMember(`"${module.name}"`, name.text);
      if (name && unavailable) this.c.error(name, unsupportedMessage(unavailable));
      else if (name && !exports.values.has(name.text) && !exports.types.has(name.text))
        this.c.error(name, `モジュール ${moduleName} には、エクスポートされたメンバー '${name.text}' がありません。`);
    }
  }

  /** The symbol of the type a qualified name such as `N.T` or `A.B.T` names, through the namespaces of its path. */
  qualifiedTypeSymbol(node: TreeNode): { symbol?: Sym; error?: string } {
    return this.resolvePath(qualifiedPath(node), 'type');
  }

  /** The symbol of the value a qualified name such as `N.E` names, or undefined when it names no value at run time. */
  qualifiedValueSymbol(node: TreeNode): Sym | undefined {
    const { symbol } = this.resolvePath(qualifiedPath(node), 'value');
    return symbol?.valueKind === 'namespace' && !this.isInstantiated(symbol) ? undefined : symbol;
  }

  /** Checks a namespace's body, whose code runs once where the namespace is declared, from a flow of its own. */
  checkDeclaration(node: TreeNode): void {
    const name = node.childForFieldName('name');
    if (node.type === 'module' && name?.type !== 'string')
      this.c.error(
        node,
        "'namespace' の宣言に 'module' キーワードは使えません。代わりに 'namespace' キーワードを使ってください。"
      );
    const body = node.childForFieldName('body');
    if (!body || isAmbient(node) || name?.type === 'string') return;
    const outer = this.c.flow.current;
    this.c.flow.current = new FlowState();
    try {
      this.c.statements.declareHoistedVariables(this.c.binder.ownScope(body));
      this.c.statements.checkBlockStatements(named(body));
    } finally {
      this.c.flow.current = outer;
    }
  }
}

/** Whether a declaration is in an ambient context, as in `declare namespace`, which declares without code to run. */
export function isAmbient(node: TreeNode): boolean {
  for (let current: TreeNode | null = node; current; current = current.parent)
    if (current.type === 'ambient_declaration') return true;
  return false;
}

/** The names of a qualified type name, as `A`, `B`, and `T` of `A.B.T`. */
function qualifiedPath(node: TreeNode): TreeNode[] {
  if (node.type !== 'nested_type_identifier' && node.type !== 'nested_identifier' && node.type !== 'member_expression')
    return [node];
  const left = node.childForFieldName('module') ?? node.childForFieldName('object');
  const right = node.childForFieldName('name') ?? node.childForFieldName('property');
  return [...(left ? qualifiedPath(left) : []), ...(right ? [right] : [])];
}

/** The name a namespace is printed with, `A.B` for `B` in `A`. */
function missingMemberError(container: Sym, name: string): string {
  return `名前空間 '${qualifiedName(container)}' には、エクスポートされたメンバー '${name}' がありません。`;
}

function qualifiedName(symbol: Sym): string {
  return symbol.exportedFrom ? `${qualifiedName(symbol.exportedFrom)}.${symbol.name}` : symbol.name;
}
