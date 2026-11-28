import type { Node } from '@willbooster/web-tree-sitter';

import type { Attributes, Span } from './ast';
import { isComment, syntaxError, unavailable } from './convertSyntax';
import { INT_NAMES, type IntName } from './types';

const DERIVABLE = new Set(['Debug', 'Clone', 'Copy', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash', 'Default']);

/** Attributes that only tune lints, documentation, code generation, or other tools, which change no behavior here. */
const INERT_ATTRIBUTES = new Set([
  'allow',
  'warn',
  'deny',
  'forbid',
  'expect',
  'inline',
  'cold',
  'must_use',
  'doc',
  'deprecated',
  'non_exhaustive',
  'automatically_derived',
  'used',
  'macro_export',
  'macro_use',
  'should_panic',
  'ignore',
  'no_implicit_prelude',
  'collapse_debuginfo',
  'crate_name',
  'crate_type',
  'recursion_limit',
  'type_length_limit',
  'windows_subsystem',
  'debugger_visualizer',
]);

/** The namespaces of the attributes of tools (`#[rustfmt::skip]`), which the compiler leaves to them. */
const TOOL_NAMESPACES = new Set(['rustfmt', 'clippy', 'rustdoc', 'rust_analyzer', 'diagnostic']);

/** Attributes that need `unsafe(...)` since edition 2024. */
const UNSAFE_ATTRIBUTES = new Set(['no_mangle', 'export_name', 'link_section']);

const TARGET_OPTIONS = new Set([
  'unix',
  'windows',
  'target_os',
  'target_family',
  'target_arch',
  'target_env',
  'target_vendor',
  'target_endian',
  'target_pointer_width',
  'target_has_atomic',
  'target_feature',
  'target_abi',
  'panic',
]);

/** The attributes that need what a single file run cannot give: other crates or files, a linker, or a target. */
const UNAVAILABLE_ATTRIBUTES: Record<string, string> = {
  proc_macro: '手続きマクロの定義（別のクレートが要ります）',
  proc_macro_derive: '手続きマクロの定義（別のクレートが要ります）',
  proc_macro_attribute: '手続きマクロの定義（別のクレートが要ります）',
  path: '別のファイルのモジュール（#[path]）',
  link: '外部のライブラリとのリンク',
  link_name: '外部のライブラリとのリンク',
  link_ordinal: '外部のライブラリとのリンク',
  target_feature: 'CPU によって結果が変わる属性（#[target_feature]）',
  instruction_set: 'CPU によって結果が変わる属性（#[instruction_set]）',
  naked: 'CPU によって結果が変わる属性（#[naked]）',
  no_std: '#[no_std]',
  no_main: '#[no_main]',
  global_allocator: '#[global_allocator]',
  panic_handler: '#[panic_handler]',
  track_caller: '呼び出し元の位置で panic を報告する属性（#[track_caller]）',
};

const REPR_NAMES = new Set(['C', 'Rust', 'transparent', 'packed', 'align', ...INT_NAMES]);

/** Requires `#[repr(..)]` to name known representations, `align` and `packed` alone taking `(N)` (E0539, E0565). */
function checkReprArgs(args: Node | null, span: Span): void {
  // A bare `#[repr]` is malformed; an empty `#[repr()]` asks for nothing, which rustc accepts.
  if (!args) syntaxError(span, '#[repr] には、表現（C や u8 など）を書いてください（E0539）。');
  const parts = args.namedChildren.filter((child) => !isComment(child));
  for (const [index, part] of parts.entries()) {
    if (part.type === 'token_tree' && ['align', 'packed'].includes(parts[index - 1]?.text ?? '')) continue;
    if (!['identifier', 'primitive_type'].includes(part.type) || !REPR_NAMES.has(part.text)) {
      syntaxError(span, `#[repr] の ${part.text} は、表現の名前ではありません（E0539）。`);
    }
  }
}

function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((item) => !test(item))];
}

function attributeName(node: Node): string | undefined {
  return node.namedChildren.find((child) => child.type === 'attribute')?.namedChildren[0]?.text;
}

