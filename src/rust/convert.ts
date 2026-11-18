import type { Node } from '@willbooster/web-tree-sitter';

import { CompileError } from '../interpreter/diagnostics';
import type {
  Attributes,
  BinaryOp,
  Block,
  BoundAst,
  Condition,
  Crate,
  EnumItem,
  Expr,
  FieldAst,
  FnItem,
  FormatArgs,
  Generics,
  ImplItem,
  Item,
  MacroCall,
  MatchArm,
  Param,
  PathAst,
  PathSegment,
  Pattern,
  SelfParam,
  Span,
  Stmt,
  StructItem,
  TraitItem,
  TypeAst,
  UseItem,
  VariantAst,
  Visibility,
} from './ast';
import { parseFormatString } from './formatString';
import { parseCharLiteral, parseFloatLiteral, parseIntegerLiteral, parseStringLiteral } from './literals';

/** Reparses the tokens of a macro's arguments as Rust code, keeping their rows and columns. */
export type Reparse = (text: string, convert: (root: Node) => unknown) => unknown;

export function unavailable(span: Span, what: string): never {
  throw new CompileError([{ row: span.row, message: `${what}は、この採点環境では使えません。` }]);
}

export function syntaxError(span: Span, message: string): never {
  throw new CompileError([{ row: span.row, message }]);
}

