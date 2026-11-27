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

/** `cfg` options whose values depend on the target's CPU or OS. */
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

/** Reads the attributes on what follows them, as rustc reads them for a program built without `--test`. */
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
};

export class AttributeReader {
  constructor(
    private readonly span: (node: Node) => Span,
    /** Reads the attributes of `#[cfg_attr(...)]` from their source text. */
    private readonly reparseAttributes: (text: string) => Node[]
  ) {}

  /**
   * The effects of outer attributes, or undefined when `#[cfg]` removes what they are on. Only an item (`onItem`) may
   * carry `#[derive]`, which the item then checks is a struct or an enum.
   */
  read(nodes: Node[], onItem = false): Attributes | undefined {
    const attrs: Attributes = { derives: [] };
    for (const node of nodes) {
      if (isComment(node)) continue;
      if (!this.apply(node, attrs, false)) return undefined;
      if (!onItem && attrs.derives.length > 0) {
        syntaxError(this.span(node), '#[derive] は、構造体と列挙型にだけ付けられます。');
      }
    }
    return attrs;
  }

  /** Checks an inner attribute (`#![...]`), which applies to the module or block it is in. */
  readInner(node: Node): void {
    if (isComment(node)) return;
    this.apply(node, { derives: [] }, true);
  }

  /** Applies one attribute, telling whether what it is on stays. */
  // code-gauge-allow functionCognitiveComplexity -- One case per kind of attribute.
  // code-gauge-allow functionNcss -- One case per kind of attribute.
  private apply(node: Node, attrs: Attributes, inner: boolean): boolean {
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
        return this.cfgAttr(args, attrs, inner, span);
      }
      case 'test':
      case 'bench': {
        // A program built without `--test` leaves out its tests.
        return false;
      }
      case 'default': {
        attrs.isDefault = true;
        return true;
      }
      case 'track_caller': {
        attrs.trackCaller = true;
        return true;
      }
      case 'repr': {
        const int = args?.namedChildren.find((child) => INT_NAMES.includes(child.text as IntName))?.text;
        if (int) attrs.repr = int as IntName;
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

  private cfgAttr(args: Node | null, attrs: Attributes, inner: boolean, span: Span): boolean {
    const tokens = args ? cfgTokens(args) : [];
    const comma = topLevelComma(tokens);
    if (comma === -1) syntaxError(span, '#[cfg_attr] には、条件と属性を書いてください。');
    if (!this.condition(tokens.slice(0, comma), span)) return true;
    const source = args!.text.slice(1, -1);
    const conditionEnd = tokens[comma].endIndex - args!.startIndex - 1;
    for (const attribute of this.reparseAttributes(`#[${source.slice(conditionEnd).replace(/^\s*/, '')}]`)) {
      if (!this.apply(attribute, attrs, inner)) return false;
    }
    return true;
  }

  /** The value of `cfg!(...)`, whose token tree holds a `cfg` predicate. */
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

  /** `not(...)`, `all(...)`, or `any(...)` of predicates. */
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

/** The tokens inside a token tree's brackets. */
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
