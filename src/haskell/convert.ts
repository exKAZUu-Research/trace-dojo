// code-gauge-allow-file fileNcss 800 -- The syntax-tree conversion covers every node kind of the grammar in one pass.
import type { Node, Tree } from '@willbooster/web-tree-sitter';

import type { CompileError } from '../interpreter/diagnostics';
import { compileError as syntaxError, unsupportedError } from './errors';
import { parseCharLiteral, parseFloatLiteral, parseIntegerLiteral, parseStringLiteral } from './literals';
import { sourceColumns } from './sourceCoordinates';
import type {
  Alt,
  ChainItem,
  ConDecl,
  Constraint,
  Decl,
  Expr,
  FieldBind,
  Guard,
  GuardedExpr,
  Import,
  ImportItem,
  Module,
  Name,
  Operator,
  Pat,
  QName,
  Rhs,
  SigType,
  SourceLiteral,
  Span,
  Stmt,
  TypeExpr,
} from './syntax';

/** What each node type stands for, in the message that rejects it. */
const UNSUPPORTED_NODES: Record<string, string> = {
  abstract_family: '型族',
  annotated: '種類の注釈つきの型変数',
  binding_list: 'パターンシノニム',
  constructor_synonym: 'パターンシノニム',
  constructor_synonyms: 'パターンシノニム',
  data_family: 'データ族（data family）',
  data_instance: 'データ族のインスタンス（data instance）',
  default_export: 'default の export',
  default_signature: 'クラスの default のシグネチャ',
  default_types: 'default 宣言',
  deriving_instance: '独立した deriving 宣言（deriving instance）',
  deriving_strategy: 'deriving の戦略（stock・newtype・anyclass）',
  do_module: '修飾つきの do（QualifiedDo）',
  equation: '型族',
  equations: '型族',
  explicit_type: 'type を付けた型引数（RequiredTypeArguments）',
  field_path: '入れ子のレコードの更新（OverloadedRecordUpdate）',
  forall: 'forall',
  forall_required: 'forall',
  fundep: '関数従属性',
  fundeps: '関数従属性',
  gadt_constructor: 'GADT の構文',
  gadt_constructors: 'GADT の構文',
  group: 'TransformListComp の内包表記',
  transform: 'TransformListComp の内包表記',
  implicit_parameter: '暗黙のパラメータ（?x）',
  implicit_variable: '暗黙のパラメータ（?x）',
  import_package: 'パッケージを指定した import',
  inferred: '型変数の明示的な束縛',
  invisible: '型変数の明示的な束縛（@a）',
  kind_application: '種類の適用（@k）',
  kind_signature: '種類のシグネチャ',
  label: 'ラベル（#name）',
  lambda_case: String.raw`\case`,
  lambda_cases: String.raw`\cases`,
  lazy_field: '遅延の印（~）を付けたフィールド',
  strict_field: '正格の印（!）を付けたフィールド',
  linear_function: '線形型（%1 ->）',
  modifier: '多重度の注釈（%1）',
  module_export: 'モジュールの再 export（module M）',
  multi_way_if: '複数の分岐の if（MultiWayIf）',
  namespace: '名前空間の指定（type・data）',
  namespaced_child: '名前空間の指定（type・data）',
  newtype: 'newtype',
  newtype_constructor: 'newtype',
  or_pattern: 'or パターン',
  pattern_synonym: 'パターンシノニム',
  promoted: '昇格した構成子（DataKinds）',
  rec: 'rec ブロック（RecursiveDo）',
  role_annotation: '型の役割の注釈（type role）',
  type_role: '型の役割の注釈（type role）',
  type_binder: 'パターンの型の束縛（@a）',
  type_application: '型の適用（@Int）',
  type_family: '型族',
  type_family_injectivity: '型族',
  type_family_result: '型族',
  type_instance: '型族のインスタンス',
  unboxed_sum: 'ボックス化されない和型',
  unboxed_tuple: 'ボックス化されないタプル',
  unboxed_unit: 'ボックス化されないタプル',
  prefix_unboxed_sum: 'ボックス化されない和型',
  prefix_unboxed_tuple: 'ボックス化されないタプル',
  view_pattern: 'ビューパターン',
  irrefutable: '遅延パターン（~）',
  strict: '正格パターン（!）',
  prefix_tuple: 'タプルの構成子の前置き（(,)）',
  star: '種類の *',
  special: '特別な構成子の宣言',
  empty_list: "昇格したリスト（'[]）",
  typed_hole: '型の穴（_）',
  pragma: 'プラグマ（{-# ... #-}）',
  cpp: 'C プリプロセッサの指令',
  via: 'deriving via',
  quantified_variables: 'forall',
  pattern_guard: 'パターンガード（| Just x <- e）',
  calling_convention: '外部の関数の宣言（foreign）',
  entity: '外部の関数の宣言（foreign）',
  safety: '外部の関数の宣言（foreign）',
  foreign_import: '外部の関数の宣言（foreign import）',
  foreign_export: '外部の関数の宣言（foreign export）',
  quasiquote: 'Template Haskell の準クォート',
  quasiquote_body: 'Template Haskell の準クォート',
  quoter: 'Template Haskell の準クォート',
  quote: 'Template Haskell のクォート',
  quoted_decls: 'Template Haskell のクォート',
  quoted_expression: 'Template Haskell のクォート',
  quoted_pattern: 'Template Haskell のクォート',
  quoted_type: 'Template Haskell のクォート',
  typed_quote: 'Template Haskell のクォート',
  th_quoted_name: 'Template Haskell の名前のクォート',
  splice: 'Template Haskell のスプライス',
  top_splice: 'Template Haskell のスプライス',
  import_level: 'Template Haskell の段階を指定した import',
};

const columnsByTree = new WeakMap<Tree, Uint32Array>();

