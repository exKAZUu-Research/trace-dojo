import { compileError, unsupported } from './errors';
import { headerFeature } from './library/headers';
import { fieldOf, type Syntax } from './syntax';

/** The syntax the interpreter leaves out, by node type, with the name learners know it by. */
const UNSUPPORTED_NODES: Record<string, string> = {
  bit_int_specifier: '_BitInt',
  co_await_expression: 'コルーチン（co_await・co_yield・co_return）',
  co_return_statement: 'コルーチン（co_await・co_yield・co_return）',
  co_yield_statement: 'コルーチン（co_await・co_yield・co_return）',
  atomic_type_specifier: '_Atomic',
  gnu_asm_expression: 'インラインアセンブリ（asm）',
  builtin_available_expression: '__builtin_available',
};

/**
 * The syntax of later standards that the grammar accepts and clang++ rejects in C++20, by node type, with the name
 * learners know it by and the standard that adds it.
 */
const LATER_STANDARD_NODES: Record<string, [string, string]> = {
  annotation: ['注釈（[[=...]]）', 'C++26'],
  explicit_object_parameter_declaration: ['明示的なオブジェクト引数（this を付けた引数）', 'C++23'],
  expansion_statement: ['template for', 'C++26'],
  consteval_block_declaration: ['consteval のブロック', 'C++26'],
  contract_specifier: ['契約（pre・post）', 'C++26'],
  reflect_expression: ['リフレクション（^^）', 'C++26'],
  splice_expression: ['リフレクション（[: :]）', 'C++26'],
  splice_type_specifier: ['リフレクション（[: :]）', 'C++26'],
  splice_specifier: ['リフレクション（[: :]）', 'C++26'],
};

/**
 * The module syntax, which clang++ -std=c++20 rejects in a program of one `.cpp` file, since it compiles such a file
 * as no module unit.
 */
const MODULE_NODES = new Set([
  'module_declaration',
  'export_declaration',
  'import_declaration',
  'global_module_fragment_declaration',
  'private_module_fragment_declaration',
]);

const MICROSOFT_PREFIXES = ['ms_', 'seh_'];

const UNSUPPORTED_SPECIFIERS: Record<string, string> = {
  _Noreturn: '_Noreturn',
  noreturn: '_Noreturn',
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
    const later = LATER_STANDARD_NODES[node.type];
    if (later) compileError(node.row, `${later[0]} は ${later[1]} の書き方なので、C++20 では使えません。`);
    if (MODULE_NODES.has(node.type))
      compileError(
        node.row,
        'モジュール（module・import・export）は、1つのファイルのプログラムでは使えません（clang++ -std=c++20 は .cpp のファイルをモジュールとして読みません）。'
      );
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

/** A directive the preprocessor leaves, which is none the language has. */
function checkDirective(node: Syntax): void {
  const directive = fieldOf(node, 'directive')?.text ?? '';
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
