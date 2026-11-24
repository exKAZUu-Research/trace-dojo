import { enumeratorEntity, enumSpecifierType } from './enums';
import { compileError, unsupported } from './errors';
import type { Expr } from './expr';
import { isSdkMemberDeclared } from './library/libcGlobals';
import type { Library, LibraryTemplate } from './library/registry';
import { type Entity, FunctionContext, Scope } from './scopes';
import { fieldOf, hasToken, type Syntax } from './syntax';
import {
  ClassInfo,
  classType,
  type EnumInfo,
  type GlobalInfo,
  type IntName,
  pointerTo,
  referenceTo,
  type Type,
  typeName,
  VOID,
  withConst,
} from './types';

/** A declarator applied to a type: the declared name and its type. */
export interface Declared {
  name: string | undefined;
  /** The syntax of the name, which may be qualified (`MyTurtle::move`). */
  nameNode: Syntax | undefined;
  type: Type;
  /** The function declarator, for a function's declaration. */
  function?: Syntax;
}

/** The parts of the compiler that every other part uses: messages, scopes, names, and types. */
export abstract class CompilerBase {
  readonly globalScope = new Scope();
  /** The names `using namespace std;` makes visible, in effect after it appears. */
  usesStd = false;
  readonly globals: GlobalInfo[] = [];
  context: FunctionContext = new FunctionContext(undefined, undefined, VOID);
  /** The class whose member declarations are being compiled, whose members are in scope. */
  memberClass: ClassInfo | undefined;

  constructor(protected readonly library: Library) {}

  error(row: number, message: string): never {
    return compileError(row, message);
  }

  protected checkHeaderMacro(name: string, row: number): void {
    if (this.library.isHeaderMacro(name)) this.error(row, `${name} はヘッダーにあるマクロなので名前に使えません。`);
  }

  unsupported(row: number, feature: string): never {
    return unsupported(row, feature);
  }

  // Names ----------------------------------------------------------------------------------------------------------

  /** The class whose members an unqualified name may name: the class of the member function being compiled. */
  get enclosingClass(): ClassInfo | undefined {
    return this.context.cls ?? this.memberClass;
  }

  /** Looks a name up as an unqualified name at the current point, or undefined when nothing declares it. */
  findName(name: string, typeOnly = false): Entity | undefined {
    const local = this.context.lookupLocal(name, typeOnly ? isTypeName : undefined);
    if (local) return local;
    for (let cls = this.enclosingClass; cls; cls = cls.base) {
      const member = this.memberEntity(cls, name);
      if (member && (!typeOnly || isTypeName(member))) return member;
      if (name === cls.name) return { kind: 'class', cls };
    }
    if (typeOnly) {
      const global = this.typeOnlyGlobalName(name);
      if (global) return global;
      const candidate = this.hasUsingStd ? this.findStdName(name) : undefined;
      return candidate && isTypeName(candidate) ? candidate : undefined;
    }
    return this.findGlobalName(name);
  }

  private get hasUsingStd(): boolean {
    return this.usesStd || this.context.scopes.some((scope) => scope.usesStd);
  }

  /** Looks a name up in the global namespace, including the names `using` brought in. */
  findGlobalName(name: string): Entity | undefined {
    const found = this.ordinaryGlobalName(name);
    const own = found === this.globalScope.names.get(name) ? found : undefined;
    const usesStd = this.hasUsingStd;
    if (own && usesStd && this.library.conflictsWithStdName(name, own.kind === 'functions')) {
      return { kind: 'ambiguous', name };
    }
    const std = usesStd ? this.findStdName(name) : undefined;
    if (found && std && found !== std) {
      if (found.kind === 'functions' && std.kind === 'functions') {
        return { kind: 'functions', functions: [...new Set([...found.functions, ...std.functions])] };
      }
      if (own && std.kind !== 'unsupported' && !(found.kind === 'class' && std.kind === 'class')) {
        return { kind: 'ambiguous', name };
      }
    }
    return found ?? std;
  }

