import type { ExtensionDeclaration } from './ast';
import type { ClassInfo, Member } from './classes';
import { isSdkExport } from './library/sdkExports';
import type { Runtime } from './runtime';
import type { DartType, FunctionType, TypeParam } from './types';
import type { Callable, Value } from './values';

/** A top-level function, getter, or setter, or a static method of a class compiled like one. */
export interface TopLevelFunction {
  name: string;
  type: FunctionType;
  /** Set once the body is compiled, which may come after calls to it are compiled. */
  impl: Callable | undefined;
  row: number | undefined;
  library: string;
  isAtomic: boolean;
}

/** A top-level variable or a static field, which Dart initializes the first time it is read. */
export interface GlobalVariable {
  name: string;
  /** The name a trace shows: `x`, or `Counter.count` for a static field. */
  displayName: string;
  type: DartType;
  slot: number;
  isFinal: boolean;
  isConst: boolean;
  isLate: boolean;
  hasInitializer: boolean;
  /** The initializer, run lazily; undefined for a variable without one. */
  initialize: ((runtime: Runtime) => Value) | undefined;
  /** The value it holds before the program runs, when its initializer is a constant expression of a primitive. */
  initialValue: { value: Value } | undefined;
  library: string;
  row: number | undefined;
  owner: ClassInfo | undefined;
}

export interface ExtensionInfo {
  name: string | undefined;
  declaration: ExtensionDeclaration;
  typeParams: TypeParam[];
  onType: DartType;
  members: Map<string, Member>;
  setters: Map<string, Member>;
  staticMembers: Map<string, Member>;
  staticSetters: Map<string, Member>;
  library: string;
}

export interface TypeAlias {
  name: string;
  typeParams: TypeParam[];
  /** Resolved after every class of the library is declared. */
  aliased: DartType | undefined;
  library: string;
}

export type Declaration =
  | { kind: 'class'; cls: ClassInfo }
  | { kind: 'alias'; alias: TypeAlias }
  | { kind: 'function'; fn: TopLevelFunction }
  | { kind: 'variable'; global: GlobalVariable }
  | { kind: 'accessor'; getter: TopLevelFunction | undefined; setter: TopLevelFunction | undefined }
  | { kind: 'extension'; ext: ExtensionInfo };

interface Import {
  library: LibraryEnv;
  prefix: string | undefined;
  show: ReadonlySet<string> | undefined;
  hide: ReadonlySet<string>;
}

/** The top-level names of a library: its own declarations and what it imports. */
export class LibraryEnv {
  readonly declarations = new Map<string, Declaration>();
  readonly imports: Import[] = [];
  /** Names only the interpreter's other libraries see, such as dart:core's LinkedHashMap, which dart:collection exports. */
  readonly hiddenNames = new Set<string>();
  /** Declarations of other libraries this library exports as its own. */
  readonly reexports = new Map<string, Declaration>();

  constructor(readonly name: string) {}

  addImport(library: LibraryEnv, prefix: string | undefined, show: string[] | undefined, hide: string[]): void {
    this.imports.push({ library, prefix, show: show ? new Set(show) : undefined, hide: new Set(hide) });
  }

  /** A name as code in this library sees it without a prefix. */
  lookup(name: string): Declaration | undefined {
    return this.declarations.get(name) ?? this.lookupImported(name, undefined);
  }

  lookupPrefixed(prefix: string, name: string): Declaration | undefined {
    return this.lookupImported(name, prefix);
  }

  hasPrefix(prefix: string): boolean {
    return this.imports.some((entry) => entry.prefix === prefix);
  }

  hasVisibleSdkExport(name: string, prefix: string | undefined): boolean {
    return this.imports.some(
      (entry) => entry.prefix === prefix && isVisible(entry, name) && isSdkExport(entry.library.name, name)
    );
  }

  private lookupImported(name: string, prefix: string | undefined): Declaration | undefined {
    const isInternal = this.name.startsWith('dart:');
    for (const entry of this.imports) {
      if (entry.prefix !== prefix) continue;
      if (!isVisible(entry, name, isInternal)) continue;
      if (!isInternal && entry.library.hiddenNames.has(name)) continue;
      const found = entry.library.declarations.get(name) ?? entry.library.reexports.get(name);
      if (found) return found;
    }
    return undefined;
  }

  /** The extensions whose members apply here: declared in this library or imported without being hidden. */
  extensionsInScope(): ExtensionInfo[] {
    const result: ExtensionInfo[] = [];
    for (const declaration of this.declarations.values())
      if (declaration.kind === 'extension') result.push(declaration.ext);
    for (const entry of this.imports) {
      for (const declarations of [entry.library.declarations, entry.library.reexports]) {
        for (const [name, declaration] of declarations) {
          if (declaration.kind === 'extension' && isVisible(entry, name)) result.push(declaration.ext);
        }
      }
    }
    return result;
  }
}

function isVisible(entry: Import, name: string, isInternal = false): boolean {
  if (name.startsWith('_') && !isInternal) return false;
  if (entry.show && !entry.show.has(name)) return false;
  return !entry.hide.has(name);
}