export function spanOf(node: Node): Span {
  let columns = columnsByTree.get(node.tree);
  if (!columns) {
    columns = sourceColumns(node.tree.rootNode.text);
    columnsByTree.set(node.tree, columns);
  }
  return {
    row: node.startPosition.row,
    col: columns[node.startIndex]!,
    endRow: node.endPosition.row,
    endCol: columns[node.endIndex]!,
  };
}

function unsupported(node: Node): CompileError {
  const what = Object.hasOwn(UNSUPPORTED_NODES, node.type) ? UNSUPPORTED_NODES[node.type] : `${node.type} の書き方`;
  return unsupportedError(spanOf(node), what);
}

function rejectUnsupported(node: Node): void {
  if (Object.hasOwn(UNSUPPORTED_NODES, node.type)) throw unsupported(node);
}

function field(node: Node, name: string): Node | undefined {
  return node.childForFieldName(name) ?? undefined;
}

function fields(node: Node, name: string): Node[] {
  return node.childrenForFieldName(name).filter((child): child is Node => child !== null);
}

function required(node: Node, name: string): Node {
  const child = field(node, name);
  if (!child) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  return child;
}

function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null && !isComment(child));
}

function isComment(node: Node): boolean {
  return node.type === 'comment' || node.type === 'haddock';
}

/** The children without a field name, which some rules use for their main part. */
function unnamedFieldChildren(node: Node): Node[] {
  const result: Node[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child?.isNamed && !isComment(child) && !node.fieldNameForChild(index)) result.push(child);
  }
  return result;
}

function hasToken(node: Node, token: string): boolean {
  return node.children.some((child) => child !== null && !child.isNamed && child.type === token);
}

/** Whether the module being converted is the library's, which may use a few forms programs cannot. */
let isLibrary = false;

/** Converts a module's parse tree into the surface syntax, rejecting syntax this environment does not support. */
export function convertModule(root: Node, defaultName = 'Main', library = false): Module {
  isLibrary = library;
  rejectPragmas(root);
  const header = namedChildren(root).find((child) => child.type === 'header');
  const importsNode = field(root, 'imports');
  const declarationsNode = field(root, 'declarations');
  const imports = importsNode ? fields(importsNode, 'import').map(convertImport) : [];
  const decls: Decl[] = [];
  if (declarationsNode) {
    for (const child of namedChildren(declarationsNode)) {
      if (child.type === 'import') {
        throw syntaxError(spanOf(child), 'import は、宣言より前に書いてください。');
      }
      decls.push(...convertTopDecl(child));
    }
  }
  return {
    name: header ? moduleName(required(header, 'module')) : defaultName,
    exports: header ? convertExports(header) : undefined,
    imports,
    decls,
    span: spanOf(root),
  };
}

function rejectPragmas(root: Node): void {
  for (const type of ['pragma', 'cpp']) {
    const found = root.descendantsOfType(type)[0];
    if (found) throw unsupported(found);
  }
  const unicode = root.descendantsOfType(UNICODE_TOKENS)[0];
  if (unicode) throw unsupportedError(spanOf(unicode), `Unicode の記号 ${unicode.type}（UnicodeSyntax）`);
}

/** The Unicode forms of `->`, `<-`, `::`, `=>`, and `forall`, which GHC accepts only with UnicodeSyntax. */
const UNICODE_TOKENS = ['→', '←', '∷', '⇒', '∀', '⊸', '★'];

function moduleName(node: Node): string {
  return node.text.replaceAll(/\s+/g, '').replace(/\.$/, '');
}

function convertExports(header: Node): ImportItem[] | undefined {
  const exportsNode = field(header, 'exports');
  if (!exportsNode) return undefined;
  for (const child of namedChildren(exportsNode)) rejectUnsupported(child);
  return fields(exportsNode, 'export').map((node) => convertImportItem(node, true));
}

function convertImport(node: Node): Import {
  for (const name of ['package', 'level']) {
    const child = field(node, name);
    if (child) throw unsupported(child);
  }
  if (hasToken(node, 'safe')) throw unsupportedError(spanOf(node), 'safe を付けた import');
  const namesNode = field(node, 'names');
  const aliasNode = field(node, 'alias');
  return {
    module: moduleName(required(node, 'module')),
    qualified: hasToken(node, 'qualified'),
    alias: aliasNode ? moduleName(aliasNode) : undefined,
    hiding: hasToken(node, 'hiding') || (namesNode !== undefined && hasToken(namesNode, 'hiding')),
    items: namesNode ? fields(namesNode, 'name').map((node) => convertImportItem(node)) : undefined,
    span: spanOf(node),
  };
}

function convertImportItem(node: Node, exporting = false): ImportItem {
  const nameOf = (name: Node): QName => (exporting ? qualifiedName(name).name : plainName(name));
  const namespace = field(node, 'namespace');
  if (namespace) throw unsupported(namespace);
  const variable = field(node, 'variable');
  const operator = field(node, 'operator');
  const type = field(node, 'type');
  const constructor = field(node, 'constructor');
  if (variable) return { kind: 'value', name: nameOf(variable) };
  if (operator) return { kind: 'value', name: nameOf(operator) };
  const typeNode = type ?? constructor;
  if (!typeNode) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  const childrenNode = field(node, 'children');
  let children: ImportItem['children'];
  if (childrenNode) {
    const elements = fields(childrenNode, 'element');
    for (const element of elements) rejectUnsupported(element);
    children = elements.some((element) => element.type === 'all_names') ? 'all' : elements.map(nameOf);
  }
  return { kind: 'type', name: nameOf(typeNode), children };
}

/** The name a node spells, without parentheses around an operator. */
function plainName(node: Node): Name {
  if (node.type === 'prefix_id' || node.type === 'parenthesized_name') {
    const inner = namedChildren(node)[0];
    if (!inner) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    if (inner.type === 'qualified') throw syntaxError(spanOf(node), '修飾された名前は、ここには書けません。');
    return { name: inner.text, span: spanOf(node) };
  }
  if (node.type === 'qualified') throw syntaxError(spanOf(node), '修飾された名前は、ここには書けません。');
  if (node.type === 'field_name') return plainName(namedChildren(node)[0] ?? node);
  return { name: node.text, span: spanOf(node) };
}