  private ordinaryGlobalName(name: string): Entity | undefined {
    const own = this.globalScope.names.get(name);
    const library = this.library.global(name);
    if (own?.kind === 'class' && this.library.hasGlobalDeclaration(name)) {
      return library ?? { kind: 'hiddenClass', cls: own.cls };
    }
    if (own?.kind === 'functions' && library?.kind === 'functions' && this.library.hasGlobalDeclaration(name)) {
      return { kind: 'functions', functions: this.library.mergeCOverloads(name, library.functions, own.functions) };
    }
    return own ?? library;
  }

  private typeOnlyGlobalName(name: string): Entity | undefined {
    const own = this.globalScope.names.get(name);
    if (own && isTypeName(own)) return own;
    const library = this.library.global(name);
    return library && isTypeName(library) ? library : undefined;
  }

  protected findStdName(name: string): Entity | undefined {
    const std = this.library.std(name);
    const local = this.globalScope.names.get(name);
    if (std?.kind === 'functions' && local?.kind === 'functions') {
      return { kind: 'functions', functions: this.library.rebindCOverloads(name, std.functions, local.functions) };
    }
    return std;
  }

  lookupName(name: string, row: number, typeOnly = false): Entity {
    const entity = this.findName(name, typeOnly);
    if (!entity) {
      this.checkUnimplementedSdkName(name, row, 'global');
      if (this.hasUsingStd) this.checkUnimplementedSdkName(name, row, 'std');
      const header = this.library.missingHeader(name);
      if (header)
        return this.error(row, `${name} は宣言されていません（使うには #include <${header}> を書いてください）。`);
      return this.error(row, `${name} は宣言されていません。`);
    }
    if (entity.kind === 'ambiguous') {
      return this.error(row, `${name} が、自分で宣言したものと std::${name} のどちらを指すのか決まりません。`);
    }
    if (entity.kind === 'unsupported') return this.unsupported(row, entity.feature);
    return entity;
  }

  private checkUnimplementedSdkName(name: string, row: number, scope: 'global' | 'std'): void {
    const feature = this.library.unimplementedSdkName(name, scope);
    if (feature) this.unsupported(row, feature);
  }

  /** The member named `name` that a class itself declares, as an entity. */
  memberEntity(cls: ClassInfo, name: string): Entity | undefined {
    const field = cls.ownFields.find((candidate) => candidate.name === name);
    if (field) return { kind: 'field', field };
    const methods = cls.methods.get(name);
    if (methods) return { kind: 'functions', functions: methods };
    const staticField = cls.staticFields.get(name);
    if (staticField) return { kind: 'staticField', field: staticField };
    const memberType = cls.memberTypes.get(name);
    if (memberType) return { kind: 'type', type: memberType };
    const constant = cls.constants.get(name);
    if (constant) return { kind: 'value', make: constant };
  }

  /** Looks up `scope::name` for a qualified identifier, its scope being a namespace or a class. */
  lookupQualified(node: Syntax, typeOnly = false): Entity {
    const scopeNode = fieldOf(node, 'scope');
    const nameNode = fieldOf(node, 'name') as Syntax;
    if (!scopeNode) return this.lookupInGlobal(nameNode, typeOnly);
    const scope = this.resolveScope(scopeNode);
    if (scope.kind === 'namespace') return this.lookupInNamespace(nameNode, node.row);
    if (scope.kind === 'enum') {
      const enumerator = enumeratorEntity(scope.info, nameNode.text);
      return (
        enumerator ?? this.error(node.row, `列挙 ${scope.info.name} に ${nameNode.text} という列挙子はありません。`)
      );
    }
    return this.lookupInClass(scope.cls, nameNode, node.row);
  }

  private lookupInGlobal(nameNode: Syntax, typeOnly: boolean): Entity {
    const name = this.plainName(nameNode);
    const entity = typeOnly ? this.typeOnlyGlobalName(name) : this.ordinaryGlobalName(name);
    if (!entity) {
      this.checkUnimplementedSdkName(name, nameNode.row, 'global');
      return this.error(nameNode.row, `::${name} は宣言されていません。`);
    }
    return entity;
  }

