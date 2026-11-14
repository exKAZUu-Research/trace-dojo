// code-gauge-allow-file fileNcss 833 -- C syntax conversion shares scoped names and tree-sitter recovery.
import type { Node, Parser } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type { ExecutionBudget } from '../interpreter/limits';
import { parseSource } from '../interpreter/treeSitter';
import {
  type BinaryOperator,
  type Compound,
  type Declaration,
  type Declarator,
  type Designator,
  type Enumerator,
  type Expression,
  type ExternalDeclaration,
  type FieldDeclaration,
  type Initializer,
  NO_QUALIFIERS,
  type Parameter,
  type Specifiers,
  type Statement,
  type StaticAssert,
  type StorageClass,
  type TypeName,
  type TypeSpecifier,
} from './ast';
import { validateDeclarationChildren, validateDeclaratorChildren } from './declarationSyntax';
import { checkAttributes } from './preprocessor';
import { CSyntaxError } from './syntaxDiagnostics';
import type { TypeScope } from './syntaxTokens';
import { builtinType } from './types';
import { unsupported } from './unsupported';
import { declarationTypeNodes, validateNames, validateSyntax } from './validateSyntax';

/** What learners call the syntax that the converter leaves out, by tree-sitter's node type. */
const UNSUPPORTED_NODES: Record<string, string> = {
  generic_expression: '_Generic',
  atomic_type_specifier: '_Atomic',
  bit_int_specifier: '_BitInt',
  macro_type_specifier: 'マクロを型として使う書き方',
  gnu_asm_expression: 'インラインアセンブリ（asm）',
  builtin_available_expression: '__builtin_available',
  seh_try_statement: '__try',
  seh_leave_statement: '__leave',
  ms_declspec_modifier: '__declspec',
  ms_based_modifier: '__based',
  ms_call_modifier: '呼び出し規約の指定',
  ms_pointer_modifier: 'ポインタの修飾（__ptr32 など）',
  ms_unaligned_ptr_modifier: '__unaligned',
};

/** Names a statement that clang reads as an undeclared identifier in C17, as these keywords are not C17's. */
const NOT_C17_KEYWORDS: Record<string, string> = {
  defer_statement: 'defer',
  countof_expression: '_Countof',
  null: 'nullptr',
};

/** The words that may form a builtin type, in the order C's grammar allows any of. */
const BUILTIN_WORDS = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  '_Bool',
  '_Complex',
]);

/** A scope of ordinary identifiers, telling which name typedef names, as C's grammar needs to parse declarations. */
class NameScope {
  private readonly names = new Map<string, 'type' | 'value'>();

  constructor(private readonly parent?: NameScope) {}

  typeNames(budget: ExecutionBudget): ReadonlySet<string> {
    const inherited = this.parent?.typeNames(budget);
    budget.spend((inherited?.size ?? 0) + this.names.size);
    const names = new Set(inherited);
    for (const [name, kind] of this.names) {
      if (kind === 'type') names.add(name);
      else names.delete(name);
    }
    return names;
  }

  kindOf(name: string): 'type' | 'value' | undefined {
    return this.names.get(name) ?? this.parent?.kindOf(name);
  }

  isType(name: string): boolean {
    return this.kindOf(name) === 'type';
  }

  declare(name: string, kind: 'type' | 'value'): void {
    this.names.set(name, kind);
  }
}

/** A standard header's declarations, which become visible at the row of its `#include`. */
export interface HeaderDeclarations {
  row: number;
  name: string;
  items: Declaration[];
  typedefNames: string[];
}

/** Converts tree-sitter's tree of a translation unit into the interpreter's syntax tree. */
export class Converter {
  readonly typeScopes: TypeScope[] = [];
  readonly valueTypeRanges = new Map<number, number>();
  private readonly recoveredCasts = new WeakSet<Expression>();
  private scope: NameScope;
  private headers: readonly HeaderDeclarations[] = [];
  private nextHeader = 0;

  constructor(
    builtinTypedefs: readonly string[],
    private readonly parser: Parser,
    private readonly fromHeader?: string,
    private readonly recovery?: ExecutionBudget
  ) {
    this.scope = new NameScope();
    for (const name of builtinTypedefs) this.scope.declare(name, 'type');
  }

  convertUnit(root: Node, headers: readonly HeaderDeclarations[] = []): ExternalDeclaration[] {
    if (!this.recovery) validateSyntax(root, (node) => this.checkUnsupported(node));
    const items: ExternalDeclaration[] = [];
    this.headers = headers;
    this.nextHeader = 0;
    for (const child of namedChildren(root)) {
      if (child.type === 'comment') continue;
      items.push(...this.headersBefore(child.startPosition.row));
      items.push(...this.externalDeclaration(child));
    }
    items.push(...this.headersBefore(Number.POSITIVE_INFINITY));
    if (!this.recovery) validateNames({ items });
    return items;
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- Header cursor, lexical names, and declarations must advance together in source order.
  private headersBefore(row: number, inBlock = false): Declaration[] {
    const declarations: Declaration[] = [];
    while (this.nextHeader < this.headers.length && this.headers[this.nextHeader].row <= row) {
      const header = this.headers[this.nextHeader++];
      if (inBlock && ['stdio.h', 'stdlib.h', 'ctype.h', 'math.h'].includes(header.name))
        throw new CompileError([{ row: header.row, message: `<${header.name}> は関数の外で読み込んでください。` }]);
      for (const name of header.typedefNames) this.scope.declare(name, 'type');
      for (const item of header.items) {
        for (const declarator of item.declarators) {
          const name = declaredName(declarator.declarator);
          if (name) this.scope.declare(name, item.specifiers.storage === 'typedef' ? 'type' : 'value');
        }
        declarations.push(item);
      }
    }
    return declarations;
  }

  private externalDeclaration(node: Node): ExternalDeclaration[] {
    if (this.recovery && node.isError) this.scanValueTypes(node);
    switch (node.type) {
      case 'function_definition': {
        return [this.functionDefinition(node)];
      }
      case 'declaration':
      case 'type_definition': {
        return [this.declaration(node)];
      }
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier': {
        const type = this.typeSpecifier(node);
        return [
          {
            kind: 'declaration',
            specifiers: { row: node.startPosition.row, qualifiers: NO_QUALIFIERS, type },
            declarators: [],
            row: node.startPosition.row,
          },
        ];
      }
      case 'expression_statement': {
        if (node.namedChildCount === 0) return [];
        const staticAssert = this.staticAssert(node);
        if (staticAssert) return [staticAssert];
        const declaration = this.reparseDeclaration(node);
        if (declaration) return [declaration];
        break;
      }
      case 'attributed_statement': {
        // A file-scope attribute declaration, such as `[[maybe_unused]];`, declares nothing.
        return namedChildren(node).flatMap((child) =>
          child.type === 'attribute_declaration' ? [] : this.externalDeclaration(child)
        );
      }
    }
    this.checkUnsupported(node);
    throw new CompileError([
      { row: node.startPosition.row, message: '関数の外には、宣言と関数の定義だけを書けます。' },
    ]);
  }