/** A possibly qualified name, telling whether it names a constructor (or a constructor operator). */
function qualifiedName(node: Node): { name: QName; isConstructor: boolean } {
  rejectUnsupported(node);
  switch (node.type) {
    case 'qualified': {
      const id = required(node, 'id');
      const module = moduleName(required(node, 'module'));
      const inner = id.type === 'field_name' ? (namedChildren(id)[0] ?? id) : id;
      return {
        name: { name: inner.text, qualifier: module, span: spanOf(node) },
        isConstructor: inner.type === 'constructor' || inner.type === 'constructor_operator' || inner.type === 'name',
      };
    }
    case 'prefix_id':
    case 'parenthesized_name':
    case 'infix_id': {
      const inner = namedChildren(node)[0];
      if (!inner) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
      const result = qualifiedName(inner);
      return { name: { ...result.name, span: spanOf(node) }, isConstructor: result.isConstructor };
    }
    case 'field_name': {
      return qualifiedName(namedChildren(node)[0] ?? node);
    }
    default: {
      return {
        name: { name: node.text, span: spanOf(node) },
        isConstructor: node.type === 'constructor' || node.type === 'constructor_operator' || node.type === 'name',
      };
    }
  }
}

function convertOperator(node: Node): Operator {
  const { name, isConstructor } = qualifiedName(node);
  const text = name.name;
  return { ...name, isConstructor: isConstructor || text.startsWith(':') };
}

// ---------------------------------------------------------------------------------------------------------------
// Declarations

function convertTopDecl(node: Node): Decl[] {
  rejectUnsupported(node);
  switch (node.type) {
    case 'data_type': {
      return [convertData(node)];
    }
    case 'type_synonym': {
      return [convertTypeSynonym(node)];
    }
    case 'class': {
      return [convertClass(node)];
    }
    case 'instance': {
      return [convertInstance(node)];
    }
    default: {
      return convertDecl(node);
    }
  }
}

/** Converts a declaration that may appear in a `let`, a `where`, a class, an instance, or at the top level. */
function convertDecl(node: Node): Decl[] {
  rejectUnsupported(node);
  switch (node.type) {
    case 'signature': {
      return [convertSignature(node)];
    }
    case 'fixity': {
      return [convertFixity(node)];
    }
    case 'function': {
      return [convertFunction(node)];
    }
    case 'bind': {
      return [convertBind(node)];
    }
    case 'data_type':
    case 'type_synonym':
    case 'class':
    case 'instance': {
      throw syntaxError(spanOf(node), 'data・type・class・instance の宣言は、最上位にだけ書けます。');
    }
    default: {
      throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    }
  }
}

function convertSignature(node: Node): Decl {
  const namesNode = field(node, 'names');
  const nameNode = field(node, 'name');
  for (const name of ['synonym', 'kind', 'pattern', 'constraint', 'expression']) {
    const child = field(node, name);
    if (child) throw syntaxError(spanOf(child), '書き方に誤りがあります。');
  }
  const names = namesNode ? fields(namesNode, 'name').map(plainName) : nameNode ? [plainName(nameNode)] : [];
  if (names.length === 0) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  const span = spanOf(node);
  return { kind: 'sig', names, sig: { ...convertSigType(required(node, 'type')), span }, span };
}

function convertFixity(node: Node): Decl {
  const namespace = field(node, 'namespace');
  if (namespace) throw unsupported(namespace);
  const assocNode = required(node, 'associativity');
  const precNode = field(node, 'precedence');
  const prec = precNode ? Number(precNode.text) : 9;
  if (!Number.isInteger(prec) || prec < 0 || prec > 9) {
    throw syntaxError(spanOf(node), '結合の強さは 0 から 9 の整数で書いてください。');
  }
  const ops = fields(node, 'operator')
    .filter((op) => op.isNamed)
    .map((op) => {
      const inner = op.type === 'infix_id' ? (namedChildren(op)[0] ?? op) : op;
      if (inner.type === 'qualified') throw syntaxError(spanOf(op), '修飾された名前は、ここには書けません。');
      return { name: inner.text, span: spanOf(op) };
    });
  return { kind: 'fixity', assoc: assocNode.type as 'infix' | 'infixl' | 'infixr', prec, ops, span: spanOf(node) };
}

function convertFunction(node: Node): Decl {
  for (const name of ['parameter', 'result', 'arrow']) {
    if (field(node, name)) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  }
  const head = field(node, 'head');
  const rhs = convertRhs(node, '=');
  if (head) {
    // An operator or backticked function defined infix: `x .+ y = ...`, possibly with more arguments after `(x .+ y)`.
    const operator = field(head, 'operator') ?? fields(head, 'operator')[0];
    if (!operator) throw syntaxError(spanOf(head), '書き方に誤りがあります。');
    const op = convertOperator(operator);
    if (op.qualifier) throw syntaxError(spanOf(operator), '修飾された名前は、ここには書けません。');
    if (op.isConstructor) throw syntaxError(spanOf(operator), '構成子は、関数として定義できません。');
    const left = convertPattern(required(head, 'left_operand'));
    const right = convertPattern(required(head, 'right_operand'));
    const extra = fields(node, 'patterns').flatMap((patterns) => namedChildren(patterns).map(convertPattern));
    return {
      kind: 'funClause',
      name: { name: op.name, span: op.span },
      args: [left, right, ...extra],
      rhs,
      span: spanOf(node),
    };
  }
  const nameNode = required(node, 'name');
  const patterns = fields(node, 'patterns').flatMap((patternsNode) => namedChildren(patternsNode).map(convertPattern));
  return { kind: 'funClause', name: plainName(nameNode), args: patterns, rhs, span: spanOf(node) };
}

