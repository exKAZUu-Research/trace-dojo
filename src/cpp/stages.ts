import { compileError, unsupported } from './errors';
import { headerFeature } from './library/headers';
import { fieldOf, type Syntax } from './syntax';

/** The syntax the interpreter leaves out, by node type, with the name learners know it by. */
const UNSUPPORTED_NODES: Record<string, string> = {
  raw_string_literal: '生の文字列リテラル（R"(...)"）',
  user_defined_literal: 'ユーザ定義リテラル（"abc"s など）',
  initializer_pair: '指示付きの初期化子（{.x = 1} など）',
  field_designator: '指示付きの初期化子（{.x = 1} など）',
  subscript_designator: '指示付きの初期化子（{[1] = 2} など）',
  subscript_range_designator: '指示付きの初期化子（{[1] = 2} など）',
  enum_specifier: '列挙（enum）',
  union_specifier: '共用体（union）',
  bitfield_clause: 'ビットフィールド',
  type_definition: 'typedef',
  alias_declaration: '型の別名の宣言（using 名前 = 型;）',
  namespace_definition: '名前空間の定義（namespace）',
  namespace_alias_definition: '名前空間の別名（namespace 名前 = ...;）',
  friend_declaration: 'friend の宣言',
  operator_name: '演算子のオーバーロード（operator）',
  operator_cast: '変換関数（operator 型）',
  explicit_function_specifier: 'explicit',
  default_method_clause: '= default',
  delete_method_clause: '= delete',
  ref_qualifier: '参照修飾子（& や &&）の付いたメンバ関数',
  trailing_return_type: '後置の戻り値の型（-> 型）',
  noexcept: 'noexcept',
  throw_specifier: '例外の指定（throw(...)）',
  parenthesized_declarator: '括弧で囲んだ宣言子（関数ポインタ・配列へのポインタなど）',
  abstract_parenthesized_declarator: '括弧で囲んだ宣言子（関数ポインタ・配列へのポインタなど）',
  abstract_function_declarator: '関数の型（int(int) など）',
  template_declaration: 'テンプレートの定義（template）',
  template_instantiation: 'テンプレートの明示的な実体化',
  template_method: 'メンバ関数テンプレートへのテンプレート引数の指定（obj.f<int>() など）',
  dependent_name: 'typename・template による依存名',
  dependent_type: 'typename・template による依存名',
  variadic_parameter: '可変長引数（...）',
  variadic_parameter_declaration: 'パラメータパック（...）',
  variadic_declarator: 'パラメータパック（...）',
  variadic_type_parameter_declaration: 'パラメータパック（...）',
  parameter_pack_expansion: 'パラメータパック（...）',
  fold_expression: '畳み込み式（(... + xs) など）',
  pack_index_expression: 'パックのインデックス（xs...[0]）',
  pack_index_type: 'パックのインデックス（Ts...[0]）',
  requires_clause: 'requires',
  requires_expression: 'requires',
  concept_definition: 'コンセプト（concept）',
  static_assert_declaration: 'static_assert',
  decltype: 'decltype',
  lambda_expression: 'ラムダ式',
  structured_binding_declarator: '構造化束縛（auto [a, b] = ...）',
  init_statement: '初期化文の付いた if・switch・範囲 for（if (int n = f(); n > 0) など）',
  goto_statement: 'goto とラベル',
  labeled_statement: 'goto とラベル',
  attribute_declaration: '属性（[[...]]）',
  attribute_specifier: '属性（__attribute__((...))）',
  attributed_statement: '属性（[[...]]）',
  annotation: '注釈（[[=...]]）',
  alignas_qualifier: 'alignas',
  alignof_expression: 'alignof',
  explicit_object_parameter_declaration: '明示的なオブジェクト引数（this を付けた引数）',
  expansion_statement: 'template for',
  consteval_block_declaration: 'consteval のブロック',
  contract_specifier: '契約（pre・post）',
  generic_expression: '_Generic',
  offsetof_expression: 'offsetof',
  va_arg_expression: '可変長引数（va_arg）',
  extension_expression: '__extension__',
  bit_int_specifier: '_BitInt',
  typeof_specifier: '__typeof__',
  macro_specifier: 'マクロ',
  pragma_operator: '_Pragma',
  preproc_def: 'マクロの定義（#define）',
  preproc_function_def: 'マクロの定義（#define）',
  preproc_if: '条件付きのコンパイル（#if・#ifdef など）',
  preproc_ifdef: '条件付きのコンパイル（#if・#ifdef など）',
  linkage_specification: '外部の関数の宣言（extern "C"）',
  typeid_expression: '実行時の型の情報（typeid）',
  reflect_expression: 'リフレクション',
  splice_expression: 'リフレクション',
  splice_type_specifier: 'リフレクション',
  co_await_expression: 'コルーチン（co_await・co_yield・co_return）',
  co_return_statement: 'コルーチン（co_await・co_yield・co_return）',
  co_yield_statement: 'コルーチン（co_await・co_yield・co_return）',
  module_declaration: 'モジュール（module・import・export）',
  export_declaration: 'モジュール（module・import・export）',
  import_declaration: 'モジュール（module・import・export）',
  global_module_fragment_declaration: 'モジュール（module・import・export）',
  private_module_fragment_declaration: 'モジュール（module・import・export）',
  atomic_type_specifier: '_Atomic',
  gnu_asm_expression: 'インラインアセンブリ（asm）',
  builtin_available_expression: '__builtin_available',
};