  private lookupInNamespace(nameNode: Syntax, row: number): Entity {
    if (nameNode.type === 'qualified_identifier') {
      // `std::string::npos` and `std::numeric_limits<int>::max`: a member of a class of std.
      const scope = fieldOf(nameNode, 'scope') as Syntax;
      const scopeName = scope.type === 'template_type' ? (fieldOf(scope, 'name') as Syntax) : scope;
      const entity = this.lookupInNamespace(scopeName, row);
      let type: Type | undefined;
      if (entity.kind === 'class') type = classType(entity.cls);
      else if (entity.kind === 'type') type = entity.type;
      else if (entity.kind === 'template' && scope.type === 'template_type') {
        type = this.instantiateTemplate(entity.template, fieldOf(scope, 'arguments') as Syntax, row);
      }
      if (type?.kind !== 'class') return this.unsupported(row, '入れ子の名前空間');
      return this.lookupInClass(type.cls, fieldOf(nameNode, 'name') as Syntax, row);
    }
    const name = this.plainName(nameNode);
    const entity = this.findStdName(name);
    if (!entity) {
      this.checkUnimplementedSdkName(name, row, 'std');
      const header = this.library.missingHeader(name);
      if (header) return this.error(row, `std::${name} を使うには #include <${header}> を書いてください。`);
      return this.error(row, `std::${name} はありません（または、この採点環境にはありません）。`);
    }
    if (entity.kind === 'unsupported') return this.unsupported(row, entity.feature);
    return entity;
  }

  private lookupInClass(cls: ClassInfo, nameNode: Syntax, row: number): Entity {
    if (!cls.isComplete && cls.library) return this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
    this.checkLibraryLayout(classType(cls), row);
    if (nameNode.type === 'qualified_identifier') {
      const inner = this.lookupInClass(cls, fieldOf(nameNode, 'scope') as Syntax, row);
      if (inner.kind !== 'class' && !(inner.kind === 'type' && inner.type.kind === 'class')) {
        return this.error(row, `${nameNode.text} はクラスの中にありません。`);
      }
      const innerClass = inner.kind === 'class' ? inner.cls : (inner.type as Extract<Type, { kind: 'class' }>).cls;
      return this.lookupInClass(innerClass, fieldOf(nameNode, 'name') as Syntax, row);
    }
    const name =
      nameNode.type === 'destructor_name' ? `~${this.plainName(nameNode.children[0])}` : this.plainName(nameNode);
    for (let current: ClassInfo | undefined = cls; current; current = current.base) {
      const member = this.memberEntity(current, name);
      if (member) return member;
    }
    if (name === cls.name || name === cls.name.replace(/^std::/, '')) return { kind: 'class', cls };
    return this.missingMember(cls, name, row);
  }

  protected missingMember(cls: ClassInfo, name: string, row: number): never {
    if (isSdkMemberDeclared(cls, name)) this.unsupported(row, `${cls.name}::${name}`);
    return this.error(row, `${cls.name} に ${name} というメンバはありません。`);
  }

  protected checkLibraryLayout(type: Type, row: number, isElement = false): void {
    while (type.kind === 'array') type = type.of;
    if (type.kind !== 'class') return;
    if (isElement) this.requireConcreteElement(type.cls, row);
    const library = type.cls.library;
    if (library?.aggregateArray) this.checkLibraryLayout(library.aggregateArray.type.of, row, true);
    if (library?.layoutFromFields)
      for (const { type: field } of type.cls.ownFields) this.checkLibraryLayout(field, row, true);
  }

  protected requireConcreteElement(cls: ClassInfo, row: number): void {
    if (!cls.isComplete) this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
    if (cls.isAbstract)
      this.error(row, `${cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、要素として格納できません。`);
  }

  /** The namespace or class a qualified name's scope names. */
  resolveScope(
    node: Syntax
  ): { kind: 'namespace' } | { kind: 'class'; cls: ClassInfo } | { kind: 'enum'; info: EnumInfo } {
    if (node.type === 'namespace_identifier' && node.text === 'std') return { kind: 'namespace' };
    if (node.type === 'namespace_identifier' || node.type === 'type_identifier' || node.type === 'identifier') {
      const entity = this.findName(node.text, true);
      if (entity?.kind === 'class') return { kind: 'class', cls: entity.cls };
      if (entity?.kind === 'type' && entity.type.kind === 'class') return { kind: 'class', cls: entity.type.cls };
      if (entity?.kind === 'type' && entity.type.kind === 'int' && entity.type.enumeration)
        return { kind: 'enum', info: entity.type.enumeration };
      if (!entity) {
        this.checkUnimplementedSdkName(node.text, node.row, 'global');
        if (this.hasUsingStd) this.checkUnimplementedSdkName(node.text, node.row, 'std');
        return this.error(node.row, `${node.text} は宣言されていません。`);
      }
      return this.error(node.row, `${node.text} はクラスでも名前空間でもありません。`);
    }
    const type = this.resolveTypeSpecifier(node, false, true);
    if (type.kind === 'class') return { kind: 'class', cls: type.cls };
    return this.error(node.row, `${node.text} はクラスでも名前空間でもありません。`);
  }