function convertBind(node: Node): Decl {
  for (const name of ['implicit', 'multiplicity']) {
    const child = field(node, name);
    if (child) throw unsupported(child);
  }
  if (field(node, 'arrow')) throw syntaxError(spanOf(node), '<- は、do の中にだけ書けます。');
  const rhs = convertRhs(node, '=');
  const nameNode = field(node, 'name');
  if (nameNode) {
    if (nameNode.type === 'prefix_id') {
      const op = convertOperator(namedChildren(nameNode)[0] ?? nameNode);
      if (op.isConstructor) throw syntaxError(spanOf(nameNode), '構成子は、関数として定義できません。');
    }
    return { kind: 'funClause', name: plainName(nameNode), args: [], rhs, span: spanOf(node) };
  }
  const pattern = convertPattern(required(node, 'pattern'));
  if (pattern.kind === 'pvar') return { kind: 'funClause', name: pattern.name, args: [], rhs, span: spanOf(node) };
  return { kind: 'patBind', pat: pattern, rhs, span: spanOf(node) };
}

function convertRhs(node: Node, separator: '=' | '->'): Rhs {
  const matches = fields(node, 'match');
  if (matches.length === 0) throw syntaxError(spanOf(node), `「${separator}」が足りません。`);
  const whereNode = field(node, 'binds');
  const where = whereNode ? convertLocalBinds(field(whereNode, 'binds')) : [];
  const first = matches[0];
  const last = matches.at(-1) as Node;
  const span = { ...spanOf(first), endRow: spanOf(last).endRow, endCol: spanOf(last).endCol };
  if (matches.length === 1 && !field(first, 'guards')) {
    checkSeparator(first, separator);
    return { body: { kind: 'plain', expr: convertExpr(required(first, 'expression')) }, where, span };
  }
  const branches: GuardedExpr[] = matches.map((match) => {
    checkSeparator(match, separator);
    const guardsNode = field(match, 'guards');
    if (!guardsNode) throw syntaxError(spanOf(match), 'ガード（|）が足りません。');
    return {
      guards: fields(guardsNode, 'guard').map(convertGuard),
      expr: convertExpr(required(match, 'expression')),
      span: spanOf(match),
    };
  });
  return { body: { kind: 'guarded', branches }, where, span };
}

function checkSeparator(match: Node, separator: '=' | '->'): void {
  if (!hasToken(match, separator)) {
    throw syntaxError(spanOf(match), `ここでは「${separator === '=' ? '=' : '->'}」を書いてください。`);
  }
}

function convertGuard(node: Node): Guard {
  rejectUnsupported(node);
  switch (node.type) {
    case 'boolean': {
      return { kind: 'bool', expr: convertExpr(namedChildren(node)[0] ?? node), span: spanOf(node) };
    }
    case 'let': {
      return { kind: 'let', decls: convertLocalBinds(field(node, 'binds')), span: spanOf(node) };
    }
    default: {
      throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    }
  }
}

function convertLocalBinds(node: Node | undefined): Decl[] {
  if (!node) return [];
  return namedChildren(node).flatMap((child) => convertDecl(child));
}

// code-gauge-allow functionCognitiveComplexity 18 -- Each branch rejects one unsupported form of a data declaration.
function convertData(node: Node): Decl {
  for (const name of ['context', 'forall', 'kind', 'head']) {
    const child = field(node, name);
    if (child) {
      if (name === 'context') throw unsupportedError(spanOf(child), 'data 宣言の文脈（DatatypeContexts）');
      if (name === 'head') throw unsupportedError(spanOf(child), '演算子の型の宣言（TypeOperators）');
      throw unsupported(child);
    }
  }
  const constructorsNode = field(node, 'constructors');
  if (constructorsNode?.type === 'gadt_constructors') throw unsupported(constructorsNode);
  const cons = constructorsNode ? fields(constructorsNode, 'constructor').map(convertConstructor) : [];
  const derivingNodes = fields(node, 'deriving');
  const deriving: QName[] = [];
  for (const derivingNode of derivingNodes) {
    for (const name of ['strategy', 'via']) {
      const child = field(derivingNode, name);
      if (child) throw unsupported(child);
    }
    const classes = required(derivingNode, 'classes');
    deriving.push(...derivingClasses(classes));
  }
  return {
    kind: 'data',
    name: typeDeclName(node),
    params: typeParams(node),
    cons,
    deriving,
    derivingSpan: derivingNodes[0] ? spanOf(derivingNodes[0]) : undefined,
    span: spanOf(node),
  };
}

function derivingClasses(node: Node): QName[] {
  switch (node.type) {
    case 'name':
    case 'qualified': {
      return [qualifiedName(node).name];
    }
    case 'parens':
    case 'tuple': {
      return namedChildren(node).flatMap(derivingClasses);
    }
    case 'unit': {
      return [];
    }
    default: {
      rejectUnsupported(node);
      throw syntaxError(spanOf(node), 'deriving には、クラスの名前を書いてください。');
    }
  }
}

function typeDeclName(node: Node): Name {
  const nameNode = required(node, 'name');
  if (nameNode.type !== 'name') {
    rejectUnsupported(nameNode);
    throw unsupportedError(spanOf(nameNode), '演算子の型の宣言（TypeOperators）');
  }
  return plainName(nameNode);
}

function typeParams(node: Node): Name[] {
  return fields(node, 'patterns').flatMap((patterns) => {
    if (patterns.type !== 'type_params') throw unsupported(patterns);
    return namedChildren(patterns).map((param) => {
      if (param.type !== 'variable') {
        rejectUnsupported(param);
        throw unsupportedError(spanOf(param), '種類の注釈つきの型変数');
      }
      return plainName(param);
    });
  });
}

