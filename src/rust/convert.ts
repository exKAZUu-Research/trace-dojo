// code-gauge-allow-file fileNcss -- One method per kind of item, type, and path.
import type { Node } from '@willbooster/web-tree-sitter';

import type {
  Attributes,
  Block,
  BoundAst,
  ConstItem,
  Crate,
  EnumItem,
  Expr,
  FieldAst,
  FnItem,
  Generics,
  ImplItem,
  Item,
  Param,
  PathAst,
  PathSegment,
  SelfParam,
  Span,
  StructItem,
  TraitItem,
  TypeAst,
  UseItem,
  VariantAst,
  Visibility,
} from './ast';
import { ExpressionConverter } from './convertExpressions';
import { isComment, splitAttributes, syntaxError, unavailable } from './convertSyntax';
import type { SelfWrapper } from './types';

export { type Reparse, syntaxError, unavailable } from './convertSyntax';

/** Converts tree-sitter's concrete syntax tree to the AST, rejecting syntax this interpreter does not support. */
export class Converter extends ExpressionConverter {
  convertCrate(root: Node): Crate {
    const items: Item[] = [];
    for (const child of root.namedChildren) {
      if (isComment(child)) continue;
      const isMacro =
        child.type === 'expression_statement' &&
        child.namedChildren.find((part) => !isComment(part))?.type === 'macro_invocation';
      if ((child.type === 'expression_statement' && !isMacro) || child.type === 'let_declaration') {
        syntaxError(this.span(child), '文は、関数の中に書いてください。');
      }
      // rustc skips a `#!` line at the start of the file, as Unix runs scripts with it.
      if (child.type === 'shebang') continue;
      if (child.type === 'frontmatter')
        syntaxError(this.span(child), 'フロントマター（---）は、不安定な機能なので使えません（E0658）。');
      items.push(...this.itemsOf(child));
    }
    return { items };
  }