  plainName(node: Syntax): string {
    if (node.type === 'operator_name') return this.unsupported(node.row, '演算子のオーバーロード（operator）');
    if (node.type === 'template_function' || node.type === 'template_type') {
      return (fieldOf(node, 'name') as Syntax).text;
    }
    return node.text;
  }

  /** What a name declared in the innermost scope (a block, a class, or the global scope) denotes, if anything. */
  findDeclaredHere(name: string): Entity | undefined {
    if (this.context.fn) return this.context.scope.names.get(name);
    if (this.memberClass) return this.memberEntity(this.memberClass, name);
    return this.globalScope.names.get(name);
  }

  /** Declares a type or a constant in the innermost scope: a block, a class, or the global scope. */
  declareHere(name: string, entity: Entity, row: number): void {
    this.checkHeaderMacro(name, row);
    if (this.findDeclaredHere(name)) this.error(row, `${name} はすでに宣言されています。`);
    if (this.context.fn) {
      this.context.scope.names.set(name, entity);
      return;
    }
    const cls = this.memberClass;
    if (cls) {
      if (entity.kind === 'type') cls.memberTypes.set(name, entity.type);
      else if (entity.kind === 'class') cls.memberTypes.set(name, classType(entity.cls));
      else if (entity.kind === 'value') cls.constants.set(name, entity.make);
      else this.error(row, `${name} はクラスの中では宣言できません。`);
      return;
    }
    this.globalScope.names.set(name, entity);
  }

  /** Runs `compile` with a scope of names it declares, which only it sees. */
  withNames(compile: (declare: (name: string, entity: Entity) => void) => void): void {
    const scope = new Scope();
    this.context.scopes.push(scope);
    try {
      compile((name, entity) => scope.names.set(name, entity));
    } finally {
      this.context.scopes.pop();
    }
  }

  // Types ----------------------------------------------------------------------------------------------------------

  /** The type a declaration's specifiers name: its type specifier and its `const`. */
  specifiedType(declaration: Syntax, allowAuto = false): Type {
    const typeNode = fieldOf(declaration, 'type');
    if (!typeNode) return this.error(declaration.row, '型を書いてください。');
    const type = this.resolveTypeSpecifier(typeNode, allowAuto);
    const isConst =
      this.hasSpecifier(declaration, 'const') ||
      this.isConstexpr(declaration) ||
      (typeNode.type === 'sized_type_specifier' && this.hasSpecifier(typeNode, 'const'));
    return isConst ? withConst(type) : type;
  }

  protected isConstexpr(declaration: Syntax): boolean {
    const type = fieldOf(declaration, 'type');
    return (
      this.hasSpecifier(declaration, 'constexpr') ||
      (type?.type === 'sized_type_specifier' && this.hasSpecifier(type, 'constexpr'))
    );
  }

  /** Whether a declaration's specifiers include a word, such as `static` or `virtual`. */
  hasSpecifier(declaration: Syntax, word: string): boolean {
    return declaration.all.some(
      (child) =>
        (child.type === 'storage_class_specifier' || child.type === 'type_qualifier' || child.type === word) &&
        child.text === word
    );
  }

