import { unsupported } from './errors';
import { typeKey } from './library/templates';
import type { NamespaceInfo } from './scopes';
import { type ClassInfo, type IntName, isConstType, type Type } from './types';

const BUILTIN_CODES: Record<IntName | 'float' | 'double' | 'ldouble', string> = {
  bool: 'b',
  char: 'c',
  schar: 'a',
  uchar: 'h',
  short: 's',
  ushort: 't',
  int: 'i',
  uint: 'j',
  long: 'l',
  ulong: 'm',
  llong: 'x',
  ullong: 'y',
  float: 'f',
  double: 'd',
  ldouble: 'e',
};

/** The library's sequences whose only other template argument is their allocator. */
const ALLOCATED_SEQUENCES = new Set(['vector', 'deque', 'list']);

/** The name of `std::string` that libc++'s `typeid(std::string).name()` gives. */
const STRING_NAME = 'NSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEE';

/**
 * The name `typeid(T).name()` gives for a type, as Apple clang++ mangles it for the Itanium C++ ABI: the type without
 * its top-level const, with substitutions (`S_`) for the components that repeat.
 */
export function typeInfoName(type: Type, row: number): string {
  const mangler = new Mangler(row);
  const plain = type.kind === 'reference' ? type.to : type;
  return mangler.type(isConstType(plain) ? withoutConst(plain) : plain);
}

function withoutConst(type: Type): Type {
  const { isConst: _, ...plain } = type as Type & { isConst?: boolean };
  return plain as Type;
}

class Mangler {
  private readonly substitutions: string[] = [];

  constructor(private readonly row: number) {}

  type(type: Type): string {
    switch (type.kind) {
      case 'void': {
        return 'v';
      }
      case 'nullptr': {
        return 'Dn';
      }
      case 'int': {
        if (type.enumeration) return this.substitutable(this.sourceName(type.enumeration.name));
        return BUILTIN_CODES[type.name];
      }
      case 'float': {
        return BUILTIN_CODES[type.name];
      }
      case 'pointer': {
        const pointee = isConstType(type.to)
          ? this.substitutable(`K${this.type(withoutConst(type.to))}`)
          : this.type(type.to);
        return this.substitutable(`P${pointee}`);
      }
      case 'reference': {
        return this.substitutable(`${type.isRvalue ? 'O' : 'R'}${this.type(type.to)}`);
      }
      case 'array': {
        return this.substitutable(`A${type.length ?? ''}_${this.type(type.of)}`);
      }
      case 'function': {
        const params = type.params.length === 0 ? 'v' : type.params.map((param) => this.type(param)).join('');
        return this.substitutable(`F${this.type(type.ret)}${params}E`);
      }
      case 'class': {
        return this.className(type.cls);
      }
      default: {
        return unsupported(this.row, 'この型の typeid(...).name()');
      }
    }
  }

  private className(cls: ClassInfo): string {
    if (cls.library?.kind === 'string') return STRING_NAME;
    const kind = cls.library?.kind;
    if (kind && ALLOCATED_SEQUENCES.has(kind)) {
      // `std::vector<T>` is `std::__1::vector<T, std::__1::allocator<T>>`, whose `std::__1` is the first substitution.
      const element = cls.library?.args[0] as Type;
      const whole = `std::${kind}<${typeKey(element)}>`;
      const known = this.known(whole);
      if (known) return known;
      const template = this.substitutable(`${this.std()}${this.sourceName(kind)}`, `std::${kind}`);
      const elementCode = this.type(element);
      const allocatorTemplate = this.substitutable(`${this.std()}9allocator`, 'std::allocator');
      const allocator = this.substitutable(
        `N${allocatorTemplate}I${this.type(element)}EE`,
        `std::allocator<${typeKey(element)}>`
      );
      return this.substitutable(`N${template}I${elementCode}${allocator}EE`, whole);
    }
    if (cls.library || cls.isLambda || cls.isUnnamed || cls.localScopes)
      return unsupported(this.row, `${cls.name} の typeid(...).name()`);
    const prefixes = [...namespacesOf(cls.outer?.namespace ?? cls.namespace), ...outerClasses(cls)];
    const args = cls.templateArgs;
    const name = this.sourceName(cls.name);
    if (prefixes.length === 0) {
      if (!args) return this.substitutable(name);
      const template = this.substitutable(name);
      return this.substitutable(`${template}${this.templateArgs(args)}`);
    }
    let prefix = '';
    for (const component of prefixes) prefix = this.substitutable(`${prefix}${this.sourceName(component)}`);
    const unqualified = `${prefix}${name}`;
    const full = args ? `${this.substitutable(unqualified)}${this.templateArgs(args)}` : unqualified;
    return this.substitutable(`N${full}E`, full);
  }

  private templateArgs(args: readonly Type[]): string {
    const written = args.map((arg) =>
      arg.kind === 'int' && arg.templateValue !== undefined
        ? `L${BUILTIN_CODES[arg.name]}${arg.templateValue < 0 ? `n${-BigInt(arg.templateValue)}` : arg.templateValue}E`
        : this.type(arg)
    );
    return `I${written.join('')}E`;
  }

  private sourceName(name: string): string {
    const plain = name.replace(/^std::/, '');
    return `${plain.length}${plain}`;
  }

  private std(): string {
    return this.substitutable('St3__1', 'std');
  }

  /** The substitution of a component an earlier one was the same as, if any. */
  private known(key: string): string | undefined {
    const index = this.substitutions.indexOf(key);
    if (index === 0) return 'S_';
    if (index > 0) return `S${(index - 1).toString(36).toUpperCase()}_`;
    return undefined;
  }

  /** A component as written, or its substitution when an earlier one was the same, recording a new one. */
  private substitutable(mangled: string, key = mangled): string {
    const index = this.substitutions.indexOf(key);
    if (index === 0) return 'S_';
    if (index > 0) return `S${(index - 1).toString(36).toUpperCase()}_`;
    this.substitutions.push(key);
    return mangled;
  }
}

function namespacesOf(ns: NamespaceInfo | undefined): string[] {
  const names: string[] = [];
  for (let current = ns; current; current = current.parent) names.unshift(current.name);
  return names;
}

function outerClasses(cls: ClassInfo): string[] {
  const names: string[] = [];
  for (let outer = cls.outer; outer; outer = outer.outer) names.unshift(outer.name);
  return names;
}