  /** The items a node declares: one, none, or the items a macro invocation expands to. */
  private itemsOf(node: Node): Item[] {
    const invocation =
      node.type === 'expression_statement' ? node.namedChildren.find((child) => !isComment(child)) : node;
    if (invocation?.type === 'macro_invocation' && this.isUserMacro(invocation)) return this.userMacroItems(invocation);
    const item = this.item(node);
    return item ? [item] : [];
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Items

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  protected item(node: Node, attrs?: Attributes): Item | undefined {
    const span = this.span(node);
    switch (node.type) {
      case 'function_item': {
        return this.fnItem(node, false, attrs);
      }
      case 'struct_item': {
        return this.structItem(node, attrs ?? { derives: [] });
      }
      case 'union_item': {
        return { ...this.structItem(node, attrs ?? { derives: [] }), isUnion: true };
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
        return this.constItem(node, this.isStd);
      }
      case 'static_item': {
        return {
          kind: 'const',
          name: this.identifier(this.field(node, 'name')),
          span,
          vis: this.visibility(node),
          type: this.type(this.field(node, 'type')),
          value: this.expr(this.field(node, 'value')),
          isStatic: true,
          isMutable: node.namedChildren.some((child) => child.type === 'mutable_specifier'),
        };
      }
      case 'type_item': {
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
        const name = this.identifier(this.field(node, 'name'));
        this.modulePath.push(name);
        for (const child of body.namedChildren) {
          if (isComment(child)) continue;
          items.push(...this.itemsOf(child));
        }
        this.modulePath.pop();
        return {
          kind: 'mod',
          name,
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
        return syntaxError(span, '属性の後には、それを付ける項目を書いてください。');
      }
      case 'inner_attribute_item': {
        this.attributes.readInner(node);
        return undefined;
      }
      case 'empty_statement': {
        return undefined;
      }
      case 'macro_definition': {
        this.defineMacro(node);
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

  /** A constant; `allowMissingValue` for one of a trait, whose impls give its value. */
  private constItem(node: Node, allowMissingValue: boolean): ConstItem {
    const value = allowMissingValue ? node.childForFieldName('value') : this.field(node, 'value');
    return {
      kind: 'const',
      name: this.identifier(this.field(node, 'name')),
      span: this.span(node),
      vis: this.visibility(node),
      type: this.type(this.field(node, 'type')),
      value: value ? this.expr(value) : undefined,
    };
  }

  private unsupportedItem(node: Node): never {
    const span = this.span(node);
    const unstable: Record<string, string> = {
      decl_macro: 'macro によるマクロの定義',
      trait_alias: 'トレイトの別名',
    };
    if (Object.hasOwn(unstable, node.type))
      syntaxError(span, `${unstable[node.type]}は、不安定な機能なので使えません（E0658）。`);
    const names: Record<string, string> = {
      extern_crate_declaration: '外部のクレート（extern crate）',
      foreign_mod_item: '外部の関数の宣言（extern ブロック）',
      inner_attribute_item: `属性（${node.text.split('\n')[0]}）`,
      function_signature_item: '本体のない関数',
      macro_invocation: '関数の外のマクロの呼び出し',
    };
    return unavailable(span, names[node.type] ?? `この書き方（${node.type}）`);
  }

  private attributed(node: Node): Item | undefined {
    const { attributes, target } = splitAttributes(node);
    const attrs = this.attributes.read(attributes);
    if (!attrs || !target) return undefined;
    const declaration = target;
    const derivable = ['struct_item', 'enum_item', 'union_item'];
    if (attrs.derives.length > 0 && !derivable.includes(declaration.type)) {
      syntaxError(this.span(node), '#[derive] は、構造体と列挙型にだけ付けられます。');
    }
    if (attrs.isDefault) syntaxError(this.span(node), '#[default] は、列挙型の選択肢にだけ付けられます。');
    return this.item(declaration, attrs);
  }

  private visibility(node: Node): Visibility {
    const modifier = node.namedChildren.find((child) => child.type === 'visibility_modifier');
    if (!modifier) return 'private';
    return this.visibilityModifier(modifier);
  }

  private visibilityModifier(modifier: Node): Visibility {
    if (modifier.text === 'pub') return 'pub';
    const scopeNode = modifier.namedChildren.find((child) => !isComment(child));
    const scope = scopeNode?.text;
    if (scope === 'self') return 'private';
    if (scope === 'super') return 'super';
    if (scope === 'crate') return 'pub';
    if (scopeNode && /^pub\s*\(\s*in\b/.test(modifier.text)) {
      return { in: scopeNode.text.split('::').map((part) => part.trim()) };
    }
    return syntaxError(this.span(modifier), `公開の範囲の指定（${modifier.text}）の書き方に誤りがあります。`);
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  private fnItem(node: Node, allowMissingBody = false, attrs?: Attributes): FnItem {
    const span = this.span(node);
    const modifiers = node.namedChildren.find((child) => child.type === 'function_modifiers');
    const words = modifiers?.text.split(/\s+/) ?? [];
    const isConst = words.includes('const');
    const isUnsafe = words.includes('unsafe');
    const isAsync = words.includes('async');
    if (modifiers) {
      const text = modifiers.text;
      if (words.includes('extern')) unavailable(span, '外部から呼べる関数（extern fn）');
      if (words.some((word) => word && word !== 'const' && word !== 'unsafe' && word !== 'async')) {
        unavailable(span, `関数の修飾子（${text}）`);
      }
    }
    const parametersNode = this.field(node, 'parameters');
    let selfParam: SelfParam | undefined;
    const params: Param[] = [];
    for (const { node: child } of this.withAttributes(parametersNode.namedChildren)) {
      if (child.type === 'self_parameter') {
        if (selfParam || params.length > 0) syntaxError(this.span(child), 'self は、最初の引数に一度だけ書けます。');
        selfParam = this.selfParam(child);
      } else if (child.type === 'parameter' && this.field(child, 'pattern').type === 'self') {
        if (selfParam || params.length > 0) syntaxError(this.span(child), 'self は、最初の引数に一度だけ書けます。');
        selfParam = this.typedSelfParam(child);
      } else if (child.type === 'parameter') {
        params.push(this.param(child));
      } else if (child.type === 'variadic_parameter') {
        unavailable(this.span(child), '可変個の引数（...）');
      } else {
        syntaxError(this.span(child), '引数は「名前: 型」の形で書いてください。');
      }
    }
    const bodyNode = node.childForFieldName('body');
    if (!bodyNode && !allowMissingBody) syntaxError(span, '関数の本体（{ ... }）が足りません。');
    const ret = node.childForFieldName('return_type');
    const body = bodyNode ? this.inContext(isAsync, () => this.block(bodyNode)) : undefined;
    const retType = ret ? this.returnType(ret) : undefined;
    return {
      ...(isAsync ? asyncFunction(retType, body, span) : { ret: retType, body }),
      isAsync,
      kind: 'fn',
      isConst,
      isUnsafe,
      name: this.identifier(this.field(node, 'name')),
      span,
      vis: this.visibility(node),
      generics: this.generics(node),
      selfParam,
      params,
      endRow: node.endPosition.row,
      headerEndRow: bodyNode ? bodyNode.startPosition.row : node.endPosition.row,
      trackCaller: attrs?.trackCaller,
    };
  }

  /** A function's return type, which may be `!`, the one place stable Rust lets it be written. */
  private returnType(node: Node): TypeAst {
    return node.type === 'never_type' ? { kind: 'never', span: this.span(node) } : this.type(node);
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

  /** `self: Self`, `self: &Self`, `self: &mut Self`, `self: Box<Self>`, `self: Rc<Self>`, `self: Arc<Self>`, or `self: Pin<&mut Self>`. */
  private typedSelfParam(node: Node): SelfParam {
    const span = this.span(node);
    const type = this.field(node, 'type').text.replaceAll(/\s+/g, '');
    const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
    if (type === 'Self') return { mode: 'value', mutable, span };
    if (/^&('\w+)?Self$/.test(type)) return { mode: 'ref', mutable: false, span };
    if (/^&('\w+)?mutSelf$/.test(type)) return { mode: 'mutRef', mutable: false, span };
    const wrapper = /^(Box|Rc|Arc)<Self>$/.exec(type)?.[1] ?? (/^Pin<&('\w+)?mutSelf>$/.test(type) ? 'Pin' : undefined);
    if (wrapper) return { mode: 'value', wrapper: wrapper as SelfWrapper, mutable, span };
    return unavailable(span, `型を書いた self（self: ${type}）`);
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

  // code-gauge-allow functionCognitiveComplexity -- Type and lifetime parameters and where clauses use distinct Rust syntax.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  private generics(node: Node): Generics {
    const generics: Generics = { params: [], lifetimes: [], where: [] };
    const parameters = node.childForFieldName('type_parameters');
    for (const child of parameters?.namedChildren ?? []) {
      if (isComment(child)) continue;
      const span = this.span(child);
      if (child.type === 'lifetime_parameter') {
        const name = this.field(child, 'name').text;
        const bounds = child.childForFieldName('bounds');
        const outlives =
          bounds?.namedChildren.filter((part) => part.type === 'lifetime').map((part) => part.text) ?? [];
        if (outlives.length > 0) (generics.lifetimeBounds ??= []).push({ name, outlives });
        generics.lifetimes.push(name);
        continue;
      }
      if (child.type === 'const_parameter') {
        if (child.childForFieldName('value')) unavailable(span, '定数のジェネリクスの既定の値');
        generics.params.push({
          name: this.identifier(this.field(child, 'name')),
          span,
          bounds: [],
          constType: this.type(this.field(child, 'type')),
        });
        continue;
      }
      if (child.type !== 'type_parameter') unavailable(span, `型引数の書き方（${child.text}）`);
      const defaultType = child.childForFieldName('default_type');
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
      if (left.type === 'lifetime') {
        const outlives =
          predicate
            .childForFieldName('bounds')
            ?.namedChildren.filter((part) => part.type === 'lifetime')
            .map((part) => part.text) ?? [];
        (generics.lifetimeBounds ??= []).push({ name: left.text, outlives });
        continue;
      }
      if (left.type === 'higher_ranked_trait_bound') {
        // `for<'a> F: Fn(&'a T)`: the bound holds for every lifetime, which the borrow checker's own rules give.
        const bounds = predicate.childForFieldName('bounds');
        generics.where.push({
          type: this.type(this.field(left, 'type')),
          bounds: bounds ? this.bounds(bounds) : [],
          span: this.span(predicate),
        });
        continue;
      }
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
      bounds.push(this.bound(child));
    }
    return bounds;
  }

  private bound(node: Node): BoundAst {
    const span = this.span(node);
    switch (node.type) {
      case 'lifetime': {
        if (node.text === "'static") return { kind: 'static', span };
        return { kind: 'lifetime', name: node.text, span };
      }
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
        return syntaxError(span, `境界 ${node.text} は、不安定な機能なので使えません（E0658）。`);
      }
      case 'removed_trait_bound': {
        const trait = node.namedChildren.find((child) => !isComment(child));
        if (trait?.text !== 'Sized') syntaxError(span, `${node.text} の ? は、Sized にだけ付けられます。`);
        return { kind: 'maybeSized', span };
      }
      case 'higher_ranked_trait_bound': {
        // `for<'a> F: Fn(&'a T)`: the bound holds for every lifetime, which the borrow checker's own rules give.
        return this.bound(this.field(node, 'type'));
      }
      case 'use_bounds': {
        // `use<'a, T>` names what an `impl Trait` captures; edition 2024 captures everything in scope already.
        return { kind: 'lifetime', name: "'_", span };
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
    for (const { node: child } of this.withAttributes(body.namedChildren)) {
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
    let pending: Node[] = [];
    for (const child of body.namedChildren) {
      if (isComment(child)) continue;
      if (child.type === 'attribute_item') {
        pending.push(child);
        continue;
      }
      if (child.type === 'visibility_modifier') {
        vis = this.visibilityModifier(child);
        continue;
      }
      const kept = this.attributes.read(pending);
      pending = [];
      if (kept) fields.push({ name: String(fields.length), type: this.type(child), vis, span: this.span(child) });
      vis = 'private';
    }
    return fields;
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  private enumItem(node: Node, attrs: Attributes): EnumItem {
    const span = this.span(node);
    const variants: VariantAst[] = [];
    for (const { node: child, attrs: variantAttrs } of this.withAttributes(this.field(node, 'body').namedChildren)) {
      if (child.type !== 'enum_variant') continue;
      const body = child.childForFieldName('body');
      const value = child.childForFieldName('value');
      variants.push({
        name: this.identifier(this.field(child, 'name')),
        span: this.span(child),
        shape: body?.type === 'field_declaration_list' ? 'named' : body ? 'tuple' : 'unit',
        fields: body?.type === 'field_declaration_list' ? this.namedFields(body) : body ? this.orderedFields(body) : [],
        discriminant: value ? this.expr(value) : undefined,
        isDefault: variantAttrs.isDefault,
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

  /**
   * Requires the parameters of a generic associated type to be lifetimes (`type Item<'a> where Self: 'a;`), which the
   * borrow checker reads from the types that use them, so that the type stands for one type as an associated type does.
   */
  private requireLifetimeParamsOnly(node: Node): void {
    const parameters = node.childForFieldName('type_parameters');
    if (parameters?.namedChildren.some((child) => !isComment(child) && child.type !== 'lifetime_parameter')) {
      unavailable(this.span(node), '型引数を持つ関連型（type Item<T>;）');
    }
  }

  private traitItem(node: Node): TraitItem {
    const span = this.span(node);
    const methods: FnItem[] = [];
    const assocTypes: TraitItem['assocTypes'] = [];
    const consts: TraitItem['consts'] = [];
    const members = (body: Node | null | undefined): void => {
      for (const syntax of body?.namedChildren ?? []) {
        // The `;` that ends a macro invocation (`getter!(x);`) is a statement of its own in the tree.
        if (isComment(syntax) || syntax.type === 'empty_statement') continue;
        const { attributes, target: child } = splitAttributes(syntax);
        const attrs = this.attributes.read(attributes);
        if (!attrs || !child) continue;
        if (child.type === 'function_item' || child.type === 'function_signature_item') {
          const method = this.fnItem(child, child.type === 'function_signature_item', attrs);
          if (method.isConst) syntaxError(method.span, 'トレイトの関数は const にできません（E0379）。');
          methods.push(method);
        } else if (child.type === 'associated_type') {
          this.requireLifetimeParamsOnly(child);
          const typeBounds = child.childForFieldName('bounds');
          assocTypes.push({
            name: this.identifier(this.field(child, 'name')),
            bounds: typeBounds ? this.bounds(typeBounds) : [],
            span: this.span(child),
          });
        } else if (child.type === 'type_item') {
          syntaxError(this.span(child), '関連型の既定の型は、不安定な機能なので使えません（E0658）。');
        } else if (child.type === 'const_item') consts.push(this.constItem(child, true));
        else if (child.type === 'macro_invocation' && this.isUserMacro(child)) {
          this.expandUserMacro(
            child,
            (code) => `trait MacroExpansion { ${code} }`,
            (root) => {
              members(root.namedChildren.find((item) => item.type === 'trait_item')?.childForFieldName('body'));
            }
          );
        } else if (child.type === 'macro_invocation') unavailable(this.span(child), 'トレイトの中のマクロ');
        else this.unsupportedAssociatedItem(child);
      }
    };
    members(this.field(node, 'body'));
    const bounds = node.childForFieldName('bounds');
    return {
      kind: 'trait',
      name: this.identifier(this.field(node, 'name')),
      span,
      vis: this.visibility(node),
      generics: this.generics(node),
      supertraits: bounds ? this.bounds(bounds) : [],
      methods,
      assocTypes,
      consts,
    };
  }

  // code-gauge-allow functionNcss -- One case per kind of syntax node.
  private implItem(node: Node): ImplItem {
    const span = this.span(node);
    if (/^impl\b[^{]*!/.test(node.text))
      syntaxError(span, '否定の実装（impl !Trait）は、不安定な機能なので使えません（E0658）。');
    const trait = node.childForFieldName('trait');
    const methods: FnItem[] = [];
    const consts: ImplItem['consts'] = [];
    const assocTypes: ImplItem['assocTypes'] = [];
    const members = (body: Node | null | undefined): void => {
      for (const syntax of body?.namedChildren ?? []) {
        // The `;` that ends a macro invocation (`getter!(x);`) is a statement of its own in the tree.
        if (isComment(syntax) || syntax.type === 'empty_statement') continue;
        const { attributes, target: child } = splitAttributes(syntax);
        const attrs = this.attributes.read(attributes);
        if (!attrs || !child) continue;
        if (child.type === 'function_item') methods.push(this.fnItem(child, false, attrs));
        else if (child.type === 'function_signature_item' && this.isStd) methods.push(this.fnItem(child, true, attrs));
        else if (child.type === 'const_item') consts.push(this.item(child) as ImplItem['consts'][number]);
        else if (child.type === 'type_item') {
          this.requireLifetimeParamsOnly(child);
          assocTypes.push({
            name: this.identifier(this.field(child, 'name')),
            type: this.type(this.field(child, 'type')),
            span: this.span(child),
          });
        } else if (child.type === 'function_signature_item') syntaxError(this.span(child), '関数の本体が足りません。');
        else if (child.type === 'macro_invocation' && this.isUserMacro(child)) {
          this.expandUserMacro(
            child,
            (code) => `impl MacroExpansion { ${code} }`,
            (root) => {
              members(root.namedChildren.find((item) => item.type === 'impl_item')?.childForFieldName('body'));
            }
          );
        } else if (child.type === 'macro_invocation') unavailable(this.span(child), 'impl の中のマクロ');
        else this.unsupportedAssociatedItem(child);
      }
    };
    members(node.childForFieldName('body'));
    return {
      kind: 'impl',
      span,
      generics: this.generics(node),
      trait: trait ? this.typePath(trait) : undefined,
      selfType: this.type(this.field(node, 'type')),
      methods,
      consts,
      assocTypes,
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

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of syntax node.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
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

  // code-gauge-allow functionCognitiveComplexity -- Each syntax form determines which child nodes constitute its type.
  // code-gauge-allow functionNcss -- One case per kind of syntax node.
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
        const elems = node.namedChildren.filter((child) => !isComment(child)).map((child) => this.type(child));
        if (elems.length === 1 && !node.children.some((child) => child.type === ',')) return elems[0];
        return { kind: 'tuple', elems, span };
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
        return this.objectBoundType(
          'dyn',
          [trait, ...node.namedChildren.filter((child) => child.type === 'lifetime')],
          span
        );
      }
      case 'abstract_type': {
        const trait = this.field(node, 'trait');
        if (node.namedChildren.some((child) => child.type === 'type_parameters')) {
          return unavailable(span, "for<'a> の境界");
        }
        return this.objectBoundType('impl', [trait], span);
      }
      case 'function_type': {
        if (!node.childForFieldName('trait')) return this.fnPointerType(node, span);
        const bound = this.bound(node);
        if (bound.kind !== 'fn') unavailable(span, '関数ポインタの型（fn(i32) -> i32）');
        return { kind: 'fnBound', bound, span };
      }
      case 'never_type': {
        if (this.isStd) return { kind: 'never', span };
        return syntaxError(span, '型 ! は、関数の戻り値の型にだけ書けます（ほかの場所では不安定な機能です。E0658）。');
      }
      case 'pointer_type': {
        const mutable = node.namedChildren.some((child) => child.type === 'mutable_specifier');
        return { kind: 'pointer', mutable, target: this.type(this.field(node, 'type')), span };
      }
      case 'bounded_type': {
        return this.boundedType(node, span);
      }
      case 'macro_invocation': {
        if (this.isUserMacro(node)) return this.userMacroType(node);
        return unavailable(span, `型の場所のマクロ ${node.text}`);
      }
      case 'bracketed_type':
      case 'qualified_type': {
        return syntaxError(span, '<T as Trait> の後には、::Item のように関連型の名前を書いてください。');
      }
      default: {
        return unavailable(span, `型の書き方（${node.text}）`);
      }
    }
  }

  private fnPointerType(node: Node, span: Span): TypeAst {
    const modifiers = node.namedChildren.find((child) => child.type === 'function_modifiers');
    if (modifiers?.text.includes('extern')) unavailable(span, '外部の関数のポインタ（extern "C" fn）');
    if (modifiers?.text.includes('unsafe')) unavailable(span, 'unsafe fn のポインタ');
    if (node.namedChildren.some((child) => child.type === 'for_lifetimes')) {
      return syntaxError(span, "for<'a> fn(...) は、この採点環境では使えません。");
    }
    const params = this.field(node, 'parameters')
      .namedChildren.filter((child) => !isComment(child))
      .map((child) => this.type(child.type === 'parameter' ? this.field(child, 'type') : child));
    const ret = node.childForFieldName('return_type');
    return { kind: 'fnPointer', params, ret: ret ? this.returnType(ret) : undefined, span };
  }

  private boundedType(node: Node, span: Span): TypeAst {
    const [head, ...rest] = node.namedChildren.filter((child) => !isComment(child));
    if (head?.type === 'abstract_type' || head?.type === 'dynamic_type' || head?.type === 'bounded_type') {
      const base = this.type(head);
      if (base.kind === 'impl' || base.kind === 'dyn') return this.objectBoundType(base.kind, rest, span, base);
    }
    return syntaxError(span, '+ を含む impl や dyn を参照型の内側に書くときは、括弧で囲んでください。');
  }

  // code-gauge-allow functionCognitiveComplexity -- Flattens bounds while separating trait and lifetime nodes.
  private objectBoundType(
    kind: 'impl' | 'dyn',
    nodes: Node[],
    span: Span,
    base?: Extract<TypeAst, { kind: 'impl' | 'dyn' }>
  ): TypeAst {
    const bounds = [...(base?.bounds ?? [])];
    const lifetimes = base?.kind === 'dyn' && base.lifetime ? [base.lifetime] : [];
    const visit = (node: Node): void => {
      if (node.type === 'lifetime') lifetimes.push(node.text);
      else if (node.type === 'bounded_type') {
        for (const child of node.namedChildren) if (!isComment(child)) visit(child);
      } else bounds.push(this.bound(node));
    };
    for (const node of nodes) visit(node);
    if (kind === 'impl') {
      if (lifetimes.includes("'static")) bounds.push({ kind: 'static', span });
      return { kind, bounds, span };
    }
    if (lifetimes.length > 1) syntaxError(span, 'dyn の型のライフタイムは 1 個だけ書いてください。');
    return { kind, bounds, span, lifetime: lifetimes[0] };
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
    if (node.type === 'bracketed_type') return this.qualifiedPath(node);
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

  /** `<T as Trait>` or `<T>` at the start of a path, as a segment that the rest of the path is relative to. */
  private qualifiedPath(node: Node): PathAst {
    const span = this.span(node);
    const inner = node.namedChildren.find((child) => !isComment(child));
    if (!inner) return syntaxError(span, '書き方に誤りがあります。');
    if (inner.type === 'qualified_type') {
      const self = this.type(this.field(inner, 'type'));
      const trait = this.typePath(this.field(inner, 'alias'));
      return { segments: [{ name: '<qualified>', args: undefined, span, qualified: { self, trait } }], span };
    }
    const self = this.type(inner);
    return { segments: [{ name: '<qualified>', args: undefined, span, qualified: { self, trait: undefined } }], span };
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
      if (child.type === 'block' || child.type.endsWith('_literal') || child.type === 'negative_literal') {
        args.push({ kind: 'constArg', value: this.expr(child), span: this.span(child) });
        continue;
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
        return this.qualifiedPath(node);
      }
      default: {
        return unavailable(span, `パスの書き方（${node.text}）`);
      }
    }
  }
}

/** `async fn f() -> T { body }` as `fn f() -> impl Future<Output = T> { async move { body } }`. */
function asyncFunction(ret: TypeAst | undefined, body: Block | undefined, span: Span): Pick<FnItem, 'ret' | 'body'> {
  const output: TypeAst = ret ?? { kind: 'tuple', elems: [], span };
  const segments: PathSegment[] = ['std', 'future', 'Future'].map((name) => ({ name, args: undefined, span }));
  segments[2] = { ...segments[2], args: [], bindings: [{ name: 'Output', type: output, span }] };
  const future: TypeAst = { kind: 'impl', bounds: [{ kind: 'trait', path: { segments, span }, span }], span };
  if (!body) return { ret: future, body };
  const block: Expr = { kind: 'closure', isMove: true, params: [], ret: output, body, isAsync: 'fn', span: body.span };
  return {
    ret: future,
    body: { kind: 'block', stmts: [], tail: block, span: body.span, endRow: body.endRow, items: [] },
  };
}