  resolveTypeSpecifier(node: Syntax, allowAuto = false, typeOnly = false): Type {
    switch (node.type) {
      case 'primitive_type': {
        if (WIDE_CHARACTER_TYPES.has(node.text)) return this.unsupported(node.row, `ワイド文字の型（${node.text}）`);
        return primitiveType(node.text) ?? this.typeOfEntity(this.lookupName(node.text, node.row), node);
      }
      case 'sized_type_specifier': {
        return this.sizedType(node);
      }
      case 'placeholder_type_specifier': {
        if (fieldOf(node, 'constraint')) return this.unsupported(node.row, 'コンセプトで制約した auto');
        if (node.children.some((child) => child.type === 'decltype')) return this.unsupported(node.row, 'decltype');
        if (!allowAuto) return this.error(node.row, 'auto は、この場所では型として使えません。');
        return AUTO;
      }
      case 'type_identifier':
      case 'identifier':
      case 'namespace_identifier': {
        return this.typeOfEntity(this.lookupName(node.text, node.row, typeOnly), node);
      }
      case 'qualified_identifier': {
        return this.typeOfEntity(this.lookupQualified(node, typeOnly), node);
      }
      case 'template_type': {
        return this.templateType(node, this.lookupName((fieldOf(node, 'name') as Syntax).text, node.row, typeOnly));
      }
      case 'class_specifier':
      case 'struct_specifier': {
        return this.classSpecifierType(node);
      }
      case 'enum_specifier': {
        return enumSpecifierType(this, node);
      }
      case 'type_descriptor': {
        return this.typeDescriptor(node);
      }
      default: {
        return this.error(node.row, `${node.text} は型として使えません。`);
      }
    }
  }

  /** Compiles a class definition or names a declared class, for a class specifier in a declaration. */
  protected abstract classSpecifierType(node: Syntax): Type;

  /** The type a name denotes; `node` is the name's syntax, which may carry template arguments. */
  typeOfEntity(entity: Entity, node: Syntax): Type {
    const nameNode = node.type === 'qualified_identifier' ? (fieldOf(node, 'name') as Syntax) : node;
    if (nameNode.type === 'template_type') return this.templateType(nameNode, entity);
    switch (entity.kind) {
      case 'hiddenClass': {
        return this.error(node.row, `型 ${entity.cls.name} には class または struct を付けてください。`);
      }
      case 'class': {
        return classType(entity.cls);
      }
      case 'type': {
        return entity.type;
      }
      case 'template': {
        return this.error(node.row, `${entity.template.name} には <...> でテンプレート引数を書いてください。`);
      }
      default: {
        return this.error(node.row, `${node.text} は型ではありません。`);
      }
    }
  }

  private templateType(node: Syntax, entity: Entity): Type {
    if (entity.kind !== 'template') return this.error(node.row, `${node.text} はテンプレートではありません。`);
    return this.instantiateTemplate(entity.template, fieldOf(node, 'arguments') as Syntax, node.row);
  }

  protected instantiateTemplate(template: LibraryTemplate, list: Syntax, row: number): Type {
    if (!template.takesArrayBound)
      return this.library.trackDefinition(template.name, template.instantiate(this.templateArguments(list), row));
    const args = list.children;
    if (args.length !== 2) return this.error(row, `std::${template.name} のテンプレート引数は 2 個です。`);
    const [element, bound] = args;
    const expression =
      bound.type === 'type_descriptor' && !fieldOf(bound, 'declarator') ? (fieldOf(bound, 'type') ?? bound) : bound;
    return this.library.trackDefinition(
      template.name,
      template.instantiate(this.templateTypeArgument(element), this.arrayLength(expression))
    );
  }

  protected templateArguments(list: Syntax): Type[] {
    return list.children.map((argument) => this.templateTypeArgument(argument));
  }

  private templateTypeArgument(argument: Syntax): Type {
    if (argument.type === 'type_descriptor') return this.typeDescriptor(argument);
    return this.expressionAsType(argument) ?? this.error(argument.row, 'テンプレート引数には型を書いてください。');
  }