// code-gauge-allow functionCognitiveComplexity 18 -- Each branch is one constructor form: prefix, infix, or record.
// code-gauge-allow functionNcss 34 -- Each branch is one constructor form: prefix, infix, or record.
function convertConstructor(node: Node): ConDecl {
  for (const name of ['context', 'forall']) {
    const child = field(node, name);
    if (child) throw unsupportedError(spanOf(child), '存在型の構成子（ExistentialQuantification）');
  }
  const inner = required(node, 'constructor');
  rejectUnsupported(inner);
  switch (inner.type) {
    case 'prefix': {
      return convertPrefixConstructor(inner);
    }
    case 'infix': {
      const operator = fields(inner, 'operator')[0];
      if (!operator) throw syntaxError(spanOf(inner), '書き方に誤りがあります。');
      const op = convertOperator(operator);
      if (!op.isConstructor) throw syntaxError(spanOf(operator), '構成子の演算子は「:」で始めてください。');
      return {
        name: { name: op.name, span: op.span },
        ...constructorFields([required(inner, 'left_operand'), required(inner, 'right_operand')]),
        isInfix: true,
        span: spanOf(inner),
      };
    }
    case 'record': {
      return convertRecordConstructor(inner);
    }
    default: {
      throw syntaxError(spanOf(inner), '書き方に誤りがあります。');
    }
  }
}

function convertRecordConstructor(node: Node): ConDecl {
  const nameNode = required(node, 'name');
  const fieldsNode = field(node, 'fields');
  const fieldTypes: TypeExpr[] = [];
  const fieldNames: Name[] = [];
  const strictFields: number[] = [];
  for (const fieldNode of fieldsNode ? fields(fieldsNode, 'field') : []) {
    const typeNode = required(fieldNode, 'type');
    const type = convertFieldType(typeNode);
    for (const nameNode2 of fields(fieldNode, 'name')) {
      if (isStrictField(typeNode)) strictFields.push(fieldTypes.length);
      fieldNames.push(plainName(nameNode2));
      fieldTypes.push(type);
    }
  }
  return {
    name: plainName(nameNode),
    fields: fieldTypes,
    fieldNames,
    ...(strictFields.length > 0 ? { strictFields } : {}),
    isInfix: false,
    span: spanOf(node),
  };
}

function convertPrefixConstructor(node: Node): ConDecl {
  if (field(node, 'type')) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  const fieldNodes = fields(node, 'field');
  return {
    name: plainName(required(node, 'name')),
    ...constructorFields(fieldNodes),
    isInfix: false,
    span: spanOf(node),
  };
}

function constructorFields(nodes: Node[]): Pick<ConDecl, 'fields' | 'strictFields'> {
  const strictFields = nodes.flatMap((node, index) => (isStrictField(node) ? [index] : []));
  return { fields: nodes.map(convertFieldType), ...(strictFields.length > 0 ? { strictFields } : {}) };
}

function convertFieldType(node: Node): TypeExpr {
  if (isStrictField(node)) return convertType(required(node, 'type'));
  rejectUnsupported(node);
  return convertType(node);
}

/** Whether a field is marked `!`, which the library declares as GHC's containers do. */
function isStrictField(node: Node): boolean {
  return node.type === 'strict_field' && isLibrary;
}

function convertTypeSynonym(node: Node): Decl {
  const head = field(node, 'head');
  if (head) throw unsupportedError(spanOf(head), '演算子の型の宣言（TypeOperators）');
  const typeNode = required(node, 'type');
  if (typeNode.type === 'signature') throw unsupported(typeNode);
  return {
    kind: 'typeSyn',
    name: typeDeclName(node),
    params: typeParams(node),
    type: convertQuantifiedType(typeNode),
    span: spanOf(node),
  };
}

function convertClass(node: Node): Decl {
  for (const name of ['fundeps', 'head']) {
    const child = field(node, name);
    if (child) {
      if (name === 'head') throw unsupportedError(spanOf(child), '演算子のクラスの宣言');
      throw unsupported(child);
    }
  }
  const params = typeParams(node);
  if (params.length !== 1) {
    throw unsupportedError(spanOf(node), params.length === 0 ? '型変数のないクラス' : '多引数の型クラス');
  }
  const contextNode = field(node, 'context');
  const declarationsNode = field(node, 'declarations');
  const decls = declarationsNode
    ? fields(declarationsNode, 'declaration').flatMap((child) => {
        rejectUnsupported(child);
        return convertDecl(child);
      })
    : [];
  return {
    kind: 'class',
    context: contextNode ? convertContext(contextNode) : [],
    name: typeDeclName(node),
    param: params[0],
    decls,
    span: spanOf(node),
  };
}

