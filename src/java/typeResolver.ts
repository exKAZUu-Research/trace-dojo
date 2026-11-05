import { CompileError } from '../interpreter/diagnostics';
import type { ImportDeclaration, Span, TypeParameter, TypeSyntax } from './ast';
import { getBuiltins } from './builtins';
import {
  asSuper,
  type ClassInfo,
  type ClassType,
  hasGenericOuter,
  isPrimitive,
  isSubclass,
  type JavaType,
  superinterfacesOf,
  thisTypeOf,
  typeName,
  type TypeVariable,
} from './types';

/** Resolves the names of types: classes in scope, type variables, imports, and type arguments. */
export abstract class TypeResolver {
  protected readonly builtins = getBuiltins();
  protected readonly classes = new Map<string, ClassInfo>();
  /** The class whose body the code being compiled is in, which decides what simple type names mean. */
  protected typeScope: ClassInfo | undefined;

  protected error(span: Span, message: string): never {
    throw new CompileError([{ row: span.row, message }]);
  }

  protected resolveType(syntax: TypeSyntax): JavaType {
    switch (syntax.kind) {
      case 'primitive': {
        return { kind: syntax.name };
      }
      case 'array': {
        return { kind: 'array', element: this.resolveType(syntax.element) };
      }
      case 'named': {
        return this.resolveNamedType(syntax);
      }
      case 'wildcard': {
        return this.error(syntax, '? は型引数の中にしか書けません。');
      }
      case 'var': {
        return this.error(syntax, 'ここでは var を使えません。');
      }
    }
  }

  protected resolveNamedType(syntax: Extract<TypeSyntax, { kind: 'named' }>): JavaType {
    if (syntax.qualifier.length === 0) {
      const variable = this.findTypeVariable(syntax.name);
      if (variable) {
        if (syntax.args) this.error(syntax, `型パラメータ ${syntax.name} には型引数を付けられません。`);
        return { kind: 'typeVar', variable };
      }
    }
    let cls = this.lookupQualifiedType([...syntax.qualifier, syntax.name]);
    if (!cls) this.error(syntax, `この採点環境には、型 ${[...syntax.qualifier, syntax.name].join('.')} がありません。`);
    const outer = this.outerTypeOf(syntax, cls);
    if (!syntax.args) return outer ? { kind: 'class', cls, outer } : cls.type;
    const { typeParameters } = cls;
    // The diamond `<>` stands for arguments that the creation infers.
    if (syntax.args.length === 0) return { kind: 'class', cls, args: [], outer };
    if (typeParameters.length !== syntax.args.length) {
      this.error(
        syntax,
        typeParameters.length === 0
          ? `型 ${cls.name} には型引数を付けられません。`
          : `型 ${cls.name} には ${typeParameters.length} 個の型引数が必要です。`
      );
    }
    return { kind: 'class', cls, args: syntax.args.map((arg) => this.resolveTypeArgument(arg)), outer };
  }

  /**
   * The enclosing instance's type that a named inner class of a generic class has: the qualifier written with type
   * arguments, a raw qualifier, which erases them, or else the enclosing class's own type parameters.
   */
  private outerTypeOf(syntax: Extract<TypeSyntax, { kind: 'named' }>, cls: ClassInfo): ClassType | undefined {
    const { enclosing } = cls;
    if (!enclosing || !hasGenericOuter(cls)) return undefined;
    if (syntax.outer) {
      const outer = this.resolveType(syntax.outer);
      return outer.kind === 'class' ? (asSuper(outer, enclosing) ?? outer) : undefined;
    }
    if (syntax.qualifier.length > 0) return enclosing.type as ClassType;
    return thisTypeOf(enclosing);
  }