  /** The type an expression-shaped template argument names, or undefined when it names no type. */
  protected expressionAsType(node: Syntax): Type | undefined {
    if (node.type === 'identifier' || node.type === 'type_identifier') {
      const entity = this.findName(node.text);
      if (entity?.kind === 'class') return classType(entity.cls);
      return entity?.kind === 'type' ? entity.type : undefined;
    }
    if (node.type === 'template_function') {
      const nameNode = fieldOf(node, 'name') as Syntax;
      const entity =
        nameNode.type === 'qualified_identifier' ? this.lookupQualified(nameNode) : this.findName(nameNode.text);
      if (entity?.kind !== 'template') return undefined;
      return this.instantiateTemplate(entity.template, fieldOf(node, 'arguments') as Syntax, node.row);
    }
    if (node.type !== 'qualified_identifier') return undefined;
    const name = fieldOf(node, 'name') as Syntax;
    if (name.type === 'template_function') {
      const entity = this.lookupQualified({
        ...node,
        all: node.all.map((child) => (child === name ? (fieldOf(name, 'name') as Syntax) : child)),
      });
      if (entity.kind !== 'template') return undefined;
      return this.instantiateTemplate(entity.template, fieldOf(name, 'arguments') as Syntax, node.row);
    }
    const entity = this.lookupQualified(node);
    if (entity.kind === 'class') return classType(entity.cls);
    return entity.kind === 'type' ? entity.type : undefined;
  }

  typeDescriptor(node: Syntax): Type {
    const base = this.specifiedType(node);
    const declarator = fieldOf(node, 'declarator');
    if (!declarator) return base;
    return this.applyDeclarator(base, declarator).type;
  }

  private sizedType(node: Syntax): Type {
    // The grammar gives the specifier of a functional cast (`short(1)`) as one token without children.
    const words =
      node.all.length === 0
        ? node.text.split(/\s+/)
        : node.all.filter((child) => !child.isNamed).map((child) => child.type);
    const inner = fieldOf(node, 'type');
    if (inner) {
      if (inner.type !== 'primitive_type') return this.error(node.row, `${node.text} という型はありません。`);
      words.push(inner.text);
    }
    return sizedIntType(words) ?? this.error(node.row, `${node.text} という型はありません。`);
  }

  /**
   * Applies a declarator to the type of a declaration's specifiers, from the outside in, as C++ reads declarators:
   * `int *a[3]` declares an array of three pointers.
   */
  applyDeclarator(base: Type, declarator: Syntax): Declared {
    switch (declarator.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
      case 'qualified_identifier':
      case 'destructor_name':
      case 'operator_name':
      case 'template_function': {
        if (declarator.type === 'operator_name')
          return this.unsupported(declarator.row, '演算子のオーバーロード（operator）');
        const name = this.declaredName(declarator);
        if (name !== undefined) this.checkHeaderMacro(name.split('::').at(-1) ?? name, declarator.row);
        return { name, nameNode: declarator, type: base };
      }
      case 'pointer_declarator':
      case 'abstract_pointer_declarator': {
        const isConst = declarator.children.some((child) => child.type === 'type_qualifier' && child.text === 'const');
        if (base.kind === 'reference') return this.error(declarator.row, '参照へのポインタは作れません。');
        return this.applyInner(pointerTo(base, isConst), declarator);
      }
      case 'reference_declarator':
      case 'abstract_reference_declarator': {
        if (hasToken(declarator, '&&')) return this.unsupported(declarator.row, '右辺値参照（&&）');
        if (base.kind === 'reference') return this.error(declarator.row, '参照への参照は作れません。');
        if (base.kind === 'void') return this.error(declarator.row, 'void への参照は作れません。');
        return this.applyInner(referenceTo(base), declarator);
      }
      case 'array_declarator':
      case 'abstract_array_declarator': {
        if (base.kind === 'reference') return this.error(declarator.row, '参照の配列は作れません。');
        if (base.kind === 'void') return this.error(declarator.row, 'void の配列は作れません。');
        if (base.kind === 'array' && base.length === undefined)
          return this.error(declarator.row, '多次元配列の内側の大きさを書いてください。');
        if (hasAuto(base)) return this.error(declarator.row, '配列の要素の型を auto で書くことはできません。');
        const size = fieldOf(declarator, 'size');
        const length = size ? this.arrayLength(size) : undefined;
        return this.applyInner({ kind: 'array', of: base, length }, declarator);
      }
      case 'function_declarator': {
        const inner = fieldOf(declarator, 'declarator');
        const declared = inner
          ? this.applyDeclarator(base, inner)
          : { name: undefined, nameNode: undefined, type: base };
        return { ...declared, function: declarator };
      }
      case 'init_declarator': {
        return this.applyDeclarator(base, fieldOf(declarator, 'declarator') as Syntax);
      }
      default: {
        return this.error(declarator.row, `${declarator.text} は、この書き方では宣言できません。`);
      }
    }
  }

