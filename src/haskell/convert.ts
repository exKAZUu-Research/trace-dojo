// code-gauge-allow-file fileNcss -- The syntax-tree conversion covers every node kind of the grammar in one pass.
import type { Node, Tree } from '@willbooster/web-tree-sitter';

import type { CompileError } from '../interpreter/diagnostics';
import { compileError as syntaxError, unsupportedError } from './errors';
import { Extensions } from './extensions';
import { parseCharLiteral, parseNumberLiteral, parseStringLiteral } from './literals';
import { sourceColumns } from './sourceCoordinates';
import type {
  Alt,
  ChainItem,
  ConDecl,
  Constraint,
  Decl,
  DerivingClause,
  DerivingStrategy,
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
  TyVarBinder,
} from './syntax';

/** What each node type stands for, in the message that rejects it. */
const UNSUPPORTED_NODES: Record<string, string> = {
  abstract_family: '型族',
  binding_list: 'パターンシノニム',
  constructor_synonym: 'パターンシノニム',
  constructor_synonyms: 'パターンシノニム',
  data_family: 'データ族（data family）',
  data_instance: 'データ族のインスタンス（data instance）',
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
  invisible: '型変数の明示的な束縛（@a）',
  kind_application: '種類の適用（@k）',
  label: 'ラベル（#name）',
  linear_function: '線形型（%1 ->）',
  modifier: '多重度の注釈（%1）',
  pattern_synonym: 'パターンシノニム',
  promoted: '昇格した構成子（DataKinds）',
  rec: 'rec ブロック（RecursiveDo）',
  role_annotation: '型の役割の注釈（type role）',
  type_role: '型の役割の注釈（type role）',
  type_binder: 'パターンの型の束縛（@a）',
  type_family: '型族',
  type_family_injectivity: '型族',
  type_family_result: '型族',
  type_instance: '型族のインスタンス',
  unboxed_sum: 'ボックス化されない和型',
  unboxed_tuple: 'ボックス化されないタプル',
  unboxed_unit: 'ボックス化されないタプル',
  prefix_unboxed_sum: 'ボックス化されない和型',
  prefix_unboxed_tuple: 'ボックス化されないタプル',
  special: '特別な構成子の宣言',
  empty_list: "昇格したリスト（'[]）",
  pragma: 'プラグマ（{-# ... #-}）',
  cpp: 'C プリプロセッサの指令',
  via: 'deriving via',
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

/** The language extensions of the module being converted. */
let extensions = new Extensions();

/** Converts a module's parse tree into the surface syntax, rejecting syntax this environment does not support. */
export function convertModule(root: Node, moduleExtensions: Extensions, defaultName = 'Main'): Module {
  extensions = moduleExtensions;
  checkPragmas(root);
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
    extensions,
    exports: header ? convertExports(header) : undefined,
    imports,
    decls,
    span: spanOf(root),
  };
}

function checkPragmas(root: Node): void {
  const cpp = root.descendantsOfType('cpp')[0];
  if (cpp) throw syntaxError(spanOf(cpp), '書き方に誤りがあります。');
  for (const pragma of root.descendantsOfType('pragma')) {
    if (pragma) checkPragma(pragma);
  }
  if (!extensions.has('UnicodeSyntax')) {
    const unicode = root.descendantsOfType(UNICODE_TOKENS)[0];
    if (unicode)
      throw syntaxError(spanOf(unicode), `Unicode の記号 ${unicode.type} を使うには、UnicodeSyntax の拡張が要ります。`);
  }
}

/** Pragmas that only guide optimization, profiling, warnings, or messages, which do not change what a program does. */
const ADVISORY_PRAGMAS = new Set([
  'INLINE',
  'NOINLINE',
  'INLINABLE',
  'INLINEABLE',
  'OPAQUE',
  'NOTINLINE',
  'SPECIALIZE',
  'SPECIALISE',
  'SCC',
  'MINIMAL',
  'COMPLETE',
  'UNPACK',
  'NOUNPACK',
  'DEPRECATED',
  'WARNING',
  'LINE',
  'COLUMN',
  'RULES',
  'ANN',
  'CTYPE',
  'SOURCE',
  'CORE',
  'GENERATED',
]);

/** The pragmas that name a binding defined beside them. */
const BINDING_PRAGMAS = new Set(['INLINE', 'NOINLINE', 'INLINABLE', 'INLINEABLE', 'OPAQUE', 'NOTINLINE']);