  /** `_Static_assert(condition, "message")`, which tree-sitter parses as a call. */
  private staticAssert(node: Node): StaticAssert | undefined {
    const call = namedChildren(node).find((child) => child.type !== 'comment');
    const callee = call?.childForFieldName('function');
    if (call?.type !== 'call_expression' || (callee?.text !== '_Static_assert' && callee?.text !== 'static_assert'))
      return undefined;
    const row = node.startPosition.row;
    const [condition, message, ...rest] = namedChildren(field(call, 'arguments')).filter(
      (child) => child.type !== 'comment'
    );
    if (
      !condition ||
      rest.length > 0 ||
      (message && message.type !== 'string_literal' && message.type !== 'concatenated_string')
    ) {
      throw new CompileError([{ row, message: '_Static_assert には、条件と文字列リテラルを書いてください。' }]);
    }
    const parts = message
      ? message.type === 'string_literal'
        ? [message.text]
        : namedChildren(message).map((child) => child.text)
      : undefined;
    return { kind: 'staticAssert', condition: this.expression(condition), ...(parts ? { message: parts } : {}), row };
  }

  private functionDefinition(node: Node): ExternalDeclaration {
    const specifiers = this.specifiers(node);
    const declaratorNode = field(node, 'declarator');
    const declarator = this.declarator(declaratorNode);
    const name = declaredName(declarator);
    if (name) this.scope.declare(name, 'value');
    const body = field(node, 'body');
    const outer = this.scope;
    this.scope = new NameScope(outer);
    try {
      const fn = findFunctionDeclarator(declarator);
      for (const param of fn?.params ?? []) {
        const paramName = declaredName(param.declarator);
        if (paramName) this.scope.declare(paramName, 'value');
      }
      const compound = this.compoundItems(body);
      return {
        kind: 'function',
        specifiers,
        declarator,
        body: compound,
        bodyRow: body.startPosition.row,
        row: node.startPosition.row,
      };
    } finally {
      this.scope = outer;
    }
  }

  // Declarations ----------------------------------------------------------------------------------------------------

  private declaration(node: Node, type?: TypeSpecifier): Declaration {
    const specifiers = this.specifiers(node);
    if (type) specifiers.type = type;
    if (node.type === 'type_definition') specifiers.storage = 'typedef';
    const declarators = node.childrenForFieldName('declarator').map((child) => {
      if (child.type === 'init_declarator') {
        const declarator = this.declarator(field(child, 'declarator'));
        this.declareName(declarator, specifiers.storage);
        const value = field(child, 'value');
        return { declarator, init: this.initializer(value), row: child.startPosition.row };
      }
      const declarator = this.declarator(child);
      this.declareName(declarator, specifiers.storage);
      return { declarator, row: child.startPosition.row };
    });
    return {
      kind: 'declaration',
      specifiers,
      declarators,
      row: node.startPosition.row,
      ...(this.fromHeader ? { fromHeader: this.fromHeader } : {}),
    };
  }

  private declareName(declarator: Declarator, storage: StorageClass | undefined): void {
    const name = declaredName(declarator);
    if (name) this.scope.declare(name, storage === 'typedef' ? 'type' : 'value');
  }

  private designator(node: Node): Designator {
    const row = node.startPosition.row;
    switch (node.type) {
      case 'field_designator': {
        return { kind: 'field', name: (namedChildren(node)[0] ?? node).text, row };
      }
      // GNU's old form `x: 1`.
      case 'field_identifier': {
        return { kind: 'field', name: node.text, row };
      }
      case 'subscript_designator': {
        return { kind: 'index', index: this.expression(namedChildren(node)[0] ?? node), row };
      }
      case 'subscript_range_designator': {
        return {
          kind: 'index',
          index: this.expression(field(node, 'start')),
          end: this.expression(field(node, 'end')),
          row,
        };
      }
    }
    throw new CompileError([{ row, message: '初期化の指定の書き方に誤りがあります。' }]);
  }