const MICROSOFT_PREFIXES = ['ms_', 'seh_'];

const UNSUPPORTED_SPECIFIERS: Record<string, string> = {
  extern: 'extern',
  thread_local: 'thread_local（スレッドごとの変数）',
  mutable: 'mutable',
  volatile: 'volatile',
  constinit: 'constinit',
  consteval: 'consteval',
  __restrict__: 'restrict',
  _Noreturn: '_Noreturn',
  noreturn: '_Noreturn',
  __thread: 'thread_local（スレッドごとの変数）',
};

/**
 * Rejects the first use, in source order, of syntax the interpreter leaves out, and the syntax clang++ rejects that
 * the grammar accepts.
 */
export function rejectUnsupportedSyntax(root: Syntax): void {
  const visit = (node: Syntax, isCatchParameters = false): void => {
    // `catch (...)` writes its parameter as `...`, which is no variadic parameter.
    const feature = isCatchParameters && node.type === 'variadic_parameter' ? undefined : UNSUPPORTED_NODES[node.type];
    if (feature) unsupported(node.row, feature);
    if (MICROSOFT_PREFIXES.some((prefix) => node.type.startsWith(prefix))) unsupported(node.row, 'Microsoft の拡張');
    switch (node.type) {
      case 'preproc_include': {
        checkInclude(node);
        return;
      }
      case 'preproc_call': {
        checkDirective(node);
        return;
      }
      case 'storage_class_specifier':
      case 'type_qualifier': {
        checkSpecifier(node);
        break;
      }
      default: {
        break;
      }
    }
    for (const child of node.children) {
      visit(
        child,
        (node.type === 'catch_clause' && child.field === 'parameters') ||
          (isCatchParameters && node.type === 'parameter_list')
      );
    }
  };
  visit(root);
}

function checkInclude(node: Syntax): void {
  const path = fieldOf(node, 'path');
  if (!path || path.type !== 'system_lib_string') unsupported(node.row, '別のファイルの読み込み（#include "..."）');
  const header = path.text.slice(1, -1).trim();
  const problem = headerFeature(header);
  if (problem) unsupported(node.row, problem);
}

function checkDirective(node: Syntax): void {
  const directive = fieldOf(node, 'directive')?.text ?? '';
  if (directive === '#pragma') unsupported(node.row, '#pragma');
  if (directive === '#undef') unsupported(node.row, 'マクロの定義（#define・#undef）');
  if (directive === '#error' || directive === '#warning') {
    unsupported(node.row, `${directive}`);
  }
  if (directive === '#line') unsupported(node.row, '#line');
  compileError(node.row, `プリプロセッサの指令 ${directive} はありません。`);
}

function checkSpecifier(node: Syntax): void {
  const word = node.text;
  if (word === 'register') {
    compileError(node.row, 'C++17 から register は使えなくなりました（ISO C++17 does not allow register）。');
  }
  const feature = UNSUPPORTED_SPECIFIERS[word];
  if (feature) unsupported(node.row, feature);
}