function checkPragma(pragma: Node): void {
  const match = /^\{-#\s*([A-Za-z_]+)\s*([^]*?)\s*#-\}$/.exec(pragma.text);
  if (!match) return;
  const keyword = match[1].toUpperCase();
  if (keyword === 'LANGUAGE' || keyword.startsWith('OPTIONS') || keyword === 'INCLUDE') return;
  if (['OVERLAPPING', 'OVERLAPPABLE', 'OVERLAPS', 'INCOHERENT'].includes(keyword)) {
    throw unsupportedError(spanOf(pragma), `重なるインスタンス（${keyword}）`);
  }
  if (!ADVISORY_PRAGMAS.has(keyword)) return;
  if (BINDING_PRAGMAS.has(keyword)) {
    const name = /^(?:\[~?\d+\]\s*)?(\([^)]*\)|[^\s]+)/.exec(match[2])?.[1].replaceAll(/[()\s]/g, '');
    if (name && !bindsNearby(pragma, name)) {
      throw syntaxError(spanOf(pragma), `${keyword} プラグマの ${name} に、同じ場所で定義された関数がありません。`);
    }
  }
}

/** Whether the declarations a pragma stands among define a name, as GHC requires of an `INLINE` pragma. */
function bindsNearby(pragma: Node, name: string): boolean {
  let scope = pragma.parent;
  if (scope?.type === 'imports' || scope?.type === 'header') scope = scope.parent;
  if (scope?.type === 'haskell') scope = field(scope, 'declarations') ?? scope;
  else if (scope?.type === 'where_clause' || scope?.type === 'let' || scope?.type === 'let_in') {
    scope = field(scope, 'binds') ?? scope;
  }
  if (!scope) return false;
  return namedChildren(scope).some((decl) => {
    const nameNode = field(decl, 'name') ?? (decl.type === 'bind' ? field(decl, 'pattern') : undefined);
    if (nameNode && plainNameText(nameNode) === name) return true;
    const head = field(decl, 'head');
    const operator = head && (field(head, 'operator') ?? fields(head, 'operator')[0]);
    if (operator && plainNameText(operator) === name) return true;
    const names = decl.type === 'signature' ? field(decl, 'names') : undefined;
    return names ? fields(names, 'name').some((node) => plainNameText(node) === name) : false;
  });
}