  private initializer(node: Node): Initializer {
    if (node.type === 'initializer_pair') {
      const designators = node.childrenForFieldName('designator').map((designator) => this.designator(designator));
      return {
        kind: 'designated',
        designators,
        value: this.initializer(field(node, 'value')),
        row: node.startPosition.row,
      };
    }
    if (node.type !== 'initializer_list') {
      return { kind: 'expression', expression: this.expression(node), row: node.startPosition.row };
    }
    const items = namedChildren(node)
      .filter((child) => child.type !== 'comment')
      .map((child) => {
        this.checkUnsupported(child);
        return this.initializer(child);
      });
    return { kind: 'list', items, row: node.startPosition.row };
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of declaration specifier.
  // code-gauge-allow functionNcss 33 -- Storage, qualifiers, attributes and type nodes share one declaration specification.
  private specifiers(node: Node): Specifiers {
    const typeNodes = declarationTypeNodes(node);
    if (typeNodes.length === 0) throw new CSyntaxError(node, '型の指定が必要です。');
    validateDeclarationChildren(node, typeNodes, (child) => this.checkUnsupported(child));
    let storage: StorageClass | undefined;
    let isInline = false;
    const alignas: NonNullable<Specifiers['alignas']> = [];
    const qualifiers = { isConst: false, isVolatile: false };
    for (const child of node.namedChildren) {
      if (child.type === 'storage_class_specifier') {
        const word = this.storageClass(child);
        if (word === 'inline') isInline = true;
        else if (word !== undefined) {
          if (storage) {
            throw new CompileError([
              { row: child.startPosition.row, message: '記憶域の指定（static など）は1つだけ書けます。' },
            ]);
          }
          storage = word;
        }
      } else if (child.type === 'type_qualifier') {
        {
          const requested = this.qualifier(child, qualifiers);
          if (requested) alignas.push(requested);
        }
      } else if (child.type === 'attribute_specifier' || child.type === 'attribute_declaration') {
        this.attributes(child);
      }
    }
    for (const child of typeNodes.flatMap((typeNode) => typeNode.namedChildren))
      if (child.type === 'type_qualifier') {
        const requested = this.qualifier(child, qualifiers);
        if (requested) alignas.push(requested);
      }
    return {
      storage,
      qualifiers,
      type: this.declarationType(typeNodes),
      row: node.startPosition.row,
      ...(alignas.length > 0 ? { alignas } : {}),
      ...(isInline ? { isInline } : {}),
    };
  }

  private declarationType(nodes: Node[]): TypeSpecifier {
    let type = this.typeSpecifier(nodes[0]);
    for (const node of nodes.slice(1)) {
      const next = this.typeSpecifier(node);
      const words = type.kind === 'builtin' && next.kind === 'builtin' ? [...type.words, ...next.words] : undefined;
      if (!words || !builtinType(words))
        throw new CompileError([{ row: node.startPosition.row, message: '型の指定を組み合わせることはできません。' }]);
      type = { kind: 'builtin', words, row: type.row };
    }
    return type;
  }

  private storageClass(node: Node): StorageClass | 'inline' | undefined {
    const word = node.text;
    if (word === 'inline' || word === '__inline' || word === '__inline__') return 'inline';
    // _Noreturn only lets the compiler assume that the function never returns.
    if (word === '_Noreturn' || word === 'noreturn') return undefined;
    if (word === '_Thread_local' || word === 'thread_local' || word === '__thread') {
      unsupported(node.startPosition.row, '_Thread_local');
    }
    if (word === 'constexpr') unsupported(node.startPosition.row, 'constexpr');
    return word as StorageClass;
  }

  /** Records a type qualifier, returning the alignment of `_Alignas`, which is no qualifier in C but parses as one. */
  private qualifier(
    node: Node,
    qualifiers: { isConst: boolean; isVolatile: boolean }
  ): NonNullable<Specifiers['alignas']>[number] | undefined {
    this.checkUnsupported(node);
    const word = node.text;
    const row = node.startPosition.row;
    const alignas = namedChildren(node).find((child) => child.type === 'alignas_qualifier');
    if (alignas) {
      const operand = namedChildren(alignas).find((child) => child.type !== 'comment');
      if (!operand) throw new CompileError([{ row, message: '_Alignas には、大きさか型を書いてください。' }]);
      return operand.type === 'type_descriptor'
        ? { typeName: this.typeName(operand), row }
        : { expression: this.expression(operand), row };
    }
    if (word === 'const') qualifiers.isConst = true;
    else if (word === 'volatile') qualifiers.isVolatile = true;
    // restrict, _Noreturn, and the nullability qualifiers only promise things the compiler may use to optimize.
    else if (
      [
        '_Noreturn',
        'noreturn',
        'restrict',
        '__restrict',
        '__restrict__',
        '_Nonnull',
        '_Nullable',
        '_Null_unspecified',
        // __extension__ before a declaration only silences clang's warnings about GNU extensions in it.
        '__extension__',
      ].includes(word)
    )
      return undefined;
    else if (word === '_Atomic') unsupported(row, '_Atomic');
    else unsupported(row, /^\w+/.exec(word)?.[0] ?? word);
    return undefined;
  }

  private attributes(node: Node): void {
    checkAttributes(node.text, node.startPosition.row);
  }

  // code-gauge-allow functionCognitiveComplexity 17 -- Each C type specifier has a distinct AST form.
  // code-gauge-allow functionNcss 33 -- Keep the type specifier dispatch together.
  private typeSpecifier(node: Node): TypeSpecifier {
    const row = node.startPosition.row;
    this.checkUnsupported(node);
    switch (node.type) {
      case 'typeof_specifier': {
        if (/^typeof\b/.test(node.text)) {
          throw new CompileError([
            { row, message: '関数「typeof」は宣言されていません（C17 では __typeof__ と書きます）。' },
          ]);
        }
        const operand = namedChildren(node).find((child) => child.type !== 'comment');
        if (!operand) throw new CompileError([{ row, message: '__typeof__ には、式か型を書いてください。' }]);
        return operand.type === 'type_descriptor'
          ? { kind: 'typeof', typeName: this.typeName(operand), row }
          : { kind: 'typeof', operand: this.expression(operand), row };
      }
      case 'primitive_type': {
        const word = node.text;
        if (!BUILTIN_WORDS.has(word) && this.scope.isType(word)) return { kind: 'typedefName', name: word, row };
        return { kind: 'builtin', words: [primitiveWord(node)], row };
      }
      case 'sized_type_specifier': {
        return this.sizedTypeSpecifier(node);
      }
      case 'type_identifier': {
        const name = node.text;
        if (name === '_Bool') return { kind: 'builtin', words: ['_Bool'], row };
        if (name === '_Complex' || name === '__complex__') unsupported(row, '_Complex');
        if (!this.scope.isType(name)) throw new CompileError([{ row, message: `「${name}」という型はありません。` }]);
        return { kind: 'typedefName', name, row };
      }
      case 'struct_specifier':
      case 'union_specifier': {
        return this.recordSpecifier(node);
      }
      case 'enum_specifier': {
        return this.enumSpecifier(node);
      }
    }
    throw new CompileError([{ row, message: '型の書き方に誤りがあります。' }]);
  }

  private sizedTypeSpecifier(node: Node): TypeSpecifier {
    const row = node.startPosition.row;
    const words = node.children.filter((child): child is Node => !!child && !child.isNamed).map((child) => child.type);
    const inner = node.childForFieldName('type');
    if (inner) {
      if (inner.type === 'type_identifier' && !BUILTIN_WORDS.has(inner.text)) {
        throw new CompileError([{ row, message: `「${words.join(' ')} ${inner.text}」という型はありません。` }]);
      }
      this.checkUnsupported(inner);
      words.push(inner.type === 'primitive_type' ? primitiveWord(inner) : inner.text);
    }
    return { kind: 'builtin', words, row };
  }

  private recordSpecifier(node: Node): TypeSpecifier {
    const kind = node.type === 'struct_specifier' ? 'struct' : 'union';
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    const fields = body ? this.fields(body) : undefined;
    return {
      kind,
      ...(name === undefined ? {} : { tag: name }),
      ...(fields ? { fields } : {}),
      row: node.startPosition.row,
    };
  }

  private enumSpecifier(node: Node): TypeSpecifier {
    const row = node.startPosition.row;
    if (node.childForFieldName('underlying_type')) unsupported(row, '列挙の基になる型の指定');
    const name = node.childForFieldName('name')?.text;
    const body = node.childForFieldName('body');
    const enumerators = body ? this.enumerators(body) : undefined;
    return {
      kind: 'enum',
      ...(name === undefined ? {} : { tag: name }),
      ...(enumerators ? { enumerators } : {}),
      row,
    };
  }

  private fields(body: Node): FieldDeclaration[] {
    return namedChildren(body)
      .filter((child) => child.type !== 'comment')
      .map((child) => {
        this.checkUnsupported(child);
        if (child.type !== 'field_declaration') {
          throw new CompileError([
            { row: child.startPosition.row, message: '構造体の中には、メンバの宣言だけを書けます。' },
          ]);
        }
        const specifiers = this.specifiers(child);
        const declaratorNodes = child.childrenForFieldName('declarator');
        const bitfields = child.namedChildren.filter((item): item is Node => item?.type === 'bitfield_clause');
        if (declaratorNodes.length === 0 && bitfields.length === 0) {
          return { specifiers, declarators: [], row: child.startPosition.row };
        }
        const declarators = this.fieldDeclarators(child);
        return { specifiers, declarators, row: child.startPosition.row };
      });
  }

  /** The declarators of a member declaration, each with the width after it when it is a bit-field. */
  // code-gauge-allow functionCognitiveComplexity 16 -- Keep named, unnamed, and bit-field declarators in the same field-list conversion.
  private fieldDeclarators(node: Node): FieldDeclaration['declarators'] {
    const result: FieldDeclaration['declarators'] = [];
    let current: FieldDeclaration['declarators'][number] | undefined;
    for (const child of node.children) {
      if (!child) continue;
      if (child.type === ',') {
        if (current) result.push(current);
        current = undefined;
        continue;
      }
      if (child.type === 'bitfield_clause') {
        const width = this.expression(namedChildren(child)[0]);
        current = current
          ? { ...current, bitWidth: width }
          : {
              declarator: { kind: 'name', row: child.startPosition.row },
              bitWidth: width,
              row: child.startPosition.row,
            };
        continue;
      }
      if (node.childrenForFieldName('declarator').some((item) => item.id === child.id)) {
        current = { declarator: this.declarator(child), row: child.startPosition.row };
      }
    }
    if (current) result.push(current);
    return result;
  }

  private enumerators(body: Node): Enumerator[] {
    return namedChildren(body)
      .filter((child) => child.type !== 'comment')
      .map((child) => {
        if (child.type !== 'enumerator') {
          throw new CompileError([{ row: child.startPosition.row, message: '列挙の書き方に誤りがあります。' }]);
        }
        const name = field(child, 'name').text;
        this.scope.declare(name, 'value');
        const value = child.childForFieldName('value');
        return { name, ...(value ? { value: this.expression(value) } : {}), row: child.startPosition.row };
      });
  }

  // code-gauge-allow functionNcss 32 -- Each declarator shape has its own conversion.
  private declarator(node: Node): Declarator {
    const row = node.startPosition.row;
    this.checkUnsupported(node);
    validateDeclaratorChildren(node, (child) => this.checkUnsupported(child));
    switch (node.type) {
      case 'attributed_declarator': {
        for (const child of namedChildren(node)) if (child.type === 'attribute_declaration') this.attributes(child);
        const inner = namedChildren(node).find(
          (child) => child.type !== 'attribute_declaration' && child.type !== 'comment'
        );
        if (!inner) throw new CompileError([{ row, message: '宣言の書き方に誤りがあります。' }]);
        return this.declarator(inner);
      }
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
      case 'primitive_type': {
        return { kind: 'name', name: node.text, row };
      }
      case 'pointer_declarator':
      case 'abstract_pointer_declarator': {
        return this.pointerDeclarator(node);
      }
      case 'array_declarator':
      case 'abstract_array_declarator': {
        return this.arrayDeclarator(node);
      }
      case 'function_declarator':
      case 'abstract_function_declarator': {
        const { params, variadic } = this.parameters(field(node, 'parameters'));
        return { kind: 'function', ...(params ? { params } : {}), variadic, inner: this.innerDeclarator(node), row };
      }
      case 'parenthesized_declarator':
      case 'abstract_parenthesized_declarator': {
        return this.innerDeclarator(node);
      }
    }
    throw new CompileError([{ row, message: '宣言の書き方に誤りがあります。' }]);
  }

  private pointerDeclarator(node: Node): Declarator {
    const qualifiers = { isConst: false, isVolatile: false };
    for (const child of node.namedChildren) {
      if (!child) continue;
      this.checkUnsupported(child);
      if (child.type === 'type_qualifier') this.qualifier(child, qualifiers);
      if (child.type === 'attribute_specifier' || child.type === 'attribute_declaration') this.attributes(child);
    }
    return { kind: 'pointer', qualifiers, inner: this.innerDeclarator(node), row: node.startPosition.row };
  }

  private arrayDeclarator(node: Node): Declarator {
    const row = node.startPosition.row;
    for (const child of node.namedChildren) {
      if (child?.type === 'type_qualifier') unsupported(row, '配列の引数の型修飾子');
    }
    if (node.children.some((child) => child?.type === 'static')) unsupported(row, '配列の引数の static');
    const size = node.childForFieldName('size');
    if (size?.type === '*') unsupported(row, '可変長配列（[*]）');
    return {
      kind: 'array',
      ...(size ? { size: this.expression(size) } : {}),
      inner: this.innerDeclarator(node),
      row,
    };
  }

  private innerDeclarator(node: Node): Declarator {
    const inner = node.childForFieldName('declarator');
    return inner ? this.declarator(inner) : { kind: 'name', row: node.startPosition.row };
  }

  private parameters(node: Node): { params?: Parameter[]; variadic: boolean } {
    const children = namedChildren(node).filter((child) => child.type !== 'comment');
    if (children.length === 0) return { variadic: false };
    const params: Parameter[] = [];
    let variadic = false;
    const outer = this.scope;
    this.scope = new NameScope(outer);
    try {
      for (const child of children) {
        this.checkUnsupported(child);
        if (child.type === 'variadic_parameter') {
          variadic = true;
          continue;
        }
        if (child.type !== 'parameter_declaration') {
          if (child.type === 'identifier') unsupported(child.startPosition.row, '古い形式の関数の定義');
          throw new CompileError([{ row: child.startPosition.row, message: '引数の書き方に誤りがあります。' }]);
        }
        const specifiers = this.specifiers(child);
        const declaratorNode = child.childForFieldName('declarator');
        const declarator = declaratorNode
          ? this.declarator(declaratorNode)
          : { kind: 'name' as const, row: child.startPosition.row };
        const name = declaredName(declarator);
        if (name) this.scope.declare(name, 'value');
        params.push({ specifiers, declarator, row: child.startPosition.row });
      }
    } finally {
      this.scope = outer;
    }
    return { params, variadic };
  }

  private typeName(node: Node): TypeName {
    const specifiers = this.specifiers(node);
    const declaratorNode = node.childForFieldName('declarator');
    const declarator = declaratorNode
      ? this.declarator(declaratorNode)
      : { kind: 'name' as const, row: node.startPosition.row };
    if (declaredName(declarator)) {
      throw new CompileError([{ row: node.startPosition.row, message: '型の書き方に誤りがあります。' }]);
    }
    return { specifiers, declarator, row: node.startPosition.row };
  }

  // Statements ------------------------------------------------------------------------------------------------------

  private compoundItems(node: Node): Compound {
    const outer = this.scope;
    this.scope = new NameScope(outer);
    try {
      const items: (Statement | Declaration | StaticAssert)[] = [];
      for (const child of namedChildren(node)) {
        if (child.type === 'comment') continue;
        items.push(...this.headersBefore(child.startPosition.row, true));
        items.push(...this.blockItem(child));
      }
      items.push(...this.headersBefore(node.endPosition.row, true));
      return { kind: 'compound', items, row: node.startPosition.row };
    } finally {
      this.scope = outer;
    }
  }

  /** A block item, where a `case` label's statements become the statements after the label. */
  // code-gauge-allow functionCognitiveComplexity 22 -- Case labels, static assertions and declaration recovery share block scope.
  private blockItem(node: Node): (Statement | Declaration | StaticAssert)[] {
    if (this.recovery) this.scanValueTypes(node);
    if (node.type === 'expression_statement') {
      const declaration = this.reparseDeclaration(node);
      if (declaration) return [declaration];
    }
    if (node.type === 'declaration' || node.type === 'type_definition') return this.declarationOrExpression(node);
    if (node.type === 'expression_statement') {
      const staticAssert = this.staticAssert(node);
      if (staticAssert) return [staticAssert];
    }
    if (node.type === 'struct_specifier' || node.type === 'union_specifier' || node.type === 'enum_specifier') {
      return this.externalDeclaration(node) as Declaration[];
    }
    if (node.type === 'function_definition') {
      this.specifiers(node);
      throw new CSyntaxError(field(node, 'body'), '関数の中では、関数を定義できません。');
    }
    if (node.type === 'case_statement') {
      const row = node.startPosition.row;
      const valueNode = node.childForFieldName('value');
      const endNode = node.childForFieldName('end_value');
      const value = valueNode ? this.expression(valueNode) : undefined;
      const endValue = endNode ? this.expression(endNode) : undefined;
      const body = namedChildren(node).filter(
        (child) => child.id !== valueNode?.id && child.id !== endNode?.id && child.type !== 'comment'
      );
      const converted = body.flatMap((child) => this.blockItem(child));
      const [first, ...rest] = converted;
      const labeled: Statement = {
        kind: 'case',
        ...(value ? { value } : {}),
        ...(endValue ? { endValue } : {}),
        body: first ?? { kind: 'expression', row },
        row,
      };
      return [labeled, ...rest];
    }
    return [this.statement(node)];
  }

  private reparseDeclaration(node: Node): Declaration | undefined {
    const leading = this.leadingType(node.text, node.startPosition.row);
    if (!leading) return undefined;
    const source = '\n'.repeat(node.startPosition.row) + 'int' + node.text.slice(leading.length);
    return parseSource(
      this.parser,
      source,
      {},
      (root) => {
        const declaration = root.firstNamedChild;
        if (!declaration || declaration.type !== 'declaration')
          throw new CompileError([{ row: node.startPosition.row, message: '宣言の書き方に誤りがあります。' }]);
        return this.declaration(declaration, leading.type);
      },
      {
        locateErrors: (_root, errors) => {
          if (errors.length > 0)
            throw new CSyntaxError(node, errors[0].message, { row: errors[0].row, offset: node.endIndex });
          return errors;
        },
      }
    );
  }

  private leadingType(text: string, row: number): { length: number; type: TypeSpecifier } | undefined {
    const name = /^[\p{XID_Start}_$][\p{XID_Continue}$]*/u.exec(text)?.[0];
    if (!name) return undefined;
    if (name === '_Bool') return { length: name.length, type: { kind: 'builtin', words: ['_Bool'], row } };
    if (!this.scope.isType(name)) return undefined;
    return { length: name.length, type: { kind: 'typedefName', name, row } };
  }

  /**
   * A declaration, unless its type names no type, as in `a * b;` where `a` is a variable, which tree-sitter parses as a
   * declaration but C as an expression.
   */
  private declarationOrExpression(node: Node): (Statement | Declaration)[] {
    const typeNode = node.childForFieldName('type');
    const declarators = node.childrenForFieldName('declarator');
    if (
      node.type === 'declaration' &&
      typeNode?.type === 'type_identifier' &&
      typeNode.text !== '_Bool' &&
      !this.scope.isType(typeNode.text) &&
      declarators.length === 1 &&
      declarators[0].type === 'pointer_declarator' &&
      node.namedChildren.length === 2
    ) {
      const row = node.startPosition.row;
      const left: Expression = { kind: 'identifier', name: typeNode.text, row };
      const inner = field(declarators[0], 'declarator');
      if (inner.type === 'identifier') {
        return [
          {
            kind: 'expression',
            expression: {
              kind: 'binary',
              operator: '*',
              left,
              right: { kind: 'identifier', name: inner.text, row },
              row,
            },
            row,
          },
        ];
      }
    }
    return [this.declaration(node)];
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- One case per kind of statement.
  // code-gauge-allow functionNcss 48 -- Keep the statement shape dispatch together.
  private statement(node: Node): Statement {
    if (this.recovery && node.isError) this.scanValueTypes(node);
    const row = node.startPosition.row;
    this.checkUnsupported(node);
    switch (node.type) {
      case 'compound_statement': {
        return this.compoundItems(node);
      }
      case 'attributed_statement': {
        const inner = namedChildren(node).find(
          (child) => child.type !== 'attribute_declaration' && child.type !== 'comment'
        );
        return inner ? this.statement(inner) : { kind: 'expression', row };
      }
      case 'expression_statement': {
        const child = namedChildren(node).find((item) => item.type !== 'comment');
        return { kind: 'expression', ...(child ? { expression: this.expression(child) } : {}), row };
      }
      case 'if_statement': {
        const alternative = node.childForFieldName('alternative');
        const otherwise = alternative
          ? namedChildren(alternative).find((child) => child.type !== 'comment')
          : undefined;
        return {
          kind: 'if',
          condition: this.parenthesized(field(node, 'condition')),
          consequent: this.subStatement(field(node, 'consequence')),
          ...(otherwise ? { alternative: this.subStatement(otherwise) } : {}),
          row,
        };
      }
      case 'while_statement': {
        return {
          kind: 'while',
          condition: this.parenthesized(field(node, 'condition')),
          body: this.subStatement(field(node, 'body')),
          row,
        };
      }
      case 'do_statement': {
        return {
          kind: 'doWhile',
          condition: this.parenthesized(field(node, 'condition')),
          body: this.subStatement(field(node, 'body')),
          row,
        };
      }
      case 'for_statement': {
        return this.forStatement(node);
      }
      case 'switch_statement': {
        return {
          kind: 'switch',
          condition: this.parenthesized(field(node, 'condition')),
          body: this.subStatement(field(node, 'body')),
          row,
        };
      }
      case 'break_statement': {
        return { kind: 'break', row };
      }
      case 'continue_statement': {
        return { kind: 'continue', row };
      }
      case 'return_statement': {
        const value = namedChildren(node).find((child) => child.type !== 'comment');
        return { kind: 'return', ...(value ? { value: this.expression(value) } : {}), row };
      }
      case 'goto_statement': {
        const label = field(node, 'label');
        if (label.type !== 'statement_identifier') unsupported(row, '計算した場所への goto（goto *p）');
        return { kind: 'goto', label: label.text, row };
      }
      case 'labeled_statement': {
        const label = field(node, 'label').text;
        const body = namedChildren(node).find(
          (child) => child.type !== 'statement_identifier' && child.type !== 'comment'
        );
        const converted = body ? this.blockItem(body) : [];
        if (converted.length > 1) {
          throw new CompileError([{ row, message: 'ラベルの書き方に誤りがあります。' }]);
        }
        return {
          kind: 'labeled',
          label,
          body: converted[0] ?? { kind: 'expression', row },
          row,
        };
      }
      case 'case_statement': {
        return this.blockItem(node)[0] as Statement;
      }
    }
    throw new CompileError([{ row, message: '文の書き方に誤りがあります。' }]);
  }

  /** The body of a control statement, which has its own scope in C99 even when it is no block. */
  private subStatement(node: Node): Statement {
    const outer = this.scope;
    this.scope = new NameScope(outer);
    try {
      if (node.type === 'declaration' || node.type === 'type_definition') {
        throw new CompileError([
          { row: node.startPosition.row, message: 'ここには宣言を書けません（{ } で囲んでください）。' },
        ]);
      }
      return this.statement(node);
    } finally {
      this.scope = outer;
    }
  }

  private forStatement(node: Node): Statement {
    const row = node.startPosition.row;
    const outer = this.scope;
    this.scope = new NameScope(outer);
    try {
      const initNode = node.childForFieldName('initializer');
      let init: Declaration | Expression | undefined;
      if (initNode) {
        if (initNode.type === 'declaration') {
          const converted = this.declarationOrExpression(initNode);
          const [first] = converted;
          init =
            first.kind === 'declaration' ? first : (first as Extract<Statement, { kind: 'expression' }>).expression;
        } else {
          init = this.expression(initNode);
        }
      }
      const condition = node.childForFieldName('condition');
      const update = node.childForFieldName('update');
      return {
        kind: 'for',
        ...(init ? { init } : {}),
        ...(condition ? { condition: this.expression(condition) } : {}),
        ...(update ? { update: this.expression(update) } : {}),
        body: this.subStatement(field(node, 'body')),
        row,
      };
    } finally {
      this.scope = outer;
    }
  }

  private parenthesized(node: Node): Expression {
    const inner = namedChildren(node).filter((child) => child.type !== 'comment');
    if (node.type !== 'parenthesized_expression' || inner.length !== 1) return this.expression(node);
    if (inner[0].type === 'declaration' || inner[0].type === 'compound_statement') {
      unsupported(node.startPosition.row, '条件の中の宣言');
    }
    return this.expression(inner[0]);
  }

  // Expressions -----------------------------------------------------------------------------------------------------

  // code-gauge-allow functionNcss 60 -- One case per C expression kind; helpers already isolate the nontrivial forms.
  private expression(node: Node): Expression {
    if (this.recovery) this.scanValueTypes(node);
    const row = node.startPosition.row;
    this.checkUnsupported(node);
    switch (node.type) {
      case 'identifier': {
        return { kind: 'identifier', name: node.text, row };
      }
      case 'true':
      case 'false': {
        throw new CompileError([
          { row, message: `「${node.text}」は宣言されていません（<stdbool.h> を読み込んでください）。` },
        ]);
      }
      case 'number_literal': {
        return { kind: 'number', text: node.text, row };
      }
      case 'char_literal': {
        return { kind: 'char', text: node.text, row };
      }
      case 'string_literal': {
        return { kind: 'string', parts: [node.text], row };
      }
      case 'concatenated_string': {
        return this.concatenatedString(node);
      }
      case 'parenthesized_expression': {
        return this.parenthesizedExpression(node);
      }
      case 'binary_expression': {
        return this.binary(node);
      }
      case 'assignment_expression': {
        return this.assignment(node);
      }
      case 'unary_expression': {
        return {
          kind: 'unary',
          operator: field(node, 'operator').type as '-' | '+' | '!' | '~',
          operand: this.expression(field(node, 'argument')),
          row,
        };
      }
      case 'pointer_expression': {
        const operand = this.expression(field(node, 'argument'));
        return field(node, 'operator').type === '*'
          ? { kind: 'deref', operand, row }
          : { kind: 'address', operand, row };
      }
      case 'update_expression': {
        return this.update(node);
      }
      case 'cast_expression': {
        return this.cast(node);
      }
      case 'sizeof_expression': {
        return this.sizeof(node);
      }
      case 'conditional_expression': {
        return this.conditional(node);
      }
      case 'comma_expression': {
        return {
          kind: 'comma',
          left: this.expression(field(node, 'left')),
          right: this.expression(field(node, 'right')),
          row,
        };
      }
      case 'call_expression': {
        return this.call(node);
      }
      case 'subscript_expression': {
        const index = this.expression(field(node, 'index'));
        return this.postfix(
          this.expression(field(node, 'argument')),
          (array) => ({
            kind: 'subscript',
            array,
            index,
            row,
          }),
          node.children.find((child) => child.type === '[')!
        );
      }
      case 'field_expression': {
        return this.postfix(
          this.expression(field(node, 'argument')),
          (object) => ({
            kind: 'member',
            object,
            field: field(node, 'field').text,
            arrow: field(node, 'operator').type === '->',
            row,
          }),
          field(node, 'operator')
        );
      }
      case 'compound_literal_expression': {
        return this.compoundLiteral(node);
      }
      case 'alignof_expression': {
        return { kind: 'alignof', typeName: this.typeName(field(node, 'type')), row };
      }
      case 'extension_expression': {
        return this.expression(namedChildren(node).find((child) => child.type !== 'comment') ?? field(node, 'value'));
      }
      case 'va_arg_expression': {
        return {
          kind: 'vaArg',
          operand: this.expression(field(node, 'value')),
          typeName: this.typeName(field(node, 'type')),
          row,
        };
      }
      case 'offsetof_expression': {
        return {
          kind: 'offsetof',
          typeName: this.typeName(field(node, 'type')),
          member: field(node, 'member').text,
          row,
        };
      }
      case 'initializer_list': {
        throw new CompileError([{ row, message: '{ } で囲んだ初期化子は、変数の宣言でしか書けません。' }]);
      }
    }
    throw new CompileError([{ row, message: '式の書き方に誤りがあります。' }]);
  }

  private update(node: Node): Expression {
    const row = node.startPosition.row;
    const operator = field(node, 'operator');
    const argument = field(node, 'argument');
    const operand = this.expression(argument);
    const prefix = operator.startIndex < argument.startIndex;
    const build = (value: Expression): Expression => ({
      kind: 'update',
      operatorRow: operator.startPosition.row,
      operator: operator.type as '++' | '--',
      prefix,
      operand: value,
      row,
    });
    return prefix ? build(operand) : this.postfix(operand, build, operator);
  }

  private assignment(node: Node): Expression {
    const operator = field(node, 'operator').type;
    return {
      kind: 'assign',
      operator: operator === '=' ? undefined : (operator.slice(0, -1) as BinaryOperator),
      left: this.expression(field(node, 'left')),
      right: this.expression(field(node, 'right')),
      row: node.startPosition.row,
    };
  }

  private compoundLiteral(node: Node): Expression {
    const row = node.startPosition.row;
    if (node.childrenForFieldName('storage_class').length > 0)
      unsupported(row, '記憶域の指定のある複合リテラル（C23）');
    return {
      kind: 'compoundLiteral',
      typeName: this.typeName(field(node, 'type')),
      init: this.initializer(field(node, 'value')),
      row,
    };
  }

  private scanValueTypes(node: Node): void {
    if (!this.recovery) return;
    this.typeScopes.push({ start: node.startIndex, end: node.endIndex, names: this.scope.typeNames(this.recovery) });
    if (['compound_statement', 'for_statement', 'function_definition'].includes(node.type)) return;
    const pending = [node];
    while (pending.length > 0) {
      this.recovery.spend();
      const part = pending.pop()!;
      if (['compound_statement', 'for_statement', 'function_definition'].includes(part.type)) continue;
      if (part.type === 'type_descriptor') {
        const type = part.childForFieldName('type');
        if (type?.type === 'type_identifier' && this.scope.kindOf(type.text) === 'value')
          this.valueTypeRanges.set(type.startIndex, type.endIndex);
      }
      pending.push(...part.namedChildren);
    }
  }

  private concatenatedString(node: Node): Expression {
    const parts = namedChildren(node).map((child) => {
      if (child.type !== 'string_literal') {
        throw new CSyntaxError(child, '文字列リテラルの並べ方に誤りがあります。');
      }
      return child.text;
    });
    return { kind: 'string', parts, row: node.startPosition.row };
  }

  private parenthesizedExpression(node: Node): Expression {
    const row = node.startPosition.row;
    const inner = namedChildren(node).filter((child) => child.type !== 'comment');
    if (inner.length !== 1) throw new CompileError([{ row, message: '式の書き方に誤りがあります。' }]);
    if (inner[0].type === 'compound_statement') unsupported(row, '文の式（({ ... })）');
    return { kind: 'paren', expression: this.expression(inner[0]), row };
  }

  private cast(node: Node): Expression {
    const row = node.startPosition.row;
    const typeName = this.typeName(field(node, 'type'));
    const value = field(node, 'value');
    if (value.type === 'assignment_expression')
      throw new CSyntaxError(value, '代入する左側には、変数や配列の要素などを書いてください。');
    return { kind: 'cast', typeName, operand: this.expression(value), row };
  }

  private sizeof(node: Node): Expression {
    const row = node.startPosition.row;
    const type = node.childForFieldName('type');
    if (type) return { kind: 'sizeofType', typeName: this.typeName(type), row };
    const value = field(node, 'value');
    const text = value.text;
    const inner = value.type === 'parenthesized_expression' ? text.slice(1, -1).trim() : '';
    const leading = this.leadingType(inner, row);
    if (leading) {
      const source = '\n'.repeat(row) + `int __trace_size = sizeof(int${inner.slice(leading.length)});`;
      return parseSource(this.parser, source, {}, (root) => {
        const typeNode = root.descendantsOfType('sizeof_expression')[0]?.childForFieldName('type');
        if (!typeNode) throw new CompileError([{ row, message: '型の書き方に誤りがあります。' }]);
        const typeName = this.typeName(typeNode);
        typeName.specifiers.type = leading.type;
        return { kind: 'sizeofType', typeName, row };
      });
    }
    const operand = this.expression(value);
    if (operand.kind === 'cast')
      throw new CompileError([{ row, message: 'sizeof の型や式を括弧で正しく囲んでください。' }]);
    const typeName = this.parenthesizedTypeName(operand);
    return typeName ? { kind: 'sizeofType', typeName, row } : { kind: 'sizeofExpression', operand, row };
  }

  private conditional(node: Node): Expression {
    const row = node.startPosition.row;
    const consequence = node.childForFieldName('consequence');
    return {
      kind: 'conditional',
      condition: this.expression(field(node, 'condition')),
      ...(consequence ? { consequent: this.expression(consequence) } : {}),
      alternative: this.expression(field(node, 'alternative')),
      row,
    };
  }

  /** The type that `(T)` names when `T` is a typedef name, which tree-sitter parses as an expression. */
  private parenthesizedTypeName(expression: Expression): TypeName | undefined {
    if (expression.kind !== 'paren' || expression.expression.kind !== 'identifier') return undefined;
    const { name, row } = expression.expression;
    if (name === '_Bool') {
      return {
        specifiers: { qualifiers: NO_QUALIFIERS, type: { kind: 'builtin', words: ['_Bool'], row }, row },
        declarator: { kind: 'name', row },
        row,
      };
    }
    if (!this.scope.isType(name)) return undefined;
    return {
      specifiers: { qualifiers: NO_QUALIFIERS, type: { kind: 'typedefName', name, row }, row },
      declarator: { kind: 'name', row },
      row,
    };
  }

  private binary(node: Node): Expression {
    const row = node.startPosition.row;
    const operator = field(node, 'operator').type as BinaryOperator;
    const left = this.expression(field(node, 'left'));
    const right = this.expression(field(node, 'right'));
    const castType = ['*', '&', '+', '-'].includes(operator) ? this.parenthesizedTypeName(left) : undefined;
    if (castType) return castOfUnary(castType, operator, right, row);
    return { kind: 'binary', operator, left, right, row, operatorRow: field(node, 'operator').startPosition.row };
  }

  private call(node: Node): Expression {
    const row = node.startPosition.row;
    const callee = this.expression(field(node, 'function'));
    const args = namedChildren(field(node, 'arguments'))
      .filter((child) => child.type !== 'comment')
      .map((child) => {
        if (child.type === 'compound_statement') unsupported(row, '文の式（({ ... })）');
        return this.expression(child);
      });
    const castType = this.parenthesizedTypeName(callee);
    if (castType) {
      if (args.length === 0) throw new CompileError([{ row, message: '式の書き方に誤りがあります。' }]);
      let operand = args[0];
      for (const right of args.slice(1)) operand = { kind: 'comma', left: operand, right, row };
      const cast: Expression = {
        kind: 'cast',
        typeName: castType,
        operand: { kind: 'paren', expression: operand, row },
        row,
      };
      this.recoveredCasts.add(cast);
      return cast;
    }
    return this.postfix(
      callee,
      (target) => ({
        kind: 'call',
        callee: target,
        args,
        row,
        operatorRow: field(node, 'arguments').startPosition.row,
      }),
      field(node, 'arguments')
    );
  }

  private postfix(operand: Expression, build: (operand: Expression) => Expression, token: Node): Expression {
    if (operand.kind === 'sizeofType') throw new CSyntaxError(token, 'sizeof の式を括弧で正しく囲んでください。');
    if (operand.kind !== 'cast' || !this.recoveredCasts.has(operand)) return build(operand);
    const cast: Expression = { ...operand, operand: build(operand.operand) };
    this.recoveredCasts.add(cast);
    return cast;
  }

  private checkUnsupported(node: Node): void {
    const feature = UNSUPPORTED_NODES[node.type];
    if (feature) unsupported(node.startPosition.row, feature);
    const keyword = NOT_C17_KEYWORDS[node.type];
    if (keyword) {
      throw new CompileError([{ row: node.startPosition.row, message: `「${keyword}」は宣言されていません。` }]);
    }
    if (node.type === 'linkage_specification' || node.type === 'raw_string_literal') {
      throw new CompileError([
        { row: node.startPosition.row, message: '書き方に誤りがあります（C++ の書き方は C では使えません）。' },
      ]);
    }
    if (node.type.startsWith('ms_') || node.type.startsWith('seh_'))
      unsupported(node.startPosition.row, 'Microsoft の拡張');
  }
}

/** `(T)op operand`, which tree-sitter parses as a binary expression; the cast binds to the operand's first factor. */
function castOfUnary(typeName: TypeName, operator: BinaryOperator, operand: Expression, row: number): Expression {
  if (operand.kind === 'binary') {
    return { ...operand, left: castOfUnary(typeName, operator, operand.left, row) };
  }
  let inner: Expression;
  if (operator === '*') inner = { kind: 'deref', operand, row };
  else if (operator === '&') inner = { kind: 'address', operand, row };
  else inner = { kind: 'unary', operator: operator as '+' | '-', operand, row };
  return { kind: 'cast', typeName, operand: inner, row };
}

function primitiveWord(node: Node): string {
  const word = node.text;
  if (!BUILTIN_WORDS.has(word)) {
    throw new CompileError([{ row: node.startPosition.row, message: `「${word}」という型はありません。` }]);
  }
  return word;
}

export function declaredName(declarator: Declarator): string | undefined {
  return declarator.kind === 'name' ? declarator.name : declaredName(declarator.inner);
}

/** The function declarator that applies to a declared name directly, as in `int f(int)` or `int (*g(void))[3]`. */
export function findFunctionDeclarator(declarator: Declarator): Extract<Declarator, { kind: 'function' }> | undefined {
  let current = declarator;
  for (;;) {
    if (current.kind === 'name') return undefined;
    if (current.kind === 'function' && current.inner.kind === 'name') return current;
    current = current.inner;
  }
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function field(node: Node, name: string): Node {
  const child = node.childForFieldName(name);
  if (!child) throw new CompileError([{ row: node.startPosition.row, message: '書き方に誤りがあります。' }]);
  return child;
}