export class AttributeReader {
  constructor(
    private readonly span: (node: Node) => Span,
    private readonly reparseAttributes: (text: string) => Node[]
  ) {}

  /**
   * The effects of outer attributes, or undefined when `#[cfg]` removes what they are on. Only an item (`on: 'item'`)
   * may carry `#[derive]` and `#[repr(u8)]`, which the item then checks it is a struct or an enum, and only an enum's
   * variant `#[default]`.
   */
  read(nodes: Node[], on: 'item' | 'variant' | 'other' = 'other'): Attributes | undefined {
    const attrs: Attributes = { derives: [] };
    // rustc removes what a `#[cfg]` leaves out before it reads the other attributes, wherever they stand.
    const [cfgs, others] = partition(nodes, (node) => attributeName(node) === 'cfg');
    if (!cfgs.every((node) => this.apply(node, attrs))) return undefined;
    for (const node of others) {
      if (isComment(node)) continue;
      if (!this.apply(node, attrs)) return undefined;
      if (on !== 'item' && attrs.derives.length > 0) {
        syntaxError(this.span(node), '#[derive] は、構造体と列挙型にだけ付けられます。');
      }
      if (on !== 'item' && attrs.hasRepr)
        syntaxError(this.span(node), '#[repr] は、構造体と列挙型と共用体にだけ付けられます。');
      if (on !== 'variant' && attrs.isDefault) {
        syntaxError(this.span(node), '#[default] は、列挙型の選択肢にだけ付けられます。');
      }
    }
    return attrs;
  }

  /**
   * Checks an inner attribute (`#![...]`), which applies to the module or block it is in, telling whether that stays
   * (`#![cfg(test)]` removes it).
   */
  readInner(node: Node): boolean {
    if (isComment(node)) return true;
    return this.apply(node, { derives: [] });
  }

  // code-gauge-allow functionCognitiveComplexity -- One case per kind of attribute.
  // code-gauge-allow functionNcss -- One case per kind of attribute.
  private apply(node: Node, attrs: Attributes): boolean {
    const attribute = node.namedChildren.find((child) => child.type === 'attribute');
    if (!attribute) return true;
    const span = this.span(node);
    const pathNode = attribute.namedChildren[0];
    const path =
      pathNode.type === 'scoped_identifier' ? pathNode.text.split('::').map((part) => part.trim()) : [pathNode.text];
    const args = attribute.childForFieldName('arguments');
    if (path.length > 1) {
      if (TOOL_NAMESPACES.has(path[0])) return true;
      syntaxError(span, `属性 #[${path.join('::')}] が見つかりません。`);
    }
    const [name] = path;
    switch (name) {
      case 'derive': {
        this.derive(node, args, attrs);
        return true;
      }
      case 'cfg': {
        if (!args) syntaxError(span, '#[cfg] には条件を書いてください（#[cfg(test)] など）。');
        return this.condition(cfgTokens(args), span);
      }
      case 'cfg_attr': {
        return this.cfgAttr(args, attrs, span);
      }
      case 'test': {
        // A program built without `--test` leaves out its tests.
        return false;
      }
      case 'bench': {
        return syntaxError(span, '#[bench] は、不安定な機能なので使えません（E0658）。');
      }
      case 'default': {
        attrs.isDefault = true;
        return true;
      }
      case 'repr': {
        checkReprArgs(args, span);
        const int = args?.namedChildren.find((child) => INT_NAMES.includes(child.text as IntName))?.text;
        if (int) attrs.repr = int as IntName;
        attrs.hasRepr = true;
        return true;
      }
      case 'unsafe': {
        const wrapped = args?.namedChildren.find((child) => child.type === 'identifier')?.text;
        if (!wrapped || !UNSAFE_ATTRIBUTES.has(wrapped)) {
          syntaxError(span, `#[unsafe(...)] には、unsafe の要る属性（no_mangle など）を書いてください。`);
        }
        return true;
      }
      case 'feature': {
        return syntaxError(span, '#![feature] は、安定版の Rust では使えません（E0554）。');
      }
      default: {
        if (Object.hasOwn(UNAVAILABLE_ATTRIBUTES, name)) unavailable(span, UNAVAILABLE_ATTRIBUTES[name]);
        if (UNSAFE_ATTRIBUTES.has(name)) {
          syntaxError(span, `#[${name}] は unsafe な属性なので、#[unsafe(${name})] と書いてください。`);
        }
        if (INERT_ATTRIBUTES.has(name)) return true;
        return syntaxError(span, `属性 #[${name}] が見つかりません。`);
      }
    }
  }