function plainNameText(node: Node): string {
  return node.text.replaceAll(/[()`\s]/g, '');
}

/** The Unicode forms of `->`, `<-`, `::`, `=>`, and `forall`, which GHC accepts only with UnicodeSyntax. */
const UNICODE_TOKENS = ['→', '←', '∷', '⇒', '∀', '⊸', '★'];

function moduleName(node: Node): string {
  return node.text.replaceAll(/\s+/g, '').replace(/\.$/, '');
}

function convertExports(header: Node): ImportItem[] | undefined {
  const exportsNode = field(header, 'exports');
  if (!exportsNode) return undefined;
  const items: ImportItem[] = [];
  for (const child of namedChildren(exportsNode)) {
    rejectUnsupported(child);
    if (child.type === 'module_export') {
      const module = required(child, 'module');
      items.push({ kind: 'module', name: { name: moduleName(module), span: spanOf(child) } });
    } else if (child.type === 'default_export') {
      if (!extensions.has('NamedDefaults')) {
        throw syntaxError(spanOf(child), 'default の export には、NamedDefaults の拡張が要ります。');
      }
    } else if (child.type === 'export') {
      items.push(convertImportItem(child, true));
    }
  }
  return items;
}

/** The modules of the containers package, which `import "containers"` may name. */
const CONTAINERS_MODULES = /^Data\.(Map|Set|IntMap|IntSet|Sequence|Tree|Graph|Containers)(\.|$)/;

function convertImport(node: Node): Import {
  const level = field(node, 'level');
  if (level) throw unsupported(level);
  const packageNode = field(node, 'package');
  if (packageNode) {
    if (!extensions.has('PackageImports')) {
      throw syntaxError(spanOf(packageNode), 'パッケージを指定した import には、PackageImports の拡張が要ります。');
    }
    const name = packageNode.text.slice(1, -1);
    const module = moduleName(required(node, 'module'));
    if (name !== 'base' && name !== 'containers') {
      throw unsupportedError(spanOf(packageNode), `base・containers 以外のパッケージ（${name}）`);
    }
    if ((name === 'containers') !== CONTAINERS_MODULES.test(module)) {
      throw syntaxError(spanOf(packageNode), `モジュール ${module} は、パッケージ ${name} にはありません。`);
    }
  }
  if (hasToken(node, 'safe') && !['Safe', 'Trustworthy', 'Unsafe'].some((name) => extensions.has(name))) {
    throw syntaxError(spanOf(node), 'safe を付けた import には、Safe・Trustworthy・Unsafe のどれかの拡張が要ります。');
  }
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
  if (namespace && !extensions.has('ExplicitNamespaces') && !extensions.has('TypeOperators')) {
    throw syntaxError(spanOf(namespace), 'type・data の名前空間を書くには、ExplicitNamespaces の拡張が要ります。');
  }
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
    const elements = fields(childrenNode, 'element').map((element) => {
      rejectUnsupported(element);
      if (element.type !== 'namespaced_child') return element;
      return (
        field(element, 'constructor') ??
        field(element, 'variable') ??
        field(element, 'operator') ??
        field(element, 'type') ??
        namedChildren(element).at(-1) ??
        element
      );
    });
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
    case 'newtype': {
      return [convertNewtype(node)];
    }
    case 'deriving_instance': {
      return [convertStandaloneDeriving(node)];
    }
    case 'kind_signature': {
      if (!extensions.has('StandaloneKindSignatures')) {
        throw syntaxError(spanOf(node), '独立した種類のシグネチャには、StandaloneKindSignatures の拡張が要ります。');
      }
      return [
        { kind: 'kindSig', name: typeDeclName(node), kindSig: convertType(required(node, 'kind')), span: spanOf(node) },
      ];
    }
    case 'default_types': {
      const cls = field(node, 'class');
      if (cls && !extensions.has('NamedDefaults')) {
        throw syntaxError(spanOf(cls), 'クラスを指定した default 宣言には、NamedDefaults の拡張が要ります。');
      }
      return [
        {
          kind: 'defaultTypes',
          cls: cls ? qualifiedName(cls).name : undefined,
          types: fields(node, 'type').map(convertType),
          span: spanOf(node),
        },
      ];
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
    case 'pattern_guard': {
      if (!extensions.has('PatternGuards')) {
        throw syntaxError(spanOf(node), 'パターンガードを使うには、PatternGuards の拡張が要ります。');
      }
      return {
        kind: 'pat',
        pat: convertPattern(required(node, 'pattern')),
        expr: convertExpr(required(node, 'expression')),
        span: spanOf(node),
      };
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

// code-gauge-allow functionCognitiveComplexity -- Each branch rejects one unsupported form of a data declaration.
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
  return {
    kind: 'data',
    name: typeDeclName(node),
    params: typeParams(node),
    cons,
    deriving: convertDerivingClauses(node),
    span: spanOf(node),
    paramKinds: typeParamKinds(node),
  };
}

function convertDerivingClauses(node: Node): DerivingClause[] {
  const deriving: DerivingClause[] = [];
  for (const derivingNode of fields(node, 'deriving')) {
    const strategy = derivingStrategy(derivingNode);
    const classes = required(derivingNode, 'classes');
    for (const cls of derivingClasses(classes)) deriving.push({ cls, strategy, span: cls.span });
  }
  return deriving;
}

/** The strategy a `deriving` clause or standalone declaration names, if any. */
function derivingStrategy(node: Node): DerivingStrategy | undefined {
  const via = field(node, 'via');
  if (via) {
    if (!extensions.has('DerivingVia'))
      throw syntaxError(spanOf(via), 'deriving via を使うには、DerivingVia の拡張が要ります。');
    throw unsupported(via);
  }
  const strategyNode = field(node, 'strategy');
  if (!strategyNode) return undefined;
  if (!extensions.has('DerivingStrategies')) {
    throw syntaxError(spanOf(strategyNode), 'deriving の戦略を書くには、DerivingStrategies の拡張が要ります。');
  }
  const strategy = strategyNode.text.trim() as DerivingStrategy;
  if (strategy === 'anyclass' && !extensions.has('DeriveAnyClass')) {
    throw syntaxError(spanOf(strategyNode), 'deriving anyclass を使うには、DeriveAnyClass の拡張が要ります。');
  }
  if (strategy === 'newtype')
    throw unsupportedError(spanOf(strategyNode), 'newtype の deriving（GeneralizedNewtypeDeriving）');
  return strategy;
}

function convertStandaloneDeriving(node: Node): Decl {
  if (!extensions.has('StandaloneDeriving')) {
    throw syntaxError(spanOf(node), '独立した deriving 宣言を使うには、StandaloneDeriving の拡張が要ります。');
  }
  for (const name of ['forall', 'head']) {
    const child = field(node, name);
    if (child) throw unsupported(child);
  }
  const strategy = derivingStrategy(node);
  const contextNode = field(node, 'context');
  const nameNode = required(node, 'name');
  const types = fields(node, 'patterns').flatMap((patternsNode) => namedChildren(patternsNode));
  if (types.length !== 1) {
    throw unsupportedError(spanOf(node), types.length === 0 ? '型を書かないインスタンス' : '多引数の型クラス');
  }
  return {
    kind: 'standaloneDeriving',
    context: contextNode ? convertContext(contextNode) : [],
    cls: qualifiedName(nameNode).name,
    type: convertType(types[0]),
    strategy,
    span: spanOf(node),
  };
}

function convertNewtype(node: Node): Decl {
  for (const name of ['context', 'forall', 'kind', 'head']) {
    const child = field(node, name);
    if (child) {
      if (name === 'context') throw unsupportedError(spanOf(child), 'newtype 宣言の文脈（DatatypeContexts）');
      if (name === 'head') throw unsupportedError(spanOf(child), '演算子の型の宣言（TypeOperators）');
      throw unsupported(child);
    }
  }
  const constructor = required(node, 'constructor');
  const fieldNode = required(constructor, 'field');
  let con: ConDecl;
  if (fieldNode.type === 'record') {
    const fieldDecl = required(fieldNode, 'field');
    con = {
      name: plainName(required(constructor, 'name')),
      fields: [convertNewtypeField(required(fieldDecl, 'type'))],
      fieldNames: [plainName(required(fieldDecl, 'name'))],
      isInfix: false,
      span: spanOf(constructor),
    };
  } else {
    const typeNode = field(fieldNode, 'type') ?? namedChildren(fieldNode)[0];
    if (!typeNode) throw syntaxError(spanOf(fieldNode), '書き方に誤りがあります。');
    con = {
      name: plainName(required(constructor, 'name')),
      fields: [convertNewtypeField(typeNode)],
      isInfix: false,
      span: spanOf(constructor),
    };
  }
  return {
    kind: 'data',
    name: typeDeclName(node),
    params: typeParams(node),
    cons: [con],
    deriving: convertDerivingClauses(node),
    span: spanOf(node),
    newtype: true,
    paramKinds: typeParamKinds(node),
  };
}

function convertNewtypeField(node: Node): TypeExpr {
  if (node.type === 'strict_field' || node.type === 'lazy_field') {
    throw syntaxError(spanOf(node), 'newtype の構成子のフィールドには、! や ~ を付けられません。');
  }
  return convertFieldType(node);
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
  return typeParamBinders(node).map((binder) => binder.name);
}

/** The kinds a declaration's parameters' annotations give, or `undefined` when none has one. */
function typeParamKinds(node: Node): (TypeExpr | undefined)[] | undefined {
  const kinds = typeParamBinders(node).map((binder) => binder.kind);
  return kinds.some((kind) => kind !== undefined) ? kinds : undefined;
}

function typeParamBinders(node: Node): TyVarBinder[] {
  return fields(node, 'patterns').flatMap((patterns) => {
    if (patterns.type !== 'type_params') throw unsupported(patterns);
    return namedChildren(patterns).map(convertBinder);
  });
}

/** A type variable binder: `a`, `(a :: k)`, or `{a}`, which a `forall` or a declaration's head binds. */
function convertBinder(node: Node): TyVarBinder {
  switch (node.type) {
    case 'variable': {
      return { name: plainName(node) };
    }
    case 'parens': {
      const inner = namedChildren(node)[0];
      if (!inner) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
      return convertBinder(inner);
    }
    case 'annotated': {
      return { name: plainName(required(node, 'bind')), kind: convertKind(required(node, 'kind')) };
    }
    case 'inferred': {
      const inner = field(node, 'bind') ?? namedChildren(node)[0];
      if (!inner) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
      return { ...convertBinder(inner), inferred: true };
    }
    default: {
      rejectUnsupported(node);
      throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    }
  }
}

/** Converts a kind, which reads as a type: `Type`, `*`, `Constraint`, `k1 -> k2`, or a kind variable. */
function convertKind(node: Node): TypeExpr {
  if (!extensions.has('KindSignatures') && !extensions.has('PolyKinds')) {
    throw syntaxError(spanOf(node), '種類の注釈を書くには、KindSignatures の拡張が要ります。');
  }
  return convertType(node);
}

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
  if (node.type === 'strict_field') return convertType(required(node, 'type'));
  if (node.type === 'lazy_field') {
    if (!extensions.has('StrictData')) {
      throw syntaxError(spanOf(node), 'フィールドに ~ を付けるには、StrictData の拡張が要ります。');
    }
    return convertType(required(node, 'type'));
  }
  rejectUnsupported(node);
  return convertType(node);
}

/** Whether constructing a value evaluates a field first: one marked `!`, or any not marked `~` under StrictData. */
function isStrictField(node: Node): boolean {
  return node.type === 'strict_field' || (extensions.has('StrictData') && node.type !== 'lazy_field');
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
    paramKinds: typeParamKinds(node),
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
  const binders = typeParamBinders(node);
  const params = binders.map((binder) => binder.name);
  if (params.length !== 1) {
    throw unsupportedError(spanOf(node), params.length === 0 ? '型変数のないクラス' : '多引数の型クラス');
  }
  const contextNode = field(node, 'context');
  const declarationsNode = field(node, 'declarations');
  const decls = declarationsNode
    ? fields(declarationsNode, 'declaration').flatMap((child) => {
        if (child.type === 'default_signature') {
          if (!extensions.has('DefaultSignatures')) {
            throw syntaxError(spanOf(child), 'default のシグネチャを使うには、DefaultSignatures の拡張が要ります。');
          }
          return [{ ...convertSignature(required(child, 'signature')), isDefault: true } as Decl];
        }
        rejectUnsupported(child);
        return convertDecl(child);
      })
    : [];
  return {
    kind: 'class',
    context: contextNode ? convertContext(contextNode) : [],
    name: typeDeclName(node),
    param: params[0],
    paramKind: binders[0].kind,
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
  if (node.type === 'forall') {
    if (!extensions.has('ExplicitForAll')) {
      throw syntaxError(spanOf(node), 'forall を使うには、ExplicitForAll の拡張が要ります。');
    }
    const variables = required(node, 'variables');
    const inner = convertSigType(required(node, 'type'));
    if (inner.forall) throw unsupportedError(spanOf(node), '入れ子の forall');
    return { ...inner, forall: namedChildren(variables).map(convertBinder), span: spanOf(node) };
  }
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
    case 'qualified':
    case 'variable': {
      return [convertType(node)];
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

// code-gauge-allow functionCognitiveComplexity -- One case per type node kind of the grammar.
// code-gauge-allow functionNcss -- One case per type node kind of the grammar.
function convertType(node: Node): TypeExpr {
  const span = spanOf(node);
  if (node.type === 'prefix_tuple') {
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
    case 'star': {
      if (!extensions.has('StarIsType'))
        throw syntaxError(span, '* を種類として使うには、StarIsType の拡張が要ります。');
      return { kind: 'tcon', name: { name: '*', span }, span };
    }
    case 'parens': {
      const inner = field(node, 'type') ?? namedChildren(node)[0];
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      if (inner.type === 'signature') {
        return {
          kind: 'tkinded',
          type: convertType(required(inner, 'type')),
          kindSig: convertKind(required(inner, 'kind')),
          span,
        };
      }
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

// code-gauge-allow functionNcss -- One short case per expression node kind of the grammar.
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
      if (argument.type === 'type_application') {
        if (!extensions.has('TypeApplications')) {
          throw syntaxError(spanOf(argument), '型の適用（@）を使うには、TypeApplications の拡張が要ります。');
        }
        const typeNode = required(argument, 'type');
        const type = typeNode.type === 'wildcard' ? undefined : convertType(typeNode);
        return { kind: 'tyapp', expr: convertExpr(fn), type, span };
      }
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
    case 'prefix_tuple': {
      return { kind: 'con', name: { name: node.text.replaceAll(/\s+/g, ''), span }, span };
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
    case 'lambda_case':
    case 'lambda_cases': {
      return convertLambdaCase(node, span);
    }
    case 'multi_way_if': {
      return convertMultiWayIf(node, span);
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
  if (node.text === '_') return { kind: 'hole', name: '_', span };
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
      return convertTupleExpr(node, span);
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
      const branches = fields(node, 'qualifiers').map((qualifiers) =>
        fields(qualifiers, 'qualifier').map(convertStatement)
      );
      if (branches.length > 1 && !extensions.has('ParallelListComp')) {
        throw syntaxError(span, '並列の内包表記を使うには、ParallelListComp の拡張が要ります。');
      }
      return {
        kind: 'comprehension',
        expr: convertExpr(required(node, 'expression')),
        quals: branches[0] ?? [],
        span,
        ...(branches.length > 1 ? { parallel: branches.slice(1) } : {}),
      };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

/** A tuple, or a tuple section such as `(, x)`, which is a function of the missing elements. */
function convertTupleExpr(node: Node, span: Span): Expr {
  const slots: (Expr | undefined)[] = [undefined];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child || isComment(child)) continue;
    if (child.type === ',') slots.push(undefined);
    else if (node.fieldNameForChild(index) === 'element') slots[slots.length - 1] = convertExpr(child);
  }
  if (slots.every((slot) => slot !== undefined)) return { kind: 'tuple', elems: slots as Expr[], span };
  if (!extensions.has('TupleSections')) {
    throw syntaxError(span, 'タプルの節を使うには、TupleSections の拡張が要ります。');
  }
  const pats: Pat[] = [];
  const elems = slots.map((slot) => {
    if (slot) return slot;
    const name = generatedName('section', pats.length);
    pats.push({ kind: 'pvar', name: { name, span }, span });
    return { kind: 'var', name: { name, span }, span } as Expr;
  });
  return { kind: 'lambda', pats, body: { kind: 'tuple', elems, span }, span };
}

/**
 * A name for a variable the conversion introduces, which no program can spell, since it holds a space; traces do not
 * show such variables.
 */
export function generatedName(purpose: string, index: number): string {
  return ` ${purpose}${index}`;
}

/** Converts `\case` into a lambda of a `case`, and `\cases` into one of a `case` of a tuple of its parameters. */
function convertLambdaCase(node: Node, span: Span): Expr {
  const what = node.type === 'lambda_case' ? String.raw`\case` : String.raw`\cases`;
  if (!extensions.has('LambdaCase')) throw syntaxError(span, `${what} を使うには、LambdaCase の拡張が要ります。`);
  const alternatives = field(node, 'alternatives');
  const alternativeNodes = alternatives ? fields(alternatives, 'alternative') : [];
  if (node.type === 'lambda_case') {
    if (alternativeNodes.length === 0 && !extensions.has('EmptyCase')) {
      throw syntaxError(span, String.raw`選択肢のない \case を使うには、EmptyCase の拡張が要ります。`);
    }
    const name = generatedName('case', 0);
    const alts = alternativeNodes.map(convertAlternative);
    return lambdaOf([name], { kind: 'case', scrutinee: varOf(name, span), alts, span, what }, span);
  }
  const clauses = alternativeNodes.map((alternative) => {
    const patternsNode = field(alternative, 'patterns');
    const pats = patternsNode
      ? namedChildren(patternsNode).map(convertPattern)
      : [convertPattern(required(alternative, 'pattern'))];
    return { pats, rhs: convertRhs(alternative, '->'), span: spanOf(alternative) };
  });
  const arity = clauses[0]?.pats.length ?? 0;
  if (arity === 0) throw unsupportedError(span, String.raw`引数のない \cases`);
  for (const clause of clauses) {
    if (clause.pats.length !== arity)
      throw syntaxError(clause.span, String.raw`\cases の選択肢の引数の数が揃っていません。`);
  }
  const names = Array.from({ length: arity }, (_, index) => generatedName('cases', index));
  const scrutinee =
    arity === 1
      ? varOf(names[0], span)
      : ({ kind: 'tuple', elems: names.map((name) => varOf(name, span)), span } as Expr);
  const alts: Alt[] = clauses.map((clause) => ({
    pat: clause.pats.length === 1 ? clause.pats[0] : { kind: 'ptuple', elems: clause.pats, span: clause.span },
    rhs: clause.rhs,
    span: clause.span,
  }));
  return lambdaOf(names, { kind: 'case', scrutinee, alts, span, what }, span);
}

/** Converts a multi-way `if` into a `case` of `()` whose only alternative has the guards. */
function convertMultiWayIf(node: Node, span: Span): Expr {
  if (!extensions.has('MultiWayIf'))
    throw syntaxError(span, '複数の分岐の if を使うには、MultiWayIf の拡張が要ります。');
  const branches: GuardedExpr[] = fields(node, 'match').map((match) => {
    checkSeparator(match, '->');
    const guardsNode = field(match, 'guards');
    if (!guardsNode) throw syntaxError(spanOf(match), 'ガード（|）が足りません。');
    return {
      guards: fields(guardsNode, 'guard').map(convertGuard),
      expr: convertExpr(required(match, 'expression')),
      span: spanOf(match),
    };
  });
  const unit: Expr = { kind: 'con', name: { name: '()', span }, span };
  return {
    kind: 'case',
    scrutinee: unit,
    alts: [{ pat: { kind: 'pwild', span }, rhs: { body: { kind: 'guarded', branches }, where: [], span }, span }],
    span,
    what: 'multi-way if',
  };
}

function varOf(name: string, span: Span): Expr {
  return { kind: 'var', name: { name, span }, span };
}

function lambdaOf(names: string[], body: Expr, span: Span): Expr {
  return {
    kind: 'lambda',
    pats: names.map((name) => ({ kind: 'pvar', name: { name, span }, span }) as Pat),
    body,
    span,
  };
}

function convertBlock(node: Node, span: Span): Expr {
  switch (node.type) {
    case 'case': {
      const scrutinee = unnamedFieldChildren(node)[0];
      if (!scrutinee) throw syntaxError(span, '書き方に誤りがあります。');
      const alternatives = field(node, 'alternatives');
      if ((!alternatives || fields(alternatives, 'alternative').length === 0) && !extensions.has('EmptyCase')) {
        throw syntaxError(span, '選択肢のない case を使うには、EmptyCase の拡張が要ります。');
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
  let wildcard: Span | undefined;
  const fieldPatterns = fields(node, 'field').flatMap((fieldNode) => {
    rejectUnsupported(fieldNode);
    const wildcardNode = namedChildren(fieldNode).find((child) => child.type === 'wildcard');
    if (wildcardNode) {
      wildcard = recordWildcard(wildcardNode);
      return [];
    }
    const fieldName = qualifiedName(required(fieldNode, 'field')).name;
    const pattern = field(fieldNode, 'pattern');
    const fieldSpan = spanOf(fieldNode);
    return [
      {
        field: fieldName,
        pat: pattern
          ? convertPattern(pattern)
          : ({
              kind: 'pvar',
              name: { name: punnedName(fieldName, fieldSpan), span: fieldSpan },
              span: fieldSpan,
            } as Pat),
        span: fieldSpan,
      },
    ];
  });
  return { kind: 'precord', con: con.con, fields: fieldPatterns, span, wildcard };
}

/** The variable a punned field `x` (or `M.x`) binds or reads, which requires NamedFieldPuns. */
function punnedName(field: QName, span: Span): string {
  if (!extensions.has('NamedFieldPuns')) {
    throw syntaxError(span, 'フィールド名だけを書くには、NamedFieldPuns の拡張が要ります。');
  }
  return field.name;
}

function recordWildcard(node: Node): Span {
  if (!extensions.has('RecordWildCards')) {
    throw syntaxError(spanOf(node), 'レコードの .. を使うには、RecordWildCards の拡張が要ります。');
  }
  return spanOf(node);
}

function convertRecordExpr(node: Node): Expr {
  const span = spanOf(node);
  const target = required(node, 'expression');
  let wildcard: Span | undefined;
  const fieldBinds: FieldBind[] = fields(node, 'field').flatMap((fieldNode) => {
    rejectUnsupported(fieldNode);
    if (fieldNode.type !== 'field_update') throw syntaxError(spanOf(fieldNode), '書き方に誤りがあります。');
    const wildcardNode = namedChildren(fieldNode).find((child) => child.type === 'wildcard');
    if (wildcardNode) {
      wildcard = recordWildcard(wildcardNode);
      return [];
    }
    const fieldNameNode = required(fieldNode, 'field');
    rejectUnsupported(fieldNameNode);
    const fieldName = qualifiedName(fieldNameNode).name;
    const value = field(fieldNode, 'expression');
    const fieldSpan = spanOf(fieldNode);
    return [
      {
        field: fieldName,
        value: value ? convertExpr(value) : varOf(punnedName(fieldName, fieldSpan), fieldSpan),
        span: fieldSpan,
      },
    ];
  });
  const converted = convertExpr(target);
  if (converted.kind === 'con') return { kind: 'recordCon', con: converted.name, fields: fieldBinds, span, wildcard };
  if (wildcard) throw syntaxError(wildcard, 'レコードの更新には、.. は書けません。');
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
    const negated = fieldName === 'operator' ? tightNegation(child, node.child(index + 1)) : undefined;
    if (negated && convertOperand === (convertExpr as unknown)) {
      // NegativeLiterals and LexicalNegation read `f -1` as `f (-1)`: the minus belongs to what follows it.
      const operand = negated as unknown as T;
      const previous = items.at(-1);
      if (previous?.kind === 'operand') {
        const fn = previous.value as unknown as Expr;
        const arg = operand as unknown as Expr;
        previous.value = {
          kind: 'app',
          fn,
          arg,
          span: { ...fn.span, endRow: arg.span.endRow, endCol: arg.span.endCol },
        } as unknown as T;
      } else items.push({ kind: 'operand', value: operand });
      index++;
      continue;
    }
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

/**
 * The negation a minus right before its operand stands for, as NegativeLiterals reads `-1` and LexicalNegation reads
 * `-x`, when the minus is not right after another token.
 */
function tightNegation(operator: Node, next: Node | null): Expr | undefined {
  if (!next || operator.text !== '-' || next.startIndex !== operator.endIndex) return undefined;
  const before = operator.tree.rootNode.text[operator.startIndex - 1] ?? ' ';
  if (!/[\s([,;]/.test(before)) return undefined;
  const isNumber = next.type === 'literal' && ['integer', 'float'].includes(namedChildren(next)[0]?.type ?? '');
  if (!(extensions.has('LexicalNegation') || (isNumber && extensions.has('NegativeLiterals')))) return undefined;
  const span = { ...spanOf(operator), endRow: spanOf(next).endRow, endCol: spanOf(next).endCol };
  const operand = convertExpr(next);
  if (operand.kind === 'lit' && operand.lit.kind === 'int') {
    return { kind: 'lit', lit: { kind: 'int', value: -operand.lit.value }, span };
  }
  return { kind: 'paren', expr: { kind: 'neg', expr: operand, span }, span };
}

function convertLiteral(node: Node): SourceLiteral {
  const span = spanOf(node);
  switch (node.type) {
    case 'integer':
    case 'float': {
      const literal = parseNumberLiteral(node.text, span, extensions);
      return literal.kind === 'int' ? { ...literal, text: node.text } : literal;
    }
    case 'char': {
      return { kind: 'char', value: parseCharLiteral(node.text, span), text: node.text };
    }
    case 'string': {
      return {
        kind: 'string',
        value: parseStringLiteral(node.text, span, extensions.has('MultilineStrings')),
        text: node.text,
      };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Patterns

// code-gauge-allow functionNcss -- One short case per pattern node kind of the grammar.
export function convertPattern(node: Node): Pat {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
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
    case 'variable':
    case 'constructor':
    case 'qualified':
    case 'prefix_id': {
      const { name, isConstructor } = qualifiedName(node);
      if (isConstructor || name.name.startsWith(':')) return { kind: 'pcon', con: name, args: [], span };
      if (name.qualifier) throw syntaxError(span, 'パターンには、修飾されていない変数か構成子を書いてください。');
      return { kind: 'pvar', name: { name: name.name, span }, span };
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
      return { ...convertPattern(inner), span };
    }
    case 'tuple': {
      const elements = fields(node, 'element');
      return { kind: 'ptuple', elems: elements.map(convertPattern), span };
    }
    case 'unit': {
      return { kind: 'pcon', con: { name: '()', span }, args: [], span };
    }
    case 'prefix_tuple': {
      return { kind: 'pcon', con: { name: node.text.replaceAll(/\s+/g, ''), span }, args: [], span };
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
    case 'strict': {
      if (!extensions.has('BangPatterns'))
        throw syntaxError(span, '! のパターンを使うには、BangPatterns の拡張が要ります。');
      return { kind: 'pbang', pat: convertPattern(required(node, 'pattern')), span };
    }
    case 'irrefutable': {
      return { kind: 'plazy', pat: convertPattern(required(node, 'pattern')), span };
    }
    case 'view_pattern': {
      if (!extensions.has('ViewPatterns'))
        throw syntaxError(span, 'ビューパターンを使うには、ViewPatterns の拡張が要ります。');
      const expression = required(node, 'expression');
      return {
        kind: 'pview',
        expr: convertExpr(expression),
        exprText: expression.text,
        pat: convertPattern(required(node, 'pattern')),
        span,
      };
    }
    case 'or_pattern': {
      if (!extensions.has('OrPatterns'))
        throw syntaxError(span, 'or パターンを使うには、OrPatterns の拡張が要ります。');
      return { kind: 'por', alts: fields(node, 'alternative').map(convertPattern), span };
    }
    case 'signature': {
      if (!extensions.has('ScopedTypeVariables')) {
        throw syntaxError(span, 'パターンに型シグネチャを書くには、ScopedTypeVariables の拡張が要ります。');
      }
      return {
        kind: 'psig',
        pat: convertPattern(required(node, 'pattern')),
        type: convertType(required(node, 'type')),
        span,
      };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}
