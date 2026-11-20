// code-gauge-allow-file fileNcss 520 -- One method per kind of item, type, and path.
import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Attributes,
  BoundAst,
  Crate,
  EnumItem,
  FieldAst,
  FnItem,
  Generics,
  ImplItem,
  Item,
  Param,
  PathAst,
  PathSegment,
  SelfParam,
  StructItem,
  TraitItem,
  TypeAst,
  UseItem,
  VariantAst,
  Visibility,
} from './ast';
import { ExpressionConverter } from './convertExpressions';
import { checkNotReserved, isComment, syntaxError, unavailable, withoutDocAttributes } from './convertSyntax';

export { type Reparse, syntaxError, unavailable } from './convertSyntax';

const DERIVABLE = new Set(['Debug', 'Clone', 'Copy', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash', 'Default']);

/** Converts tree-sitter's concrete syntax tree to the AST, rejecting syntax this interpreter does not support. */
export class Converter extends ExpressionConverter {
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
  protected item(node: Node, attrs?: Attributes): Item | undefined {
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
          name: this.identifier(this.field(node, 'name')),
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
          name: this.identifier(this.field(node, 'name')),
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
        return {
          kind: 'mod',
          name: this.identifier(this.field(node, 'name')),
          span,
          vis: this.visibility(node),
          items,
        };
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
      if (isComment(child)) continue;
      if (child.type === 'attribute_item') this.attribute(child, attrs);
      else declaration = child;
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
    return this.visibilityModifier(modifier);
  }

  private visibilityModifier(modifier: Node): Visibility {
    if (modifier.text === 'pub') return 'pub';
    const scope = modifier.namedChildren.find((child) => !isComment(child))?.text;
    if (scope === 'self') return 'private';
    if (scope === 'super') return 'super';
    if (scope === 'crate') return 'pub';
    return unavailable(this.span(modifier), `公開の範囲の指定（${modifier.text}）`);
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- One case per kind of syntax node.
  // code-gauge-allow functionNcss 39 -- One case per kind of syntax node.
  private fnItem(node: Node, allowMissingBody = false): FnItem {
    const span = this.span(node);
    checkNotReserved(this.field(node, 'name').text, span);
    const modifiers = node.namedChildren.find((child) => child.type === 'function_modifiers');
    const isConst = this.isStd && modifiers?.text.trim() === 'const';
    if (modifiers && !isConst) {
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
      isConst,
      name: this.identifier(this.field(node, 'name')),
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

  // code-gauge-allow functionCognitiveComplexity 28 -- Type and lifetime parameters and where clauses use distinct Rust syntax.
  // code-gauge-allow functionNcss 34 -- One case per kind of syntax node.
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
      const defaultType = child.childForFieldName('default_type');
      if (defaultType && !this.isStd) unavailable(span, '型引数の既定の型');
      const bounds = child.childForFieldName('bounds');
      generics.params.push({
        name: this.identifier(this.field(child, 'name')),
        span,
        bounds: bounds ? this.bounds(bounds) : [],
        defaultType: defaultType ? this.type(defaultType) : undefined,
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
      name: this.identifier(this.field(node, 'name')),
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
        name: this.identifier(this.field(child, 'name')),
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
        vis = this.visibilityModifier(child);
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
        name: this.identifier(this.field(child, 'name')),
        span: this.span(child),
        shape: body?.type === 'field_declaration_list' ? 'named' : body ? 'tuple' : 'unit',
        fields: body?.type === 'field_declaration_list' ? this.namedFields(body) : body ? this.orderedFields(body) : [],
        discriminant: value ? this.expr(value) : undefined,
      });
    }
    return {
      kind: 'enum',
      name: this.identifier(this.field(node, 'name')),
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
    for (const syntax of this.field(node, 'body').namedChildren) {
      if (isComment(syntax)) continue;
      const child = withoutDocAttributes(syntax);
      if (child.type === 'function_item') methods.push(this.fnItem(child));
      else if (child.type === 'function_signature_item') methods.push(this.fnItem(child, true));
      else if (child.type === 'associated_type') unavailable(this.span(child), '関連型（type Item;）');
      else if (child.type === 'const_item') unavailable(this.span(child), 'トレイトの関連定数');
      else if (child.type === 'macro_invocation') unavailable(this.span(child), 'トレイトの中のマクロ');
      else this.unsupportedAssociatedItem(child);
    }
    const bounds = node.childForFieldName('bounds');
    return {
      kind: 'trait',
      name: this.identifier(this.field(node, 'name')),
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
    for (const syntax of node.childForFieldName('body')?.namedChildren ?? []) {
      if (isComment(syntax)) continue;
      const child = withoutDocAttributes(syntax);
      if (child.type === 'function_item') methods.push(this.fnItem(child));
      else if (child.type === 'function_signature_item' && this.isStd) methods.push(this.fnItem(child, true));
      else if (child.type === 'const_item') consts.push(this.item(child) as ImplItem['consts'][number]);
      else if (child.type === 'type_item') unavailable(this.span(child), '関連型（type Item = ...;）');
      else if (child.type === 'function_signature_item') syntaxError(this.span(child), '関数の本体が足りません。');
      else if (child.type === 'macro_invocation') unavailable(this.span(child), 'impl の中のマクロ');
      else this.unsupportedAssociatedItem(child);
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

  private unsupportedAssociatedItem(node: Node): never {
    const attr =
      node.type === 'attributed_declaration'
        ? node.namedChildren.find((child) => child.type === 'attribute_item' && !isComment(child))
        : node.type === 'attribute_item' || node.type === 'inner_attribute_item'
          ? node
          : undefined;
    if (attr) unavailable(this.span(attr), `属性（${attr.text}）`);
    return unavailable(this.span(node), `この書き方（${node.type}）`);
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
            entries.push({ path: [...prefix, this.identifier(tree)], alias: undefined, glob: false, span });
          }
          return;
        }
        case 'scoped_identifier': {
          entries.push({ path: [...prefix, ...this.simplePath(tree)], alias: undefined, glob: false, span });
          return;
        }
        case 'use_as_clause': {
          const path = this.field(tree, 'path');
          const alias = this.identifier(this.field(tree, 'alias'));
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
      return [...(path ? this.simplePath(path) : []), this.identifier(this.field(node, 'name'))];
    }
    if (node.type === 'identifier' || node.type === 'self' || node.type === 'crate' || node.type === 'super') {
      return [this.identifier(node)];
    }
    return unavailable(this.span(node), `パスの書き方（${node.text}）`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Types

  // code-gauge-allow functionNcss 49 -- One case per kind of syntax node.
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
          name: this.identifier(this.field(child, 'name')),
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
      return { segments: [...prefix, { name: this.identifier(name), args: undefined, span: this.span(name) }], span };
    }
    if (
      node.type === 'type_identifier' ||
      node.type === 'primitive_type' ||
      node.type === 'identifier' ||
      node.type === 'self' ||
      node.type === 'crate' ||
      node.type === 'super'
    ) {
      return { segments: [{ name: this.identifier(node), args: undefined, span }], span };
    }
    if (node.type === 'function_type') unavailable(span, '関数ポインタの型（fn(i32) -> i32）');
    return unavailable(span, `型の書き方（${node.text}）`);
  }

  /** The type arguments, without the lifetimes and the associated types (`Item = i32`) that the caller takes. */
  protected typeArgs(node: Node, allowBindings = false): TypeAst[] {
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
        return { segments: [{ name: this.identifier(node), args: undefined, span }], span };
      }
      case 'scoped_identifier':
      case 'scoped_type_identifier': {
        const path = node.childForFieldName('path');
        const prefix = path ? this.exprPath(path).segments : [];
        if (!path && node.text.startsWith('::')) unavailable(span, '先頭が :: のパス');
        const name = this.field(node, 'name');
        return { segments: [...prefix, { name: this.identifier(name), args: undefined, span: this.span(name) }], span };
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
}