  private derive(node: Node, args: Node | null, attrs: Attributes): void {
    if (!args) unavailable(this.span(node), `属性（${node.text}）`);
    for (const token of args.namedChildren) {
      if (token.type !== 'identifier') unavailable(this.span(token), `#[derive] の中の ${token.text}`);
      if (!DERIVABLE.has(token.text)) unavailable(this.span(token), `#[derive(${token.text})]`);
      attrs.derives.push({ name: token.text, span: this.span(token) });
    }
  }

  private cfgAttr(args: Node | null, attrs: Attributes, span: Span): boolean {
    const tokens = args ? cfgTokens(args) : [];
    const comma = topLevelComma(tokens);
    if (comma === -1) syntaxError(span, '#[cfg_attr] には、条件と属性を書いてください。');
    if (!this.condition(tokens.slice(0, comma), span)) return true;
    // Each attribute after the condition applies, as its own `#[...]` (`#[cfg_attr(test, derive(Debug), allow(x))]`).
    for (const part of splitTopLevel(tokens.slice(comma + 1))) {
      const text = args!.text.slice(
        part[0].startIndex - args!.startIndex,
        (part.at(-1) as Node).endIndex - args!.startIndex
      );
      for (const attribute of this.reparseAttributes(`#[${text}]`)) {
        if (!this.apply(attribute, attrs)) return false;
      }
    }
    return true;
  }

  cfgMacro(tree: Node, span: Span): boolean {
    return this.condition(cfgTokens(tree), span);
  }

  /** Evaluates a `cfg` predicate as rustc does for a debug build without tests or features. */
  private condition(tokens: Node[], span: Span): boolean {
    const [head, second, third] = tokens;
    if (head?.type === 'boolean_literal' && tokens.length === 1) return head.text === 'true';
    if (head?.type !== 'identifier') syntaxError(span, '#[cfg] の条件の書き方に誤りがあります。');
    const name = head.text;
    if (TARGET_OPTIONS.has(name)) unavailable(span, `OS や CPU によって変わる条件（cfg(${name})）`);
    if (second?.type === 'token_tree') return this.combined(name, splitTopLevel(cfgTokens(second)), span);
    if (second?.type === '=') {
      if (third?.type !== 'string_literal') syntaxError(span, 'cfg の条件の値は文字列で書いてください。');
      return false;
    }
    return name === 'debug_assertions';
  }

  private combined(name: string, parts: Node[][], span: Span): boolean {
    if (name === 'not') {
      if (parts.length !== 1) syntaxError(span, 'cfg の not には、条件を1つ書いてください。');
      return !this.condition(parts[0], span);
    }
    if (name === 'all') return parts.every((part) => this.condition(part, span));
    if (name === 'any') return parts.some((part) => this.condition(part, span));
    return syntaxError(span, `cfg の条件 ${name}(...) はありません。`);
  }
}

function cfgTokens(tree: Node): Node[] {
  return tree.children.slice(1, -1).filter((child) => !isComment(child));
}

function topLevelComma(tokens: Node[]): number {
  return tokens.findIndex((token) => token.type === ',');
}

function splitTopLevel(tokens: Node[]): Node[][] {
  const parts: Node[][] = [[]];
  for (const token of tokens) {
    if (token.type === ',') parts.push([]);
    else parts.at(-1)!.push(token);
  }
  return parts.filter((part) => part.length > 0);
}
