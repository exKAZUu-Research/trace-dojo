import { compileError, unsupported } from './errors';
import type { Expr } from './expr';
import type { Library, LibraryTemplate } from './library/registry';
import { type Entity, FunctionContext, Scope } from './scopes';
import { fieldOf, hasToken, type Syntax } from './syntax';
import {
  ClassInfo,
  classType,
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
  findName(name: string): Entity | undefined {
    const local = this.context.lookupLocal(name);
    if (local) return local;
    for (let cls = this.enclosingClass; cls; cls = cls.base) {
      const member = this.memberEntity(cls, name);
      if (member) return member;
    }
    return this.findGlobalName(name);
  }

  /** Looks a name up in the global namespace, including the names `using` brought in. */
  findGlobalName(name: string): Entity | undefined {
    const own = this.globalScope.names.get(name);
    const library = this.library.global(name);
    const std = this.usesStd || this.context.scopes.some((scope) => scope.usesStd) ? this.library.std(name) : undefined;
    const found = own ?? library;
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

  lookupName(name: string, row: number): Entity {
    const entity = this.findName(name);
    if (!entity) {
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
  lookupQualified(node: Syntax): Entity {
    const scopeNode = fieldOf(node, 'scope');
    const nameNode = fieldOf(node, 'name') as Syntax;
    if (!scopeNode) return this.lookupInGlobal(nameNode);
    const scope = this.resolveScope(scopeNode);
    if (scope.kind === 'namespace') return this.lookupInNamespace(nameNode, node.row);
    return this.lookupInClass(scope.cls, nameNode, node.row);
  }

  private lookupInGlobal(nameNode: Syntax): Entity {
    const name = this.plainName(nameNode);
    const entity = this.globalScope.names.get(name) ?? this.library.global(name);
    if (!entity) return this.error(nameNode.row, `::${name} は宣言されていません。`);
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
    const entity = this.library.std(name);
    if (!entity) {
      const header = this.library.missingHeader(name);
      if (header) return this.error(row, `std::${name} を使うには #include <${header}> を書いてください。`);
      return this.error(row, `std::${name} はありません（または、この採点環境にはありません）。`);
    }
    if (entity.kind === 'unsupported') return this.unsupported(row, entity.feature);
    return entity;
  }

  private lookupInClass(cls: ClassInfo, nameNode: Syntax, row: number): Entity {
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
    return this.error(row, `${cls.name} に ${name} というメンバはありません。`);
  }

  /** The namespace or class a qualified name's scope names. */
  resolveScope(node: Syntax): { kind: 'namespace' } | { kind: 'class'; cls: ClassInfo } {
    if (node.type === 'namespace_identifier' && node.text === 'std') return { kind: 'namespace' };
    if (node.type === 'namespace_identifier' || node.type === 'type_identifier' || node.type === 'identifier') {
      const entity = this.findName(node.text);
      if (entity?.kind === 'class') return { kind: 'class', cls: entity.cls };
      if (entity?.kind === 'type' && entity.type.kind === 'class') return { kind: 'class', cls: entity.type.cls };
      if (!entity) return this.error(node.row, `${node.text} は宣言されていません。`);
      return this.error(node.row, `${node.text} はクラスでも名前空間でもありません。`);
    }
    const type = this.resolveTypeSpecifier(node);
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

  resolveTypeSpecifier(node: Syntax, allowAuto = false): Type {
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
        return this.typeOfEntity(this.lookupName(node.text, node.row), node);
      }
      case 'qualified_identifier': {
        return this.typeOfEntity(this.lookupQualified(node), node);
      }
      case 'template_type': {
        return this.templateType(node, this.lookupName((fieldOf(node, 'name') as Syntax).text, node.row));
      }
      case 'class_specifier':
      case 'struct_specifier': {
        return this.classSpecifierType(node);
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
    if (!template.takesArrayBound) return template.instantiate(this.templateArguments(list), row);
    const args = list.children.filter((arg) => arg.type !== 'comment');
    if (args.length !== 2) return this.error(row, `std::${template.name} のテンプレート引数は 2 個です。`);
    const [element, bound] = args;
    const expression =
      bound.type === 'type_descriptor' && !fieldOf(bound, 'declarator') ? (fieldOf(bound, 'type') ?? bound) : bound;
    return template.instantiate(this.templateTypeArgument(element), this.arrayLength(expression));
  }

  protected templateArguments(list: Syntax): Type[] {
    return list.children.filter((arg) => arg.type !== 'comment').map((argument) => this.templateTypeArgument(argument));
  }

  private templateTypeArgument(argument: Syntax): Type {
    if (argument.type === 'type_descriptor') return this.typeDescriptor(argument);
    return this.expressionAsType(argument) ?? this.error(argument.row, 'テンプレート引数には型を書いてください。');
  }

  /** The type an expression-shaped template argument names, or undefined when it names no type. */
  private expressionAsType(node: Syntax): Type | undefined {
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

  describeType(type: Type): string {
    return typeName(type);
  }
}

/** The type that `auto` stands for until an initializer decides it. */
export const AUTO: Extract<Type, { kind: 'class' }> = classType(new ClassInfo('auto', 'class'));

export function isAuto(type: Type): boolean {
  return type.kind === 'class' && type.cls === AUTO.cls;
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