  /**
   * The class a dotted name names: a class in scope followed by its member types, or a package's class followed by
   * its member types, as `java.util.Map.Entry`.
   */
  protected lookupQualifiedType(segments: readonly string[]): ClassInfo | undefined {
    const [first, ...rest] = segments;
    const inScope = this.lookupType(first as string, this.typeScope);
    const memberOf = (start: ClassInfo | undefined, names: readonly string[]): ClassInfo | undefined => {
      let cls = start;
      for (const name of names) cls = cls && this.findMemberType(cls, name);
      return cls;
    };
    if (inScope) return memberOf(inScope, rest);
    // The longest package prefix whose next segment names a class of the library.
    for (let split = segments.length - 1; split >= 1; split--) {
      const cls = this.classesByQualifiedName().get(segments.slice(0, split + 1).join('.'));
      if (cls) return memberOf(cls, segments.slice(split + 1));
    }
    return undefined;
  }

  private qualifiedClassNames: Map<string, ClassInfo> | undefined;

  private classesByQualifiedName(): Map<string, ClassInfo> {
    this.qualifiedClassNames ??= new Map([...this.builtins.qualifiedNames].map(([cls, name]) => [name, cls]));
    return this.qualifiedClassNames;
  }

  protected resolveTypeArgument(syntax: TypeSyntax): JavaType {
    if (syntax.kind === 'wildcard') {
      return {
        kind: 'wildcard',
        bound: syntax.bound && this.resolveTypeArgument(syntax.bound),
        isSuper: syntax.isSuper,
      };
    }
    const type = this.resolveType(syntax);
    if (isPrimitive(type)) {
      const box = `${type.kind[0].toUpperCase()}${type.kind.slice(1)}`
        .replace('Int', 'Integer')
        .replace('Char', 'Character');
      this.error(syntax, `型引数にプリミティブ型 ${type.kind} は使えません。${box} を使ってください。`);
    }
    return type;
  }

  /** The type variables in scope, innermost last. */
  protected readonly typeVariableScopes: Map<string, TypeVariable>[] = [];

  protected findTypeVariable(name: string): TypeVariable | undefined {
    for (let index = this.typeVariableScopes.length - 1; index >= 0; index--) {
      const variable = this.typeVariableScopes[index].get(name);
      if (variable) return variable;
    }
    return;
  }

  /** Runs `compile` with type variables in scope. */
  protected withTypeVariables<T>(variables: readonly TypeVariable[], compile: () => T): T {
    if (variables.length === 0) return compile();
    this.typeVariableScopes.push(new Map(variables.map((variable) => [variable.name, variable])));
    try {
      return compile();
    } finally {
      this.typeVariableScopes.pop();
    }
  }

  /** Declares type parameters, whose bounds may name each other, defaulting a missing bound to `Object`. */
  protected declareTypeParameters(parameters: readonly TypeParameter[]): TypeVariable[] {
    const variables = this.typeParameterShells(parameters);
    this.resolveTypeParameterBounds(variables, parameters);
    return variables;
  }

  /** The variables of type parameters before their bounds are known, which other declarations may already name. */
  protected typeParameterShells(parameters: readonly TypeParameter[]): TypeVariable[] {
    const variables = parameters.map((parameter): TypeVariable => ({ name: parameter.name, bounds: [] }));
    for (const [index, parameter] of parameters.entries()) {
      if (variables.slice(0, index).some((other) => other.name === parameter.name)) {
        this.error(parameter, `型パラメータ ${parameter.name} が重複しています。`);
      }
    }
    return variables;
  }

  /** Resolves the bounds of type parameters into their variables. */
  protected resolveTypeParameterBounds(variables: TypeVariable[], parameters: readonly TypeParameter[]): void {
    this.withTypeVariables(variables, () => {
      for (const [index, parameter] of parameters.entries()) {
        variables[index].bounds =
          parameter.bounds.length > 0
            ? parameter.bounds.map((bound) => this.resolveType(bound))
            : [this.builtins.objectClass.type];
      }
    });
  }

  /** Runs `compile` with simple type names resolved inside `cls`'s body. */
  protected withTypeScope<T>(cls: ClassInfo | undefined, compile: () => T): T {
    const outer = this.typeScope;
    this.typeScope = cls;
    try {
      return compile();
    } finally {
      this.typeScope = outer;
    }
  }