function convertInstance(node: Node): Decl {
  for (const name of ['forall', 'kind', 'head']) {
    const child = field(node, name);
    if (child) {
      if (name === 'head') throw unsupportedError(spanOf(child), '演算子のクラスのインスタンス');
      throw unsupported(child);
    }
  }
  const contextNode = field(node, 'context');
  const nameNode = required(node, 'name');
  const patterns = fields(node, 'patterns');
  const types = patterns.flatMap((patternsNode) => namedChildren(patternsNode));
  if (types.length !== 1) {
    throw unsupportedError(spanOf(node), types.length === 0 ? '型を書かないインスタンス' : '多引数の型クラス');
  }
  for (const type of types) rejectUnsupported(type);
  const declarationsNode = field(node, 'declarations');
  const decls = declarationsNode
    ? fields(declarationsNode, 'declaration').flatMap((child) => {
        rejectUnsupported(child);
        return convertDecl(child);
      })
    : [];
  return {
    kind: 'instance',
    context: contextNode ? convertContext(contextNode) : [],
    cls: qualifiedName(nameNode).name,
    type: convertType(types[0]),
    decls,
    // GHC reports an instance at its head, from the context to the type.
    span: {
      ...spanOf(contextNode?.firstChild ?? nameNode),
      endRow: spanOf(types[0]).endRow,
      endCol: spanOf(types[0]).endCol,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Types

function convertSigType(node: Node): SigType {
  rejectUnsupported(node);
  if (node.type === 'context') {
    const typeNode = field(node, 'type');
    if (!typeNode) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    const inner = convertSigType(typeNode);
    if (inner.context.length > 0) {
      return { context: [...convertContext(node), ...inner.context], type: inner.type, span: spanOf(node) };
    }
    return { context: convertContext(node), type: inner.type, span: spanOf(node) };
  }
  return { context: [], type: convertQuantifiedType(node), span: spanOf(node) };
}

function convertContext(node: Node): Constraint[] {
  const constraint = field(node, 'constraint');
  if (constraint) throw syntaxError(spanOf(constraint), '書き方に誤りがあります。');
  const contextNode = required(node, 'context');
  return constraintsOf(contextNode);
}

function constraintsOf(node: Node): Constraint[] {
  rejectUnsupported(node);
  switch (node.type) {
    case 'tuple': {
      return namedChildren(node).flatMap(constraintsOf);
    }
    case 'parens': {
      const inner = namedChildren(node)[0];
      return inner ? constraintsOf(inner) : [];
    }
    case 'unit': {
      return [];
    }
    case 'apply':
    case 'name':
    case 'qualified': {
      const type = convertType(node);
      let head: TypeExpr = type;
      const args: TypeExpr[] = [];
      while (head.kind === 'tapp') {
        args.unshift(head.arg);
        head = head.fn;
      }
      if (head.kind !== 'tcon') throw syntaxError(spanOf(node), '制約には、クラスの名前を書いてください。');
      if (args.length !== 1) {
        throw unsupportedError(spanOf(node), args.length === 0 ? '引数のない制約' : '多引数の型クラス');
      }
      return [{ cls: head.name, types: args, span: spanOf(node) }];
    }
    case 'infix_chain': {
      throw unsupportedError(spanOf(node), '型の等しさの制約（~）');
    }
    default: {
      throw unsupportedError(spanOf(node), 'この形の制約');
    }
  }
}

function convertQuantifiedType(node: Node): TypeExpr {
  rejectUnsupported(node);
  if (node.type === 'context') throw unsupportedError(spanOf(node), '型の内側の制約（RankNTypes）');
  return convertType(node);
}

// code-gauge-allow functionCognitiveComplexity 16 -- One case per type node kind of the grammar.
// code-gauge-allow functionNcss 58 -- One case per type node kind of the grammar.
function convertType(node: Node): TypeExpr {
  const span = spanOf(node);
  if (node.type === 'prefix_tuple' && isLibrary) {
    return { kind: 'tcon', name: { name: node.text.replaceAll(/\s+/g, ''), span }, span };
  }
  rejectUnsupported(node);
  switch (node.type) {
    case 'prefix_list': {
      return { kind: 'tcon', name: { name: '[]', span }, span };
    }
    case 'name': {
      return { kind: 'tcon', name: { name: node.text, span }, span };
    }
    case 'qualified': {
      return { kind: 'tcon', name: qualifiedName(node).name, span };
    }
    case 'variable': {
      return { kind: 'tvar', name: node.text, span };
    }
    case 'apply': {
      const constructor = field(node, 'constructor') ?? required(node, 'function');
      return { kind: 'tapp', fn: convertType(constructor), arg: convertType(required(node, 'argument')), span };
    }
    case 'function': {
      const parameter = required(node, 'parameter');
      const result = required(node, 'result');
      if (parameter.type === 'context' || result.type === 'context') {
        throw unsupportedError(span, '型の内側の制約（RankNTypes）');
      }
      return { kind: 'tfun', from: convertType(parameter), to: convertType(result), span };
    }
    case 'list': {
      const elements = fields(node, 'element');
      if (elements.length !== 1) throw unsupportedError(span, "昇格したリストの型（'[a, b]）");
      return { kind: 'tlist', elem: convertType(elements[0]), span };
    }
    case 'tuple': {
      const elements = fields(node, 'element');
      if (elements.length < 2) throw unsupportedError(span, 'タプルの型の節');
      return { kind: 'ttuple', elems: elements.map(convertType), span };
    }
    case 'unit': {
      return { kind: 'tcon', name: { name: '()', span }, span };
    }
    case 'parens': {
      const inner = field(node, 'type') ?? namedChildren(node)[0];
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      if (inner.type === 'signature') throw unsupportedError(span, '種類のシグネチャ');
      return convertQuantifiedType(inner);
    }
    case 'prefix_id': {
      const inner = namedChildren(node)[0];
      if (inner?.text === '->') return { kind: 'tcon', name: { name: '->', span }, span };
      throw unsupportedError(span, '演算子の型（TypeOperators）');
    }
    case 'infix_chain':
    case 'infix': {
      throw unsupportedError(span, '演算子の型（TypeOperators）');
    }
    case 'literal': {
      throw unsupportedError(span, '型のリテラル（DataKinds）');
    }
    case 'wildcard': {
      throw unsupportedError(span, '型の中の _（PartialTypeSignatures）');
    }
    case 'signature': {
      throw unsupportedError(span, '種類のシグネチャ');
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions

// code-gauge-allow functionNcss 59 -- One short case per expression node kind of the grammar.
export function convertExpr(node: Node): Expr {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'variable':
    case 'constructor':
    case 'qualified':
    case 'prefix_id':
    case 'parenthesized_name': {
      return convertNameExpression(node, span);
    }
    case 'literal': {
      return { kind: 'lit', lit: convertLiteral(namedChildren(node)[0] ?? node), span };
    }
    case 'apply': {
      const fn = required(node, 'function');
      const argument = required(node, 'argument');
      rejectUnsupported(argument);
      return { kind: 'app', fn: convertExpr(fn), arg: convertExpr(argument), span };
    }
    case 'operator_chain': {
      return { kind: 'chain', items: chainItems(node, convertExpr), span };
    }
    case 'parens': {
      const inner = field(node, 'expression');
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      return { kind: 'paren', expr: convertExpr(inner), span };
    }
    case 'tuple':
    case 'list':
    case 'arithmetic_sequence':
    case 'list_comprehension': {
      return convertCollection(node, span);
    }
    case 'unit': {
      return { kind: 'con', name: { name: '()', span }, span };
    }
    case 'left_section':
    case 'right_section': {
      return convertSection(node, span);
    }
    case 'lambda': {
      const patterns = namedChildren(required(node, 'patterns')).map(convertPattern);
      return { kind: 'lambda', pats: patterns, body: convertExpr(required(node, 'expression')), span };
    }
    case 'conditional': {
      return {
        kind: 'if',
        cond: convertExpr(required(node, 'if')),
        ifTrue: convertExpr(required(node, 'then')),
        ifFalse: convertExpr(required(node, 'else')),
        span,
      };
    }
    case 'case':
    case 'do': {
      return convertBlock(node, span);
    }
    case 'let_in': {
      return {
        kind: 'let',
        decls: convertLocalBinds(field(node, 'binds')),
        body: convertExpr(required(node, 'expression')),
        span,
      };
    }
    case 'record': {
      return convertRecordExpr(node);
    }
    case 'signature': {
      const expression = field(node, 'expression');
      const type = field(node, 'type');
      if (!expression || !type) throw syntaxError(span, '書き方に誤りがあります。');
      return { kind: 'typed', expr: convertExpr(expression), sig: convertSigType(type), span };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

function convertNameExpression(node: Node, span: Span): Expr {
  if (node.text === '_') throw unsupportedError(span, '型の穴（_）');
  const { name, isConstructor } = qualifiedName(node);
  return isConstructor || name.name.startsWith(':') ? { kind: 'con', name, span } : { kind: 'var', name, span };
}

function convertSection(node: Node, span: Span): Expr {
  if (node.type === 'left_section') {
    return {
      kind: 'leftSection',
      left: convertExpr(required(node, 'left_operand')),
      op: convertOperator(required(node, 'operator')),
      span,
    };
  }
  const operator = unnamedFieldChildren(node)[0];
  if (!operator) throw syntaxError(span, '書き方に誤りがあります。');
  return {
    kind: 'rightSection',
    op: convertOperator(operator),
    right: convertExpr(required(node, 'right_operand')),
    span,
  };
}

function convertCollection(node: Node, span: Span): Expr {
  switch (node.type) {
    case 'tuple': {
      const elements = fields(node, 'element');
      const commas = node.children.filter((child) => child?.type === ',').length;
      if (elements.length !== commas + 1) throw unsupportedError(span, 'タプルの節（TupleSections）');
      return { kind: 'tuple', elems: elements.map(convertExpr), span };
    }
    case 'list': {
      return { kind: 'list', elems: fields(node, 'element').map(convertExpr), span };
    }
    case 'arithmetic_sequence': {
      const step = field(node, 'step');
      const to = field(node, 'to');
      return {
        kind: 'arith',
        from: convertExpr(required(node, 'from')),
        next: step ? convertExpr(step) : undefined,
        to: to ? convertExpr(to) : undefined,
        span,
      };
    }
    case 'list_comprehension': {
      const qualifiersNodes = fields(node, 'qualifiers');
      if (qualifiersNodes.length !== 1) throw unsupportedError(span, '並列の内包表記（ParallelListComp）');
      return {
        kind: 'comprehension',
        expr: convertExpr(required(node, 'expression')),
        quals: fields(qualifiersNodes[0], 'qualifier').map(convertStatement),
        span,
      };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

function convertBlock(node: Node, span: Span): Expr {
  switch (node.type) {
    case 'case': {
      const scrutinee = unnamedFieldChildren(node)[0];
      if (!scrutinee) throw syntaxError(span, '書き方に誤りがあります。');
      const alternatives = field(node, 'alternatives');
      if (!alternatives || fields(alternatives, 'alternative').length === 0) {
        throw unsupportedError(span, '選択肢のない case（EmptyCase）');
      }
      return {
        kind: 'case',
        scrutinee: convertExpr(scrutinee),
        alts: alternatives ? fields(alternatives, 'alternative').map(convertAlternative) : [],
        span,
      };
    }
    case 'do': {
      const doModule = namedChildren(node).find((child) => child.type === 'do_module');
      if (doModule) throw unsupported(doModule);
      if (hasToken(node, 'mdo')) throw unsupportedError(span, 'mdo（RecursiveDo）');
      const statements = fields(node, 'statement').map(convertStatement);
      if (statements.length === 0) throw syntaxError(span, 'do の中に文がありません。');
      return { kind: 'do', stmts: statements, span };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

function convertRecordPattern(node: Node, span: Span): Pat {
  const con = convertPattern(required(node, 'constructor'));
  if (con.kind !== 'pcon' || con.args.length > 0) throw syntaxError(span, '書き方に誤りがあります。');
  const fieldPatterns = fields(node, 'field').map((fieldNode) => {
    rejectUnsupported(fieldNode);
    const wildcard = namedChildren(fieldNode).find((child) => child.type === 'wildcard');
    if (wildcard) throw unsupportedError(spanOf(wildcard), 'レコードのワイルドカード（RecordWildCards）');
    const pattern = field(fieldNode, 'pattern');
    if (!pattern) throw unsupportedError(spanOf(fieldNode), 'フィールド名だけのレコードのパターン（NamedFieldPuns）');
    return {
      field: qualifiedName(required(fieldNode, 'field')).name,
      pat: convertPattern(pattern),
      span: spanOf(fieldNode),
    };
  });
  return { kind: 'precord', con: con.con, fields: fieldPatterns, span };
}

function convertRecordExpr(node: Node): Expr {
  const span = spanOf(node);
  const target = required(node, 'expression');
  const fieldBinds: FieldBind[] = fields(node, 'field').map((fieldNode) => {
    rejectUnsupported(fieldNode);
    if (fieldNode.type !== 'field_update') throw syntaxError(spanOf(fieldNode), '書き方に誤りがあります。');
    const wildcard = namedChildren(fieldNode).find((child) => child.type === 'wildcard');
    if (wildcard) throw unsupportedError(spanOf(wildcard), 'レコードのワイルドカード（RecordWildCards）');
    const fieldName = required(fieldNode, 'field');
    rejectUnsupported(fieldName);
    const value = field(fieldNode, 'expression');
    if (!value) throw unsupportedError(spanOf(fieldNode), 'フィールド名だけのレコードの項目（NamedFieldPuns）');
    return { field: qualifiedName(fieldName).name, value: convertExpr(value), span: spanOf(fieldNode) };
  });
  const converted = convertExpr(target);
  if (converted.kind === 'con') return { kind: 'recordCon', con: converted.name, fields: fieldBinds, span };
  if (fieldBinds.length === 0) throw syntaxError(span, 'レコードの更新には、項目を1つ以上書いてください。');
  return { kind: 'recordUpdate', expr: converted, fields: fieldBinds, span };
}

function convertAlternative(node: Node): Alt {
  if (field(node, 'patterns')) throw unsupported(node);
  return { pat: convertPattern(required(node, 'pattern')), rhs: convertRhs(node, '->'), span: spanOf(node) };
}

/** Converts a statement of a `do` block or a qualifier of a list comprehension. */
function convertStatement(node: Node): Stmt {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'exp':
    case 'boolean': {
      return { kind: 'exp', expr: convertExpr(namedChildren(node)[0] ?? node), span };
    }
    case 'bind':
    case 'generator': {
      if (node.type === 'bind' && !field(node, 'arrow')) {
        throw syntaxError(span, 'do の中で束縛するには、let か <- を使ってください。');
      }
      const patternNode = field(node, 'pattern') ?? field(node, 'name');
      if (!patternNode) throw syntaxError(span, '書き方に誤りがあります。');
      return { kind: 'bind', pat: convertPattern(patternNode), expr: convertExpr(required(node, 'expression')), span };
    }
    case 'let': {
      return { kind: 'let', decls: convertLocalBinds(field(node, 'binds')), span };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

function chainItems<T>(node: Node, convertOperand: (operand: Node) => T): ChainItem<T>[] {
  const items: ChainItem<T>[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child || isComment(child)) continue;
    const fieldName = node.fieldNameForChild(index);
    if (child.type === 'prefix_negation' || fieldName === 'prefix_operator') {
      items.push({ kind: 'negate', span: spanOf(child) });
    } else if (fieldName === 'operator') {
      rejectUnsupported(child);
      items.push({ kind: 'operator', op: convertOperator(child) });
    } else if (fieldName === 'operand' || child.isNamed) {
      items.push({ kind: 'operand', value: convertOperand(child) });
    }
  }
  return items;
}

function convertLiteral(node: Node): SourceLiteral {
  const span = spanOf(node);
  switch (node.type) {
    case 'integer': {
      return { kind: 'int', value: parseIntegerLiteral(node.text, span), text: node.text };
    }
    case 'float': {
      return { kind: 'frac', value: parseFloatLiteral(node.text, span), text: node.text };
    }
    case 'char': {
      return { kind: 'char', value: parseCharLiteral(node.text, span), text: node.text };
    }
    case 'string': {
      return { kind: 'string', value: parseStringLiteral(node.text, span), text: node.text };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Patterns

// code-gauge-allow functionNcss 52 -- One short case per pattern node kind of the grammar.
export function convertPattern(node: Node): Pat {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'variable': {
      return { kind: 'pvar', name: { name: node.text, span }, span };
    }
    case 'wildcard': {
      return { kind: 'pwild', span };
    }
    case 'literal': {
      return { kind: 'plit', lit: convertLiteral(namedChildren(node)[0] ?? node), negative: false, span };
    }
    case 'negation': {
      const number = required(node, 'number');
      return { kind: 'plit', lit: convertLiteral(number), negative: true, span };
    }
    case 'constructor':
    case 'qualified':
    case 'prefix_id': {
      const { name, isConstructor } = qualifiedName(node);
      if (!isConstructor && !name.name.startsWith(':')) {
        throw syntaxError(span, 'パターンには、変数か構成子を書いてください。');
      }
      return { kind: 'pcon', con: name, args: [], span };
    }
    case 'apply': {
      const fn = required(node, 'function');
      const argument = required(node, 'argument');
      rejectUnsupported(argument);
      const head = convertPattern(fn);
      if (head.kind !== 'pcon') throw syntaxError(span, 'パターンの中で、関数は呼び出せません。');
      return { kind: 'pcon', con: head.con, args: [...head.args, convertPattern(argument)], span };
    }
    case 'parens': {
      const inner = field(node, 'pattern');
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      if (inner.type === 'signature') throw unsupportedError(span, 'パターンの型シグネチャ');
      return { ...convertPattern(inner), span };
    }
    case 'tuple': {
      const elements = fields(node, 'element');
      return { kind: 'ptuple', elems: elements.map(convertPattern), span };
    }
    case 'unit': {
      return { kind: 'pcon', con: { name: '()', span }, args: [], span };
    }
    case 'list': {
      return { kind: 'plist', elems: fields(node, 'element').map(convertPattern), span };
    }
    case 'as': {
      return {
        kind: 'pas',
        name: plainName(required(node, 'bind')),
        pat: convertPattern(required(node, 'pattern')),
        span,
      };
    }
    case 'record': {
      return convertRecordPattern(node, span);
    }
    case 'infix_chain': {
      return { kind: 'pchain', items: chainItems(node, convertPattern), span };
    }
    case 'signature': {
      throw unsupportedError(span, 'パターンの型シグネチャ');
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}