  private applyInner(type: Type, declarator: Syntax): Declared {
    const inner =
      fieldOf(declarator, 'declarator') ??
      declarator.children.find((child) => child.type !== 'type_qualifier' && child.field !== 'size');
    if (!inner) return { name: undefined, nameNode: undefined, type };
    return this.applyDeclarator(type, inner);
  }

  private declaredName(node: Syntax): string {
    if (node.type === 'qualified_identifier') return this.declaredName(fieldOf(node, 'name') as Syntax);
    if (node.type === 'destructor_name') return `~${node.children[0]?.text ?? ''}`;
    if (node.type === 'template_function') return this.unsupported(node.row, 'テンプレートの特殊化');
    return node.text;
  }

  /** The length of an array, which must be a constant expression. */
  protected abstract arrayLength(size: Syntax): number;

  /** Compiles an expression of the program, for the parts of the base that evaluate constants. */
  abstract compileExpression(node: Syntax): Expr;

  /** The prvalue of an expression. */
  abstract rvalue(expr: Expr): Expr;

  describeType(type: Type): string {
    return typeName(type);
  }
}

/** The type that `auto` stands for until an initializer decides it. */
export const AUTO: Extract<Type, { kind: 'class' }> = classType(new ClassInfo('auto', 'class'));

export function isAuto(type: Type): boolean {
  return type.kind === 'class' && type.cls === AUTO.cls;
}

function isTypeName(entity: Entity): boolean {
  return entity.kind === 'class' || entity.kind === 'type' || entity.kind === 'template' || entity.kind === 'namespace';
}

export function hasAuto(type: Type): boolean {
  if (type.kind === 'pointer' || type.kind === 'reference') return hasAuto(type.to);
  return isAuto(type);
}

const WIDE_CHARACTER_TYPES = new Set(['wchar_t', 'char8_t', 'char16_t', 'char32_t']);

const PRIMITIVE_TYPES: Record<string, Type> = {
  void: VOID,
  bool: { kind: 'int', name: 'bool' },
  char: { kind: 'int', name: 'char' },
  int: { kind: 'int', name: 'int' },
  short: { kind: 'int', name: 'short' },
  long: { kind: 'int', name: 'long' },
  unsigned: { kind: 'int', name: 'uint' },
  signed: { kind: 'int', name: 'int' },
  float: { kind: 'float', name: 'float' },
  double: { kind: 'float', name: 'double' },
};

function primitiveType(text: string): Type | undefined {
  return PRIMITIVE_TYPES[text];
}

/** The integer type that a combination of `signed`, `unsigned`, `short`, `long`, `char`, `int`, `double` names. */
function sizedIntType(words: string[]): Type | undefined {
  const count = (word: string): number => words.filter((candidate) => candidate === word).length;
  const isUnsigned = count('unsigned') > 0;
  const isSigned = count('signed') > 0;
  const longs = count('long');
  const shorts = count('short');
  if (isUnsigned && isSigned) return;
  if (count('double') > 0)
    return longs === 1 && !isUnsigned && !isSigned && shorts === 0 ? { kind: 'float', name: 'ldouble' } : undefined;
  if (count('char') > 0) {
    if (longs > 0 || shorts > 0) return;
    if (isUnsigned) return { kind: 'int', name: 'uchar' };
    return { kind: 'int', name: isSigned ? 'schar' : 'char' };
  }
  const others = words.filter((word) => !['unsigned', 'signed', 'long', 'short', 'int'].includes(word));
  if (others.length > 0 || count('int') > 1 || longs > 2 || (shorts > 0 && longs > 0) || shorts > 1) return;
  let name: IntName = 'int';
  if (shorts === 1) name = 'short';
  if (longs === 1) name = 'long';
  if (longs === 2) name = 'llong';
  if (isUnsigned) name = unsignedName(name);
  return { kind: 'int', name };
}

function unsignedName(name: IntName): IntName {
  const names: Partial<Record<IntName, IntName>> = { short: 'ushort', int: 'uint', long: 'ulong', llong: 'ullong' };
  return names[name] ?? name;
}