  /** The classes that single-type imports such as `import java.util.Map.Entry;` name by their simple names. */
  protected readonly importedTypes = new Map<string, ClassInfo>();
  /** The classes whose static members static imports bring in, with the member's name or `undefined` for `*`. */
  protected readonly staticImports: { cls: ClassInfo; member: string | undefined }[] = [];

  /** Resolves the imports that name classes this environment has, leaving the others for their uses to report. */
  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of import.
  protected resolveImports(imports: readonly ImportDeclaration[]): void {
    for (const declaration of imports) {
      const names =
        declaration.isStatic && !declaration.isWildcard ? declaration.names.slice(0, -1) : declaration.names;
      const cls = this.importedClass(names);
      if (!cls) continue;
      if (declaration.isStatic) {
        this.staticImports.push({ cls, member: declaration.isWildcard ? undefined : declaration.names.at(-1) });
      } else if (declaration.isWildcard) {
        for (const [name, member] of cls.memberTypes) this.importedTypes.set(name, member);
      } else {
        this.importedTypes.set(cls.name, cls);
      }
    }
  }

  /** The class a qualified name such as `java.util.Map.Entry` names, skipping its package. */
  protected importedClass(names: readonly string[]): ClassInfo | undefined {
    const start = names.findIndex((name) => this.classes.has(name) || this.builtins.classes.has(name));
    if (start === -1) return;
    let cls = this.classes.get(names[start]) ?? this.builtins.classes.get(names[start]);
    for (const name of names.slice(start + 1)) cls = cls && this.findMemberType(cls, name);
    return cls;
  }

  /** The static members of `name` that static imports bring in, single imports first. */
  protected staticallyImported<T>(name: string, find: (cls: ClassInfo) => T | undefined): T | undefined {
    for (const isSingle of [true, false]) {
      for (const { cls, member } of this.staticImports) {
        if ((member !== undefined) !== isSingle || (member !== undefined && member !== name)) continue;
        const found = find(cls);
        if (found !== undefined) return found;
      }
    }
    return;
  }

  /** The local classes in scope, innermost block last. */
  protected readonly localTypeScopes: Map<string, ClassInfo>[] = [];

  /**
   * Finds the class that a simple name means inside `scope`: a local class in scope, a member type in scope, then a
   * top-level class.
   */
  protected lookupType(name: string, scope: ClassInfo | undefined): ClassInfo | undefined {
    for (let index = this.localTypeScopes.length - 1; index >= 0; index--) {
      const local = this.localTypeScopes[index].get(name);
      if (local) return local;
    }
    for (let current = scope; current; current = current.enclosing) {
      const member = this.findMemberType(current, name);
      if (member) return member;
    }
    return this.importedTypes.get(name) ?? this.classes.get(name) ?? this.builtins.classes.get(name);
  }

  /** Finds a member type of `cls` or one it inherits from its superclasses and interfaces. */
  protected findMemberType(cls: ClassInfo, name: string): ClassInfo | undefined {
    if (cls.name === name && cls.enclosing === undefined && !cls.isBuiltin) return;
    for (const type of [cls, ...superclassesOf(cls), ...superinterfacesOf(cls)]) {
      const member = type.memberTypes.get(name);
      if (member) return member;
    }
    return;
  }

  protected resolveThrowable(syntax: TypeSyntax): ClassInfo {
    const type = this.resolveType(syntax);
    if (type.kind !== 'class' || !isSubclass(type.cls, this.builtins.throwableClass)) {
      this.error(syntax, `${typeName(type)} は例外クラスではありません。`);
    }
    return type.cls;
  }

  protected withDimensions(type: JavaType, dimensions: number): JavaType {
    let result = type;
    for (let index = 0; index < dimensions; index++) result = { kind: 'array', element: result };
    return result;
  }
}

/** The superclasses of `cls`, nearest first. */
export function superclassesOf(cls: ClassInfo): ClassInfo[] {
  const found: ClassInfo[] = [];
  for (let current = cls.superclass; current; current = current.superclass) found.push(current);
  return found;
}

export function topLevelOf(cls: ClassInfo): ClassInfo {
  let current = cls;
  while (current.enclosing) current = current.enclosing;
  return current;
}