const DERIVABLE = new Set(['Debug', 'Clone', 'Copy', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash', 'Default']);

/** Converts tree-sitter's concrete syntax tree to the AST, rejecting syntax this interpreter does not support. */
export class Converter {
  private readonly lines: string[];

  constructor(
    private readonly source: string,
    private readonly reparse: Reparse,
    /** Whether the source is the standard library's declarations, which may leave out bodies and values. */
    private readonly isStd = false
  ) {
    this.lines = source.split('\n');
  }

  span(node: Node): Span {
    const { row, column } = node.startPosition;
    const line = this.lines[row] ?? '';
    return { row, col: line.slice(0, column).length + 1 };
  }

  convertCrate(root: Node): Crate {
    const items: Item[] = [];
    for (const child of root.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'expression_statement' || child.type === 'let_declaration') {
        syntaxError(this.span(child), '文は、関数の中に書いてください。');
      }
      const item = this.item(child);
      if (item) items.push(item);
    }
    return { items };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Items

  // code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 46 -- One case per kind of syntax node.
  private item(node: Node, attrs?: Attributes): Item | undefined {
    const span = this.span(node);
    switch (node.type) {
      case 'function_item': {
        return this.fnItem(node);
      }
      case 'struct_item': {
        return this.structItem(node, attrs ?? { derives: [] });
      }
      case 'enum_item': {
        return this.enumItem(node, attrs ?? { derives: [] });
      }
      case 'trait_item': {
        return this.traitItem(node);
      }
      case 'impl_item': {
        return this.implItem(node);
      }
      case 'const_item': {
        const value = this.isStd ? node.childForFieldName('value') : this.field(node, 'value');
        return {
          kind: 'const',
          name: this.field(node, 'name').text,
          span,
          vis: this.visibility(node),
          type: this.type(this.field(node, 'type')),
          value: value ? this.expr(value) : undefined,
        };
      }
      case 'type_item': {
        if (!this.isStd) return this.unsupportedItem(node);
        return {
          kind: 'typeAlias',
          name: this.field(node, 'name').text,
          span,
          vis: this.visibility(node),
          generics: this.generics(node),
          type: this.type(this.field(node, 'type')),
        };
      }
      case 'mod_item': {
        const body = node.childForFieldName('body');
        if (!body) unavailable(span, '別のファイルのモジュール（mod 名前;）');
        const items: Item[] = [];
        for (const child of body.namedChildren) {
          if (isComment(child)) continue;
          const item = this.item(child);
          if (item) items.push(item);
        }
        return { kind: 'mod', name: this.field(node, 'name').text, span, vis: this.visibility(node), items };
      }
      case 'use_declaration': {
        return this.useItem(node);
      }
      case 'attributed_declaration': {
        return this.attributed(node);
      }
      case 'attribute_item': {
        return unavailable(span, `属性（${node.text}）`);
      }
      case 'empty_statement': {
        return undefined;
      }
      case 'function_signature_item': {
        if (this.isStd) return this.fnItem(node, true);
        return this.unsupportedItem(node);
      }
      default: {
        return this.unsupportedItem(node);
      }
    }
  }

  private unsupportedItem(node: Node): never {
    const span = this.span(node);
    const names: Record<string, string> = {
      static_item: 'static 変数',
      type_item: '型の別名（type）',
      union_item: '共用体（union）',
      macro_definition: 'マクロの定義（macro_rules!）',
      decl_macro: 'マクロの定義（macro）',
      extern_crate_declaration: '外部のクレート（extern crate）',
      foreign_mod_item: '外部の関数の宣言（extern ブロック）',
      inner_attribute_item: `属性（${node.text.split('\n')[0]}）`,
      function_signature_item: '本体のない関数',
      trait_alias: 'トレイトの別名',
      shebang: '#! で始まる行',
      frontmatter: 'フロントマター（---）',
      macro_invocation: '関数の外のマクロの呼び出し',
    };
    return unavailable(span, names[node.type] ?? `この書き方（${node.type}）`);
  }

  private attributed(node: Node): Item | undefined {
    const attrs: Attributes = { derives: [] };
    let declaration: Node | undefined;
    for (const child of node.namedChildren) {
      if (child.type === 'attribute_item') this.attribute(child, attrs);
      else if (!isComment(child)) declaration = child;
    }
    if (!declaration) return undefined;
    if (attrs.derives.length > 0 && declaration.type !== 'struct_item' && declaration.type !== 'enum_item') {
      syntaxError(this.span(node), '#[derive] は、構造体と列挙型にだけ付けられます。');
    }
    return this.item(declaration, attrs);
  }

  private attribute(node: Node, attrs: Attributes): void {
    const attribute = node.namedChildren.find((child) => child.type === 'attribute');
    const name = attribute?.namedChildren[0];
    if (!attribute || name?.type !== 'identifier' || name.text !== 'derive') {
      unavailable(this.span(node), `属性（${node.text}）`);
    }
    const args = attribute.childForFieldName('arguments');
    if (!args) unavailable(this.span(node), `属性（${node.text}）`);
    for (const token of args.namedChildren) {
      if (token.type !== 'identifier') unavailable(this.span(token), `#[derive] の中の ${token.text}`);
      if (!DERIVABLE.has(token.text)) unavailable(this.span(token), `#[derive(${token.text})]`);
      attrs.derives.push({ name: token.text, span: this.span(token) });
    }
  }

  private visibility(node: Node): Visibility {
    const modifier = node.namedChildren.find((child) => child.type === 'visibility_modifier');
    if (!modifier) return 'private';
    if (modifier.text !== 'pub' && !/^pub\s*\(\s*(crate|self|super)\s*\)$/.test(modifier.text)) {
      unavailable(this.span(modifier), `公開の範囲の指定（${modifier.text}）`);
    }
    return 'pub';
  }

  // code-gauge-allow functionCognitiveComplexity 21 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 38 -- One case per kind of syntax node.
  private fnItem(node: Node, allowMissingBody = false): FnItem {
    const span = this.span(node);
    checkNotReserved(this.field(node, 'name').text, span);
    const modifiers = node.namedChildren.find((child) => child.type === 'function_modifiers');
    if (modifiers) {
      const text = modifiers.text;
      if (text.includes('async')) unavailable(span, 'async fn');
      if (text.includes('unsafe')) unavailable(span, 'unsafe fn');
      if (text.includes('extern')) unavailable(span, 'extern fn');
      unavailable(span, `関数の修飾子（${text}）`);
    }
    const parametersNode = this.field(node, 'parameters');
    let selfParam: SelfParam | undefined;
    const params: Param[] = [];
    for (const child of parametersNode.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'self_parameter') {
        selfParam = this.selfParam(child);
      } else if (child.type === 'parameter') {
        params.push(this.param(child));
      } else if (child.type === 'attribute_item') {
        unavailable(this.span(child), `属性（${child.text}）`);
      } else if (child.type === 'variadic_parameter') {
        unavailable(this.span(child), '可変個の引数（...）');
      } else {
        syntaxError(this.span(child), '引数は「名前: 型」の形で書いてください。');
      }
    }
    const bodyNode = node.childForFieldName('body');
    if (!bodyNode && !allowMissingBody) syntaxError(span, '関数の本体（{ ... }）が足りません。');
    const ret = node.childForFieldName('return_type');
    const body = bodyNode ? this.block(bodyNode) : undefined;
    return {
      kind: 'fn',
      name: this.field(node, 'name').text,
      span,
      vis: this.visibility(node),
      generics: this.generics(node),
      selfParam,
      params,
      ret: ret ? this.type(ret) : undefined,
      body,
      endRow: node.endPosition.row,
      headerEndRow: bodyNode ? bodyNode.startPosition.row : node.endPosition.row,
    };
  }

  private selfParam(node: Node): SelfParam {
    const span = this.span(node);
    const lifetime = node.namedChildren.find((child) => child.type === 'lifetime')?.text;
    const text = node.text.replaceAll(/\s+/g, ' ');
    if (node.text.includes(':')) unavailable(span, '型を書いた self（self: Box<Self> など）');
    const isRef = text.startsWith('&');
    const isMut = node.namedChildren.some((child) => child.type === 'mutable_specifier');
    if (isRef) return { mode: isMut ? 'mutRef' : 'ref', mutable: false, lifetime, span };
    return { mode: 'value', mutable: isMut, span };
  }

  private param(node: Node): Param {
    const span = this.span(node);
    const patternNode = this.field(node, 'pattern');
    let pattern = this.pattern(patternNode);
    if (node.namedChildren.some((child) => child.type === 'mutable_specifier')) {
      if (pattern.kind !== 'binding') syntaxError(span, 'mut は名前の前に書いてください。');
      pattern = { ...pattern, mutable: true };
    }
    return { pattern, type: this.type(this.field(node, 'type')), span };
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 33 -- One case per kind of syntax node.
  private generics(node: Node): Generics {
    const generics: Generics = { params: [], lifetimes: [], where: [] };
    const parameters = node.childForFieldName('type_parameters');
    for (const child of parameters?.namedChildren ?? []) {
      if (isComment(child)) continue;
      const span = this.span(child);
      if (child.type === 'lifetime_parameter') {
        const bounds = child.childForFieldName('bounds');
        if (bounds) unavailable(span, "ライフタイムの境界（'a: 'b）");
        generics.lifetimes.push(this.field(child, 'name').text);
        continue;
      }
      if (child.type === 'const_parameter') unavailable(span, '定数のジェネリクス（const N: usize）');
      if (child.type !== 'type_parameter') unavailable(span, `型引数の書き方（${child.text}）`);
      if (child.childForFieldName('default_type')) unavailable(span, '型引数の既定の型');
      const bounds = child.childForFieldName('bounds');
      generics.params.push({
        name: this.field(child, 'name').text,
        span,
        bounds: bounds ? this.bounds(bounds) : [],
      });
    }
    const where = node.namedChildren.find((child) => child.type === 'where_clause');
    for (const predicate of where?.namedChildren ?? []) {
      if (predicate.type !== 'where_predicate') continue;
      const left = this.field(predicate, 'left');
      if (left.type === 'lifetime') unavailable(this.span(predicate), "ライフタイムの境界（'a: 'b）");
      if (left.type === 'higher_ranked_trait_bound') unavailable(this.span(predicate), "for<'a> の境界");
      const bounds = predicate.childForFieldName('bounds');
      generics.where.push({
        type: this.type(left),
        bounds: bounds ? this.bounds(bounds) : [],
        span: this.span(predicate),
      });
    }
    return generics;
  }

  private bounds(node: Node): BoundAst[] {
    const bounds: BoundAst[] = [];
    for (const child of node.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'lifetime') continue;
      bounds.push(this.bound(child));
    }
    return bounds;
  }

  private bound(node: Node): BoundAst {
    const span = this.span(node);
    switch (node.type) {
      case 'type_identifier':
      case 'scoped_type_identifier':
      case 'generic_type': {
        const path = this.typePath(node);
        return { kind: 'trait', path, span };
      }
      case 'function_type': {
        const trait = node.childForFieldName('trait');
        if (!trait || !['Fn', 'FnMut', 'FnOnce'].includes(trait.text)) {
          unavailable(span, '関数ポインタの型（fn(i32) -> i32）');
        }
        const params = this.field(node, 'parameters')
          .namedChildren.filter((child) => !isComment(child))
          .map((child) => this.type(child.type === 'parameter' ? this.field(child, 'type') : child));
        const ret = node.childForFieldName('return_type');
        return {
          kind: 'fn',
          trait: trait.text as 'Fn' | 'FnMut' | 'FnOnce',
          params,
          ret: ret ? this.type(ret) : undefined,
          span,
        };
      }
      case 'modified_trait_bound': {
        return unavailable(span, `境界の修飾（${node.text}）`);
      }
      case 'removed_trait_bound': {
        return unavailable(span, `境界の修飾（${node.text}）`);
      }
      case 'higher_ranked_trait_bound': {
        return unavailable(span, "for<'a> の境界");
      }
      case 'use_bounds': {
        return unavailable(span, 'use<...> の境界');
      }
      default: {
        return unavailable(span, `境界の書き方（${node.text}）`);
      }
    }
  }

  private structItem(node: Node, attrs: Attributes): StructItem {
    const span = this.span(node);
    const body = node.childForFieldName('body');
    let shape: StructItem['shape'] = 'unit';
    let fields: FieldAst[] = [];
    if (body?.type === 'field_declaration_list') {
      shape = 'named';
      fields = this.namedFields(body);
    } else if (body?.type === 'ordered_field_declaration_list') {
      shape = 'tuple';
      fields = this.orderedFields(body);
    }
    if (node.namedChildren.some((child) => child.type === 'where_clause') && this.generics(node).where.length > 0) {
      // Bounds on a struct only restrict its uses, which the impl blocks repeat.
    }
    return {
      kind: 'struct',
      name: this.field(node, 'name').text,
      span,
      vis: this.visibility(node),
      generics: this.generics(node),
      shape,
      fields,
      attrs,
    };
  }

  private namedFields(body: Node): FieldAst[] {
    const fields: FieldAst[] = [];
    for (const child of body.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'attribute_item') unavailable(this.span(child), `属性（${child.text}）`);
      if (child.type !== 'field_declaration') continue;
      fields.push({
        name: this.field(child, 'name').text,
        type: this.type(this.field(child, 'type')),
        vis: this.visibility(child),
        span: this.span(child),
      });
    }
    return fields;
  }

  private orderedFields(body: Node): FieldAst[] {
    const fields: FieldAst[] = [];
    let vis: Visibility = 'private';
    for (const child of body.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'visibility_modifier') {
        vis = 'pub';
        continue;
      }
      if (child.type === 'attribute_item') unavailable(this.span(child), `属性（${child.text}）`);
      fields.push({ name: String(fields.length), type: this.type(child), vis, span: this.span(child) });
      vis = 'private';
    }
    return fields;
  }

  // code-gauge-allow functionCognitiveComplexity 19 -- One case per kind of syntax node.
  private enumItem(node: Node, attrs: Attributes): EnumItem {
    const span = this.span(node);
    const variants: VariantAst[] = [];
    for (const child of this.field(node, 'body').namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'attribute_item') unavailable(this.span(child), `属性（${child.text}）`);
      if (child.type !== 'enum_variant') continue;
      const body = child.childForFieldName('body');
      const value = child.childForFieldName('value');
      variants.push({
        name: this.field(child, 'name').text,
        span: this.span(child),
        shape: body?.type === 'field_declaration_list' ? 'named' : body ? 'tuple' : 'unit',
        fields: body?.type === 'field_declaration_list' ? this.namedFields(body) : body ? this.orderedFields(body) : [],
        discriminant: value ? this.expr(value) : undefined,
      });
    }
    return {
      kind: 'enum',
      name: this.field(node, 'name').text,
      span,
      vis: this.visibility(node),
      generics: this.generics(node),
      variants,
      attrs,
    };
  }

  private traitItem(node: Node): TraitItem {
    const span = this.span(node);
    if (node.text.startsWith('unsafe')) unavailable(span, 'unsafe trait');
    const methods: FnItem[] = [];
    for (const child of this.field(node, 'body').namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'function_item') methods.push(this.fnItem(child));
      else if (child.type === 'function_signature_item') methods.push(this.fnItem(child, true));
      else if (child.type === 'associated_type') unavailable(this.span(child), '関連型（type Item;）');
      else if (child.type === 'const_item') unavailable(this.span(child), 'トレイトの関連定数');
      else if (child.type === 'attribute_item') unavailable(this.span(child), `属性（${child.text}）`);
      else if (child.type === 'macro_invocation') unavailable(this.span(child), 'トレイトの中のマクロ');
    }
    const bounds = node.childForFieldName('bounds');
    return {
      kind: 'trait',
      name: this.field(node, 'name').text,
      span,
      vis: this.visibility(node),
      generics: this.generics(node),
      supertraits: bounds ? this.bounds(bounds) : [],
      methods,
    };
  }

  // code-gauge-allow functionNcss 33 -- One case per kind of syntax node.
  private implItem(node: Node): ImplItem {
    const span = this.span(node);
    if (node.text.startsWith('unsafe')) unavailable(span, 'unsafe impl');
    if (/^impl\b[^{]*!/.test(node.text)) unavailable(span, '否定の実装（impl !Trait）');
    const trait = node.childForFieldName('trait');
    const methods: FnItem[] = [];
    const consts: ImplItem['consts'] = [];
    for (const child of node.childForFieldName('body')?.namedChildren ?? []) {
      if (isComment(child)) continue;
      if (child.type === 'function_item') methods.push(this.fnItem(child));
      else if (child.type === 'function_signature_item' && this.isStd) methods.push(this.fnItem(child, true));
      else if (child.type === 'const_item') consts.push(this.item(child) as ImplItem['consts'][number]);
      else if (child.type === 'type_item') unavailable(this.span(child), '関連型（type Item = ...;）');
      else if (child.type === 'attribute_item') unavailable(this.span(child), `属性（${child.text}）`);
      else if (child.type === 'function_signature_item') syntaxError(this.span(child), '関数の本体が足りません。');
      else if (child.type === 'macro_invocation') unavailable(this.span(child), 'impl の中のマクロ');
    }
    return {
      kind: 'impl',
      span,
      generics: this.generics(node),
      trait: trait ? this.typePath(trait) : undefined,
      selfType: this.type(this.field(node, 'type')),
      methods,
      consts,
    };
  }

  // code-gauge-allow functionCognitiveComplexity 27 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 42 -- One case per kind of syntax node.
  private useItem(node: Node): UseItem {
    const entries: UseItem['entries'] = [];
    const walk = (tree: Node, prefix: string[]): void => {
      const span = this.span(tree);
      switch (tree.type) {
        case 'identifier':
        case 'self':
        case 'crate':
        case 'super': {
          if (tree.type === 'self' && prefix.length > 0) {
            entries.push({ path: prefix, alias: undefined, glob: false, span });
          } else {
            entries.push({ path: [...prefix, tree.text], alias: undefined, glob: false, span });
          }
          return;
        }
        case 'scoped_identifier': {
          entries.push({ path: [...prefix, ...this.simplePath(tree)], alias: undefined, glob: false, span });
          return;
        }
        case 'use_as_clause': {
          const path = this.field(tree, 'path');
          const alias = this.field(tree, 'alias').text;
          entries.push({ path: [...prefix, ...this.simplePath(path)], alias, glob: false, span });
          return;
        }
        case 'use_wildcard': {
          const path = tree.namedChildren.find((child) => !isComment(child));
          entries.push({
            path: [...prefix, ...(path ? this.simplePath(path) : [])],
            alias: undefined,
            glob: true,
            span,
          });
          return;
        }
        case 'scoped_use_list': {
          const path = tree.childForFieldName('path');
          const next = [...prefix, ...(path ? this.simplePath(path) : [])];
          for (const child of this.field(tree, 'list').namedChildren) if (!isComment(child)) walk(child, next);
          return;
        }
        case 'use_list': {
          for (const child of tree.namedChildren) if (!isComment(child)) walk(child, prefix);
          return;
        }
        default: {
          unavailable(span, `use の書き方（${tree.text}）`);
        }
      }
    };
    walk(this.field(node, 'argument'), []);
    return { kind: 'use', span: this.span(node), vis: this.visibility(node), entries };
  }

  private simplePath(node: Node): string[] {
    if (node.type === 'scoped_identifier') {
      const path = node.childForFieldName('path');
      return [...(path ? this.simplePath(path) : []), this.field(node, 'name').text];
    }
    if (node.type === 'identifier' || node.type === 'self' || node.type === 'crate' || node.type === 'super') {
      return [node.text];
    }
    return unavailable(this.span(node), `パスの書き方（${node.text}）`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Types

  // code-gauge-allow functionNcss 48 -- One case per kind of syntax node.
  type(node: Node): TypeAst {
    const span = this.span(node);
    switch (node.type) {
      case 'primitive_type':
      case 'type_identifier':
      case 'scoped_type_identifier':
      case 'generic_type': {
        if (node.text === '_') return { kind: 'infer', span };
        return { kind: 'path', path: this.typePath(node), span };
      }
      case 'reference_type': {
        const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
        const lifetime = node.namedChildren.find((child) => child.type === 'lifetime')?.text;
        const type: TypeAst = { kind: 'ref', mutable, target: this.type(this.field(node, 'type')), lifetime, span };
        // `&&T` is one token, which stands for two references.
        return node.children[0]?.type === '&&' ? { kind: 'ref', mutable: false, target: type, span } : type;
      }
      case 'tuple_type': {
        return { kind: 'tuple', elems: node.namedChildren.filter((c) => !isComment(c)).map((c) => this.type(c)), span };
      }
      case 'unit_type': {
        return { kind: 'tuple', elems: [], span };
      }
      case 'array_type': {
        const length = node.childForFieldName('length');
        const elem = this.type(this.field(node, 'element'));
        return length ? { kind: 'array', elem, len: this.expr(length), span } : { kind: 'slice', elem, span };
      }
      case 'dynamic_type': {
        const trait = this.field(node, 'trait');
        return { kind: 'dyn', bounds: [this.bound(trait)], span };
      }
      case 'abstract_type': {
        const trait = this.field(node, 'trait');
        if (trait.type === 'bounded_type') unavailable(span, `複数の境界の impl Trait（${node.text}）`);
        return { kind: 'impl', bounds: [this.bound(trait)], span };
      }
      case 'function_type': {
        const bound = this.bound(node);
        if (bound.kind !== 'fn') unavailable(span, '関数ポインタの型（fn(i32) -> i32）');
        return { kind: 'fnBound', bound, span };
      }
      case 'never_type': {
        if (this.isStd) return { kind: 'never', span };
        return unavailable(span, '型 !');
      }
      case 'pointer_type': {
        return unavailable(span, '生ポインタ（*const T・*mut T）');
      }
      case 'bounded_type': {
        return unavailable(span, `境界を足した型（${node.text}）`);
      }
      case 'bracketed_type':
      case 'qualified_type': {
        return unavailable(span, `<T as Trait> の形の型`);
      }
      default: {
        return unavailable(span, `型の書き方（${node.text}）`);
      }
    }
  }

  /** A path to a type or trait, with the type arguments of its last segment. */
  typePath(node: Node): PathAst {
    const span = this.span(node);
    if (node.type === 'generic_type' || node.type === 'generic_type_with_turbofish') {
      const base = this.typePath(this.field(node, 'type'));
      const typeArguments = this.field(node, 'type_arguments');
      const args = this.typeArgs(typeArguments, true);
      const lifetimes = typeArguments.namedChildren
        .filter((child) => child.type === 'lifetime')
        .map((child) => child.text);
      const bindings = typeArguments.namedChildren
        .filter((child) => child.type === 'type_binding')
        .map((child) => ({
          name: this.field(child, 'name').text,
          type: this.type(this.field(child, 'type')),
          span: this.span(child),
        }));
      const last = base.segments.at(-1) as PathSegment;
      const segment = { ...last, args, lifetimes, ...(bindings.length > 0 && { bindings }) };
      return { segments: [...base.segments.slice(0, -1), segment], span };
    }
    if (node.type === 'scoped_type_identifier' || node.type === 'scoped_identifier') {
      const path = node.childForFieldName('path');
      const prefix = path ? this.exprPath(path).segments : [];
      const name = this.field(node, 'name');
      return { segments: [...prefix, { name: name.text, args: undefined, span: this.span(name) }], span };
    }
    if (
      node.type === 'type_identifier' ||
      node.type === 'primitive_type' ||
      node.type === 'identifier' ||
      node.type === 'self' ||
      node.type === 'crate' ||
      node.type === 'super'
    ) {
      return { segments: [{ name: node.text, args: undefined, span }], span };
    }
    if (node.type === 'function_type') unavailable(span, '関数ポインタの型（fn(i32) -> i32）');
    return unavailable(span, `型の書き方（${node.text}）`);
  }

  /** The type arguments, without the lifetimes and the associated types (`Item = i32`) that the caller takes. */
  private typeArgs(node: Node, allowBindings = false): TypeAst[] {
    const args: TypeAst[] = [];
    for (const child of node.namedChildren) {
      if (isComment(child) || child.type === 'lifetime') continue;
      if (child.type === 'type_binding') {
        if (allowBindings) continue;
        unavailable(this.span(child), `関連型の指定（${child.text}）`);
      }
      if (child.type === 'block' || child.type.endsWith('_literal')) {
        unavailable(this.span(child), '定数の型引数');
      }
      args.push(this.type(child));
    }
    return args;
  }

  /** A path in an expression, whose segments may carry turbofish arguments (`Vec::<i32>::new`). */
  exprPath(node: Node): PathAst {
    const span = this.span(node);
    switch (node.type) {
      case 'identifier':
      case 'self':
      case 'crate':
      case 'super':
      case 'type_identifier':
      case 'primitive_type': {
        return { segments: [{ name: node.text, args: undefined, span }], span };
      }
      case 'scoped_identifier':
      case 'scoped_type_identifier': {
        const path = node.childForFieldName('path');
        const prefix = path ? this.exprPath(path).segments : [];
        if (!path && node.text.startsWith('::')) unavailable(span, '先頭が :: のパス');
        const name = this.field(node, 'name');
        return { segments: [...prefix, { name: name.text, args: undefined, span: this.span(name) }], span };
      }
      case 'generic_type':
      case 'generic_type_with_turbofish': {
        return this.typePath(node);
      }
      case 'generic_function': {
        const base = this.exprPath(this.field(node, 'function'));
        const args = this.typeArgs(this.field(node, 'type_arguments'));
        const last = base.segments.at(-1) as PathSegment;
        return { segments: [...base.segments.slice(0, -1), { ...last, args }], span };
      }
      case 'bracketed_type': {
        return unavailable(span, '<T as Trait>:: の形のパス');
      }
      default: {
        return unavailable(span, `パスの書き方（${node.text}）`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Statements

  // code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 44 -- One case per kind of syntax node.
  block(node: Node): Block {
    const span = this.span(node);
    const stmts: Stmt[] = [];
    const items: Item[] = [];
    let tail: Expr | undefined;
    const children = node.namedChildren.filter((child) => !isComment(child));
    for (const [index, child] of children.entries()) {
      const isLast = index === children.length - 1;
      if (child.type === 'label') unavailable(this.span(child), "ラベル付きのブロック（'a: { ... }）");
      if (child.type === 'let_declaration') {
        stmts.push(this.letStmt(child));
      } else if (child.type === 'expression_statement') {
        const inner = child.namedChildren.find((c) => !isComment(c)) as Node;
        const semi = child.text.trimEnd().endsWith(';') && !inner.text.endsWith(';');
        const expr = this.expr(inner);
        stmts.push({ kind: 'expr', expr, semi: semi || child.lastChild?.type === ';', span: this.span(child) });
      } else if (child.type === 'empty_statement') {
        stmts.push({ kind: 'empty', span: this.span(child) });
      } else if (isItem(child)) {
        const item = this.item(child);
        if (item) items.push(item);
      } else if (isLast) {
        tail = this.expr(child);
      } else if (child.type === 'macro_invocation') {
        stmts.push({ kind: 'expr', expr: this.expr(child), semi: false, span: this.span(child) });
      } else {
        stmts.push({ kind: 'expr', expr: this.expr(child), semi: false, span: this.span(child) });
      }
    }
    // An expression statement without a semicolon at the end of a block gives the block its value.
    if (!tail) {
      const last = stmts.at(-1);
      if (last?.kind === 'expr' && !last.semi && last.expr.kind === 'macro') {
        stmts.pop();
        tail = last.expr;
      } else if (last?.kind === 'expr' && !last.semi && isBlockLike(last.expr)) {
        stmts.pop();
        tail = last.expr;
      }
    }
    return { kind: 'block', stmts, tail, span, endRow: node.endPosition.row, items };
  }

  private letStmt(node: Node): Stmt {
    const span = this.span(node);
    let pattern = this.pattern(this.field(node, 'pattern'));
    if (node.namedChildren.some((child) => child.type === 'mutable_specifier')) {
      if (pattern.kind !== 'binding') syntaxError(span, 'mut は名前の前に書いてください。');
      pattern = { ...pattern, mutable: true };
    }
    const type = node.childForFieldName('type');
    const value = node.childForFieldName('value');
    const alternative = node.childForFieldName('alternative');
    return {
      kind: 'let',
      pattern,
      type: type ? this.type(type) : undefined,
      init: value ? this.expr(value) : undefined,
      else: alternative ? this.block(alternative) : undefined,
      span,
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Expressions

  expr(node: Node): Expr {
    const span = this.span(node);
    switch (node.type) {
      case 'integer_literal': {
        const literal = parseIntegerLiteral(node.text);
        if (!literal) syntaxError(span, `整数の書き方（${node.text}）に誤りがあります。`);
        if (literal.kind === 'float') {
          return { kind: 'float', value: literal.value, f32: literal.f32, suffix: literal.suffix, span };
        }
        return { kind: 'int', value: literal.value, suffix: literal.suffix, span };
      }
      case 'float_literal': {
        const literal = parseFloatLiteral(node.text);
        if (!literal) syntaxError(span, `小数の書き方（${node.text}）に誤りがあります。`);
        return { kind: 'float', value: literal.value, f32: literal.f32, suffix: literal.suffix, span };
      }
      case 'boolean_literal': {
        return { kind: 'bool', value: node.text === 'true', span };
      }
      case 'char_literal': {
        if (node.text.startsWith('b')) {
          const value = parseCharLiteral(node.text.slice(1));
          if (value === undefined || value.codePointAt(0)! > 0x7f)
            syntaxError(span, `バイトのリテラル（${node.text}）に誤りがあります。`);
          return { kind: 'int', value: BigInt(value.codePointAt(0)!), suffix: 'u8', span };
        }
        const value = parseCharLiteral(node.text);
        if (value === undefined) syntaxError(span, `文字の書き方（${node.text}）に誤りがあります。`);
        return { kind: 'char', value, span };
      }
      case 'string_literal': {
        if (node.text.startsWith('b')) unavailable(span, 'バイト文字列（b"..."）');
        if (node.text.startsWith('c')) unavailable(span, 'C の文字列（c"..."）');
        const value = parseStringLiteral(node.text);
        if (value === undefined) syntaxError(span, `文字列の書き方（${node.text}）に誤りがあります。`);
        return { kind: 'str', value, span };
      }
      case 'raw_string_literal': {
        return unavailable(span, '生の文字列（r"..."）');
      }
      case 'identifier':
      case 'self':
      case 'scoped_identifier':
      case 'generic_function':
      case 'crate':
      case 'super': {
        if (node.type === 'generic_function') {
          const fn = this.field(node, 'function');
          if (fn.type === 'field_expression') {
            // A method with turbofish arguments; the call converts it.
            syntaxError(span, 'メソッドは、呼び出す形（x.f::<T>()）で書いてください。');
          }
        }
        if (node.type === 'crate' || node.type === 'super') syntaxError(span, `${node.text} だけでは値になりません。`);
        return { kind: 'path', path: this.exprPath(node), span };
      }
      case 'parenthesized_expression': {
        return this.expr(this.onlyChild(node));
      }
      case 'unary_expression': {
        const op = node.child(0)?.text as '-' | '!' | '*';
        return { kind: 'unary', op, operand: this.expr(this.onlyChild(node)), span };
      }
      case 'binary_expression': {
        const operator = this.field(node, 'operator');
        return {
          kind: 'binary',
          op: operator.text as BinaryOp,
          left: this.expr(this.field(node, 'left')),
          right: this.expr(this.field(node, 'right')),
          opSpan: this.span(operator),
          span,
        };
      }
      case 'assignment_expression': {
        return {
          kind: 'assign',
          target: this.assignee(this.field(node, 'left')),
          value: this.expr(this.field(node, 'right')),
          span,
        };
      }
      case 'compound_assignment_expr': {
        const operator = this.field(node, 'operator').text;
        return {
          kind: 'compoundAssign',
          op: operator.slice(0, -1) as never,
          target: this.expr(this.field(node, 'left')),
          value: this.expr(this.field(node, 'right')),
          span,
        };
      }
      case 'reference_expression': {
        if (/^&\s*raw\b/.test(node.text)) unavailable(span, '&raw');
        const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
        const ref: Expr = { kind: 'ref', mutable, operand: this.expr(this.field(node, 'value')), span };
        // `&&x` is one token, which stands for two borrows.
        if (node.children[0]?.type === '&&') return { kind: 'ref', mutable: false, operand: ref, span };
        return ref;
      }
      case 'type_cast_expression': {
        return {
          kind: 'cast',
          operand: this.expr(this.field(node, 'value')),
          type: this.type(this.field(node, 'type')),
          span,
        };
      }
      case 'call_expression': {
        return this.call(node);
      }
      case 'field_expression': {
        const fieldNode = this.field(node, 'field');
        if (fieldNode.type === 'integer_literal' && !/^\d+$/.test(fieldNode.text)) {
          syntaxError(span, `タプルの要素の番号（${fieldNode.text}）に誤りがあります。`);
        }
        return {
          kind: 'field',
          operand: this.expr(this.field(node, 'value')),
          name: fieldNode.text,
          nameSpan: this.span(fieldNode),
          span,
        };
      }
      case 'index_expression': {
        const [operand, index] = node.namedChildren.filter((child) => !isComment(child));
        const bracket = node.children.find((child) => child.type === '[');
        return {
          kind: 'index',
          operand: this.expr(operand),
          index: this.expr(index),
          bracketSpan: bracket ? this.span(bracket) : span,
          span,
        };
      }
      case 'range_expression': {
        const children = node.namedChildren.filter((child) => !isComment(child));
        const operatorIndex = node.children.findIndex((child) => child.type === '..' || child.type === '..=');
        const operator = node.children[operatorIndex];
        if (operator.type === '...' || node.text.includes('...'))
          syntaxError(span, '... ではなく ..= と書いてください。');
        let start: Expr | undefined;
        let end: Expr | undefined;
        for (const child of children) {
          if (child.startIndex < operator.startIndex) start = this.expr(child);
          else end = this.expr(child);
        }
        const inclusive = operator.type === '..=';
        if (inclusive && !end) syntaxError(span, '..= の後には終わりの値が要ります。');
        return { kind: 'range', start, end, inclusive, span };
      }
      case 'tuple_expression': {
        const elems = node.namedChildren.filter((child) => !isComment(child) && child.type !== 'attribute_item');
        return { kind: 'tuple', elems: elems.map((child) => this.expr(child)), span };
      }
      case 'unit_expression': {
        return { kind: 'tuple', elems: [], span };
      }
      case 'array_expression': {
        const length = node.childForFieldName('length');
        const elems = node.namedChildren.filter((child) => !isComment(child) && child.id !== length?.id);
        if (length) return { kind: 'arrayRepeat', value: this.expr(elems[0]), count: this.expr(length), span };
        return { kind: 'array', elems: elems.map((child) => this.expr(child)), span };
      }
      case 'struct_expression': {
        return this.structExpr(node);
      }
      case 'block': {
        return this.block(node);
      }
      case 'if_expression':
      case 'else_clause': {
        return this.ifExpr(node);
      }
      case 'match_expression': {
        return this.matchExpr(node);
      }
      case 'loop_expression': {
        return { kind: 'loop', label: this.label(node), body: this.block(this.field(node, 'body')), span };
      }
      case 'while_expression': {
        return {
          kind: 'while',
          label: this.label(node),
          cond: this.condition(this.field(node, 'condition')),
          body: this.block(this.field(node, 'body')),
          span,
        };
      }
      case 'for_expression': {
        return {
          kind: 'for',
          label: this.label(node),
          pattern: this.pattern(this.field(node, 'pattern')),
          iterable: this.expr(this.field(node, 'value')),
          body: this.block(this.field(node, 'body')),
          span,
        };
      }
      case 'break_expression': {
        const value = node.namedChildren.find((child) => child.type !== 'label' && !isComment(child));
        return { kind: 'break', label: this.label(node), value: value ? this.expr(value) : undefined, span };
      }
      case 'continue_expression': {
        return { kind: 'continue', label: this.label(node), span };
      }
      case 'return_expression': {
        const value = node.namedChildren.find((child) => !isComment(child));
        return { kind: 'return', value: value ? this.expr(value) : undefined, span };
      }
      case 'closure_expression': {
        return this.closure(node);
      }
      case 'try_expression': {
        return { kind: 'try', operand: this.expr(this.onlyChild(node)), span };
      }
      case 'macro_invocation': {
        return { kind: 'macro', macro: this.macro(node), span };
      }
      case 'await_expression': {
        return unavailable(span, '.await');
      }
      case 'async_block': {
        return unavailable(span, 'async ブロック');
      }
      case 'unsafe_block': {
        return unavailable(span, 'unsafe ブロック');
      }
      case 'const_block': {
        return unavailable(span, 'const ブロック');
      }
      case 'gen_block': {
        return unavailable(span, 'gen ブロック');
      }
      case 'try_block': {
        return unavailable(span, 'try ブロック');
      }
      case 'yield_expression': {
        return unavailable(span, 'yield');
      }
      case 'become_expression': {
        return unavailable(span, 'become');
      }
      case 'attributed_expression': {
        return unavailable(span, '式に付けた属性');
      }
      case 'let_condition':
      case 'let_chain': {
        return syntaxError(span, 'let は if や while の条件にだけ書けます。');
      }
      case 'generic_type':
      case 'type_identifier':
      case 'primitive_type': {
        return { kind: 'path', path: this.exprPath(node), span };
      }
      default: {
        if (node.isError || node.isMissing) syntaxError(span, '書き方に誤りがあります。');
        return unavailable(span, `この書き方（${node.type}）`);
      }
    }
  }

  /** The left side of an assignment, where `_` discards the value and tuples assign each element. */
  private assignee(node: Node): Expr {
    if (node.type === 'identifier' && node.text === '_') {
      return {
        kind: 'path',
        path: { segments: [{ name: '_', args: undefined, span: this.span(node) }], span: this.span(node) },
        span: this.span(node),
      };
    }
    if (node.type === 'tuple_expression' || node.type === 'struct_expression' || node.type === 'call_expression') {
      unavailable(this.span(node), '分割代入（(a, b) = ...）');
    }
    return this.expr(node);
  }

  private onlyChild(node: Node): Node {
    const child = node.namedChildren.find((c) => !isComment(c));
    if (!child) syntaxError(this.span(node), '書き方に誤りがあります。');
    return child;
  }

  private label(node: Node): string | undefined {
    const label = node.namedChildren.find((child) => child.type === 'label');
    return label?.text.slice(1);
  }

  private call(node: Node): Expr {
    const span = this.span(node);
    const fn = this.field(node, 'function');
    const args = this.field(node, 'arguments')
      .namedChildren.filter((child) => !isComment(child))
      .map((child) => {
        if (child.type === 'attribute_item') unavailable(this.span(child), '引数に付けた属性');
        return this.expr(child);
      });
    if (
      fn.type === 'field_expression' ||
      (fn.type === 'generic_function' && this.field(fn, 'function').type === 'field_expression')
    ) {
      const access = fn.type === 'field_expression' ? fn : this.field(fn, 'function');
      const methodNode = this.field(access, 'field');
      if (methodNode.type === 'integer_literal') syntaxError(span, 'タプルの要素は呼び出せません。');
      return {
        kind: 'methodCall',
        receiver: this.expr(this.field(access, 'value')),
        method: methodNode.text,
        turbofish: fn.type === 'generic_function' ? this.typeArgs(this.field(fn, 'type_arguments')) : undefined,
        args,
        methodSpan: this.span(methodNode),
        span,
      };
    }
    return { kind: 'call', callee: this.expr(fn), args, span };
  }

  private structExpr(node: Node): Expr {
    const span = this.span(node);
    const nameNode = this.field(node, 'name');
    const path =
      nameNode.type === 'generic_type_with_turbofish' || nameNode.type === 'generic_type'
        ? this.typePath(nameNode)
        : this.exprPath(nameNode);
    const fields: { name: string; value: Expr; span: Span }[] = [];
    let base: Expr | undefined;
    for (const child of this.field(node, 'body').namedChildren) {
      if (isComment(child)) continue;
      const childSpan = this.span(child);
      if (child.type === 'shorthand_field_initializer') {
        const name = this.onlyChild(child);
        fields.push({
          name: name.text,
          value: { kind: 'path', path: this.exprPath(name), span: childSpan },
          span: childSpan,
        });
      } else if (child.type === 'field_initializer') {
        const field = this.field(child, 'field');
        fields.push({ name: field.text, value: this.expr(this.field(child, 'value')), span: childSpan });
      } else if (child.type === 'base_field_initializer') {
        base = this.expr(this.onlyChild(child));
      } else if (child.type === 'attribute_item') {
        unavailable(childSpan, 'フィールドに付けた属性');
      }
    }
    return { kind: 'struct', path, fields, base, span };
  }

  /**
   * An `if` with its `else if` and `else` clauses, which the grammar lists side by side as `alternative`s of the
   * `if_expression`.
   */
  private ifExpr(node: Node): Expr {
    const span = this.span(node);
    const alternatives = node.childrenForFieldName('alternative');
    let elseExpr: Expr | undefined;
    for (const alternative of alternatives.toReversed()) {
      const condition = alternative.childForFieldName('condition');
      const consequence = this.block(this.field(alternative, 'consequence'));
      if (!condition) {
        elseExpr = consequence;
        continue;
      }
      elseExpr = {
        kind: 'if',
        cond: this.condition(condition),
        consequent: consequence,
        else: elseExpr,
        span: this.span(alternative),
      };
    }
    return {
      kind: 'if',
      cond: this.condition(this.field(node, 'condition')),
      consequent: this.block(this.field(node, 'consequence')),
      else: elseExpr,
      span,
    };
  }

  private condition(node: Node): Condition {
    if (node.type === 'let_condition') {
      return {
        kind: 'let',
        pattern: this.pattern(this.field(node, 'pattern')),
        value: this.expr(this.field(node, 'value')),
        span: this.span(node),
      };
    }
    if (node.type === 'let_chain') unavailable(this.span(node), 'let の連鎖（if let ... && ...）');
    return { kind: 'expr', expr: this.expr(node) };
  }

  private matchExpr(node: Node): Expr {
    const span = this.span(node);
    const arms: MatchArm[] = [];
    const body = this.field(node, 'body');
    for (const arm of body.namedChildren) {
      if (arm.type !== 'match_arm') {
        if (arm.type === 'attribute_item') unavailable(this.span(arm), '腕に付けた属性');
        continue;
      }
      const matchPattern = this.field(arm, 'pattern');
      if (matchPattern.childForFieldName('condition')) unavailable(this.span(matchPattern), 'match の腕のガード（if）');
      const inner = matchPattern.namedChildren.find((child) => !isComment(child));
      const pattern: Pattern = inner ? this.pattern(inner) : { kind: 'wild', span: this.span(matchPattern) };
      arms.push({ pattern, body: this.expr(this.field(arm, 'value')), span: this.span(arm) });
    }
    return { kind: 'match', scrutinee: this.expr(this.field(node, 'value')), arms, endRow: node.endPosition.row, span };
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of syntax node.
  private closure(node: Node): Expr {
    const span = this.span(node);
    if (/^\s*(static|async)\b/.test(node.text)) unavailable(span, `${node.text.split(/\s/)[0]} クロージャ`);
    const isMove = node.children.some((child) => child.type === 'move');
    const params: { pattern: Pattern; type: TypeAst | undefined; span: Span }[] = [];
    // `_` is an anonymous token among the parameters.
    for (const child of this.field(node, 'parameters').children) {
      if (isComment(child) || (!child.isNamed && child.type !== '_')) continue;
      if (child.type === 'parameter') {
        let pattern = this.pattern(this.field(child, 'pattern'));
        if (child.namedChildren.some((c) => c.type === 'mutable_specifier') && pattern.kind === 'binding') {
          pattern = { ...pattern, mutable: true };
        }
        params.push({ pattern, type: this.type(this.field(child, 'type')), span: this.span(child) });
      } else {
        params.push({ pattern: this.closureParam(child), type: undefined, span: this.span(child) });
      }
    }
    const ret = node.childForFieldName('return_type');
    const body = this.field(node, 'body');
    if (ret && body.type !== 'block') syntaxError(span, '戻り値の型を書いたクロージャの本体は { } で囲んでください。');
    return { kind: 'closure', isMove, params, ret: ret ? this.type(ret) : undefined, body: this.expr(body), span };
  }

  /** An untyped closure parameter, which may be `mut x` as a function's parameter may. */
  private closureParam(node: Node): Pattern {
    const inner =
      node.type === 'mut_pattern' ? node.namedChildren.find((child) => child.type === 'identifier') : undefined;
    if (!inner) return this.pattern(node);
    const pattern = this.pattern(inner);
    return pattern.kind === 'binding' ? { ...pattern, mutable: true } : pattern;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Patterns

  pattern(node: Node): Pattern {
    const span = this.span(node);
    switch (node.type) {
      case 'identifier': {
        if (node.text === '_') return { kind: 'wild', span };
        checkNotReserved(node.text, span);
        return { kind: 'binding', name: node.text, mutable: false, sub: undefined, span };
      }
      case 'scoped_identifier': {
        return { kind: 'path', path: this.exprPath(node), span };
      }
      case 'integer_literal':
      case 'float_literal':
      case 'boolean_literal':
      case 'char_literal':
      case 'string_literal':
      case 'raw_string_literal': {
        return { kind: 'lit', expr: this.expr(node), span };
      }
      case 'negative_literal': {
        const literal = this.expr(this.onlyChild(node));
        if (literal.kind !== 'int' && literal.kind !== 'float') syntaxError(span, 'パターンの書き方に誤りがあります。');
        const negated =
          literal.kind === 'float'
            ? { ...literal, value: -literal.value, f32: -literal.f32 }
            : { ...literal, value: -literal.value };
        return { kind: 'lit', expr: negated, span };
      }
      case 'tuple_pattern': {
        return { kind: 'tuple', elems: this.subpatterns(node).map((child) => this.pattern(child)), span };
      }
      case 'tuple_struct_pattern': {
        const type = this.field(node, 'type');
        const elems = this.subpatterns(node).filter((child) => child.id !== type.id);
        return { kind: 'tupleStruct', path: this.exprPath(type), elems: elems.map((c) => this.pattern(c)), span };
      }
      case 'struct_pattern': {
        const type = this.field(node, 'type');
        const fields: { name: string; pattern: Pattern; span: Span }[] = [];
        for (const child of node.namedChildren) {
          if (child.id === type.id || isComment(child)) continue;
          if (child.type === 'remaining_field_pattern') unavailable(this.span(child), '残りのフィールドを省く ..');
          if (child.type !== 'field_pattern') continue;
          const name = this.field(child, 'name');
          const sub = child.childForFieldName('pattern');
          const childSpan = this.span(child);
          if (child.namedChildren.some((c) => c.type === 'mutable_specifier') || /^\s*ref\b/.test(child.text)) {
            unavailable(childSpan, 'フィールドのパターンの mut・ref');
          }
          fields.push({
            name: name.text,
            pattern: sub
              ? this.pattern(sub)
              : { kind: 'binding', name: name.text, mutable: false, sub: undefined, span: childSpan },
            span: childSpan,
          });
        }
        return { kind: 'struct', path: this.typePath(type), fields, span };
      }
      case 'reference_pattern': {
        const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
        const inner = node.namedChildren.find((child) => child.type !== 'mutable_specifier' && !isComment(child));
        if (!inner) syntaxError(span, 'パターンの書き方に誤りがあります。');
        const pattern: Pattern = { kind: 'ref', mutable, pattern: this.pattern(inner), span };
        // `&&x` is one token, which stands for two reference patterns.
        if (node.children[0]?.type === '&&') return { kind: 'ref', mutable: false, pattern, span };
        return pattern;
      }
      case 'or_pattern': {
        const alternatives: Pattern[] = [];
        for (const child of node.namedChildren) {
          if (isComment(child)) continue;
          const pattern = this.pattern(child);
          if (pattern.kind === 'or') alternatives.push(...pattern.alternatives);
          else alternatives.push(pattern);
        }
        return { kind: 'or', alternatives, span };
      }
      case 'match_pattern': {
        const inner = node.namedChildren.find((child) => !isComment(child));
        return inner ? this.pattern(inner) : { kind: 'wild', span };
      }
      case '_': {
        return { kind: 'wild', span };
      }
      case 'remaining_field_pattern': {
        return unavailable(span, '残りの要素を省く ..');
      }
      case 'range_pattern': {
        return unavailable(span, '範囲のパターン（1..=5）');
      }
      case 'captured_pattern': {
        return unavailable(span, '@ で名前を付けるパターン');
      }
      case 'ref_pattern': {
        return unavailable(span, 'ref パターン');
      }
      case 'mut_pattern': {
        return unavailable(span, 'パターンの中の mut');
      }
      case 'slice_pattern': {
        return unavailable(span, 'スライスのパターン（[a, b]）');
      }
      case 'box_pattern': {
        return unavailable(span, 'box パターン');
      }
      case 'generic_pattern': {
        return unavailable(span, '型引数を書いたパターン');
      }
      case 'self': {
        return syntaxError(span, 'self はパターンに書けません。');
      }
      default: {
        if (node.isError || node.isMissing) syntaxError(span, '書き方に誤りがあります。');
        return unavailable(span, `パターンの書き方（${node.type}）`);
      }
    }
  }

  /** `_` is an anonymous token, so the element patterns are the named children and the `_` tokens. */
  private subpatterns(node: Node): Node[] {
    return node.children.filter((child) => (child.isNamed || child.type === '_') && !isComment(child));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Macros

  private macro(node: Node): MacroCall {
    const span = this.span(node);
    const macroNode = this.field(node, 'macro');
    if (macroNode.type !== 'identifier') {
      const name = macroNode.text.replace(/^(std|core|alloc)::/, '');
      if (name.includes('::')) unavailable(span, `マクロ ${macroNode.text}!`);
    }
    const name = macroNode.text.replace(/^(std|core|alloc)::/, '');
    const tree = node.namedChildren.find((child) => child.type === 'token_tree');
    if (!tree) syntaxError(span, `${name}! の引数が足りません。`);
    switch (name) {
      case 'println':
      case 'print':
      case 'eprintln':
      case 'eprint': {
        const args = this.macroArgs(tree);
        const newline = name.endsWith('ln');
        if (args.length === 0) {
          if (!newline) syntaxError(span, `${name}! には、書式の文字列が要ります。`);
          return { kind: 'print', stream: name.startsWith('e') ? 'stderr' : 'stdout', newline, format: undefined };
        }
        return {
          kind: 'print',
          stream: name.startsWith('e') ? 'stderr' : 'stdout',
          newline,
          format: this.formatArgs(args, span, name),
        };
      }
      case 'format': {
        const args = this.macroArgs(tree);
        if (args.length === 0) syntaxError(span, 'format! には、書式の文字列が要ります。');
        return { kind: 'format', format: this.formatArgs(args, span, name) };
      }
      case 'write':
      case 'writeln': {
        const args = this.macroArgs(tree);
        if (args.length === 0) syntaxError(span, `${name}! には、書き込む先が要ります。`);
        const [target, ...rest] = args;
        if (rest.length === 0 && name === 'write') syntaxError(span, 'write! には、書式の文字列が要ります。');
        return {
          kind: 'write',
          target: this.expr(target),
          newline: name === 'writeln',
          format: rest.length > 0 ? this.formatArgs(rest, span, name) : undefined,
        };
      }
      case 'panic':
      case 'unreachable':
      case 'todo':
      case 'unimplemented': {
        const args = this.macroArgs(tree);
        return { kind: 'panic', name, format: args.length > 0 ? this.formatArgs(args, span, name) : undefined };
      }
      case 'assert':
      case 'debug_assert': {
        const args = this.macroArgs(tree);
        if (args.length === 0) syntaxError(span, `${name}! には、条件が要ります。`);
        const [cond, ...rest] = args;
        return {
          kind: 'assert',
          cond: this.expr(cond),
          text: cond.text.replaceAll(/\s+/g, ' '),
          format: rest.length > 0 ? this.formatArgs(rest, span, name) : undefined,
        };
      }
      case 'assert_eq':
      case 'assert_ne':
      case 'debug_assert_eq':
      case 'debug_assert_ne': {
        const args = this.macroArgs(tree);
        if (args.length < 2) syntaxError(span, `${name}! には、比べる2つの値が要ります。`);
        const [left, right, ...rest] = args;
        return {
          kind: 'assertEq',
          equal: name.endsWith('eq'),
          left: this.expr(left),
          right: this.expr(right),
          format: rest.length > 0 ? this.formatArgs(rest, span, name) : undefined,
        };
      }
      case 'vec': {
        return this.vecMacro(tree, span);
      }
      case 'matches': {
        return this.matchesMacro(tree, span);
      }
      case 'dbg': {
        const args = this.macroArgs(tree);
        return {
          kind: 'dbg',
          args: args.map((arg) => this.expr(arg)),
          texts: args.map((arg) => arg.text.replaceAll(/\s+/g, ' ')),
        };
      }
      default: {
        return unavailable(span, `マクロ ${name}!`);
      }
    }
  }

  /** The comma-separated arguments of a macro, reparsed as expressions at their places in the source. */
  private macroArgs(tree: Node): Node[] {
    const open = tree.text[0];
    if (open !== '(' && open !== '[' && open !== '{') syntaxError(this.span(tree), '書き方に誤りがあります。');
    const inner = tree.text.slice(1, -1);
    const prefix = this.prefixFor(tree);
    return this.reparse(
      `${prefix}(${inner}${inner.trim() === '' || inner.trimEnd().endsWith(',') ? '' : ','});`,
      (root) => {
        const statement = root.namedChildren.find((child) => !isComment(child));
        const expression = statement?.type === 'expression_statement' ? statement.namedChildren[0] : statement;
        if (!expression) return [];
        if (expression.type === 'unit_expression') return [];
        if (expression.type === 'tuple_expression') return expression.namedChildren.filter((c) => !isComment(c));
        if (expression.type === 'parenthesized_expression') return [this.onlyChild(expression)];
        syntaxError(this.span(tree), '書き方に誤りがあります。');
      }
    ) as Node[];
  }

  /** Spaces and newlines that place reparsed text where the token tree starts. */
  private prefixFor(tree: Node): string {
    const { row, column } = tree.startPosition;
    return '\n'.repeat(row) + ' '.repeat(column);
  }

  private vecMacro(tree: Node, span: Span): MacroCall {
    const inner = tree.text.slice(1, -1);
    return this.reparse(`${this.prefixFor(tree)}[${inner}];`, (root) => {
      const statement = root.namedChildren.find((child) => !isComment(child));
      const array = statement?.type === 'expression_statement' ? statement.namedChildren[0] : statement;
      if (array?.type !== 'array_expression') syntaxError(span, 'vec! の書き方に誤りがあります。');
      const expr = this.expr(array);
      if (expr.kind === 'arrayRepeat') return { kind: 'vecRepeat', value: expr.value, count: expr.count };
      if (expr.kind !== 'array') syntaxError(span, 'vec! の書き方に誤りがあります。');
      return { kind: 'vec', elems: expr.elems };
    }) as MacroCall;
  }

  private matchesMacro(tree: Node, span: Span): MacroCall {
    const inner = tree.text.slice(1, -1);
    const comma = topLevelComma(inner);
    if (comma < 0) syntaxError(span, 'matches! には、値とパターンが要ります。');
    const valueText = inner.slice(0, comma);
    const patternText = inner.slice(comma + 1).replace(/,\s*$/, '');
    const value = this.reparse(`${this.prefixFor(tree)} ${valueText};`, (root) => {
      const statement = root.namedChildren.find((child) => !isComment(child));
      const expression = statement?.type === 'expression_statement' ? statement.namedChildren[0] : statement;
      if (!expression) syntaxError(span, 'matches! の書き方に誤りがあります。');
      return this.expr(expression);
    }) as Expr;
    const pattern = this.reparse(`fn f() { match x { ${patternText} => {} } }`, (root) => {
      const arm = root.descendantsOfType('match_arm')[0];
      if (!arm) syntaxError(span, 'matches! の書き方に誤りがあります。');
      const matchPattern = this.field(arm, 'pattern');
      if (matchPattern.childForFieldName('condition')) unavailable(span, 'match の腕のガード（if）');
      const patternNode = matchPattern.namedChildren.find((child) => !isComment(child));
      return patternNode ? this.pattern(patternNode) : ({ kind: 'wild', span } as Pattern);
    }) as Pattern;
    return { kind: 'matches', value, pattern: withSpan(pattern, span) };
  }

  /** The format string and arguments of a formatting macro, with implicit named arguments (`{x}`) captured. */
  // code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of syntax node.
  private formatArgs(args: Node[], span: Span, macroName: string): FormatArgs {
    const [formatNode, ...rest] = args;
    if (formatNode.type === 'raw_string_literal') unavailable(this.span(formatNode), '生の文字列（r"..."）');
    if (formatNode.type !== 'string_literal' || formatNode.text.startsWith('b')) {
      if (macroName === 'panic' && args.length === 1) {
        syntaxError(span, 'panic! の引数は、書式の文字列にしてください。');
      }
      syntaxError(this.span(formatNode), `${macroName}! の最初の引数は、書式の文字列（"..."）にしてください。`);
    }
    const text = parseStringLiteral(formatNode.text);
    if (text === undefined) syntaxError(this.span(formatNode), '文字列の書き方に誤りがあります。');
    const positional: Expr[] = [];
    const named = new Map<string, number>();
    const exprs: Expr[] = [];
    for (const arg of rest) {
      if (arg.type === 'assignment_expression' && this.field(arg, 'left').type === 'identifier') {
        const name = this.field(arg, 'left').text;
        if (named.has(name)) syntaxError(this.span(arg), `名前付きの引数 ${name} が2回あります。`);
        named.set(name, exprs.length);
        exprs.push(this.expr(this.field(arg, 'right')));
      } else {
        if (named.size > 0) syntaxError(this.span(arg), '名前のない引数は、名前付きの引数より前に書いてください。');
        positional.push(this.expr(arg));
        exprs.push(positional.at(-1) as Expr);
      }
    }
    // Named arguments follow the positional ones, and `{}` may take them in turn too.
    return parseFormatString(text, exprs, exprs.length, named, span, this.span(formatNode));
  }

  private field(node: Node, name: string): Node {
    const child = node.childForFieldName(name);
    if (!child) syntaxError(this.span(node), '書き方に誤りがあります。');
    return child;
  }
}

/** Words that edition 2024 reserves, which tree-sitter's grammar still reads as names. */
const RESERVED_WORDS = new Set([
  'abstract',
  'async',
  'await',
  'become',
  'box',
  'do',
  'dyn',
  'final',
  'gen',
  'macro',
  'override',
  'priv',
  'try',
  'typeof',
  'unsized',
  'virtual',
  'yield',
]);

function checkNotReserved(name: string, span: Span): void {
  if (RESERVED_WORDS.has(name))
    syntaxError(span, `${name} は予約語なので、名前に使えません（r#${name} と書くか、名前を変えてください）。`);
}

function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}

const ITEM_TYPES = new Set([
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'impl_item',
  'const_item',
  'mod_item',
  'use_declaration',
  'attributed_declaration',
  'static_item',
  'type_item',
  'union_item',
  'macro_definition',
  'extern_crate_declaration',
  'foreign_mod_item',
  'attribute_item',
  'inner_attribute_item',
]);

function isItem(node: Node): boolean {
  return ITEM_TYPES.has(node.type);
}

function isBlockLike(expr: Expr): boolean {
  return ['block', 'if', 'match', 'loop', 'while', 'for'].includes(expr.kind);
}

function topLevelComma(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) return index;
  }
  return -1;
}

function withSpan(pattern: Pattern, span: Span): Pattern {
  const copy = { ...pattern, span } as Pattern;
  switch (copy.kind) {
    case 'tuple': {
      return { ...copy, elems: copy.elems.map((elem) => withSpan(elem, span)) };
    }
    case 'tupleStruct': {
      return { ...copy, elems: copy.elems.map((elem) => withSpan(elem, span)) };
    }
    case 'or': {
      return { ...copy, alternatives: copy.alternatives.map((alt) => withSpan(alt, span)) };
    }
    default: {
      return copy;
    }
  }
}
