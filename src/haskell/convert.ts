import type { Node, Tree } from '@willbooster/web-tree-sitter';

import type { CompileError } from '../interpreter/diagnostics';
// code-gauge-allow-file fileNcss -- The syntax-tree conversion covers every node kind of the grammar in one pass.
import { unboxedSumConName, unboxedTupleName } from './builtinTypes';
import { compileError as syntaxError, unsupportedError } from './errors';
import type { Extensions } from './extensions';
import type { FeatureGates } from './features';
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
  Multiplicity,
  Name,
  Operator,
  OverlapMode,
  Pat,
  QName,
  Rhs,
  Role,
  SigType,
  SourceLiteral,
  Span,
  Stmt,
  TypeEquation,
  TypeExpr,
  TyVarBinder,
} from './syntax';
import { QuoteBuilder } from './thQuote';

/** What each node type this environment does not support stands for, in the message that rejects it. */
export const UNSUPPORTED_NODES: Record<string, string> = {
  cpp: 'C プリプロセッサの指令',
  calling_convention: '外部の関数の宣言（foreign）',
  entity: '外部の関数の宣言（foreign）',
  safety: '外部の関数の宣言（foreign）',
  foreign_import: '外部の関数の宣言（foreign import）',
  foreign_export: '外部の関数の宣言（foreign export）',
};

/**
 * The node types the converter reads only through their text or their parent, never by their type, with how. Every
 * other node type of the grammar is either converted by its type, reached through a field the converter reads, or
 * rejected as unsupported, which a test checks against the grammar.
 */
export const GENERIC_NODES: Record<string, string> = {
  content: 'the text of a comment, which conversion skips',
  module_id: 'a part of a module name, read with the name as text',
  constructor_synonym: 'a constructor of a COMPLETE-like list, read through its parent constructor_synonyms',
  field_pattern: 'a field of a record pattern, read through its own fields',
  quoted_expression: 'the expression of a quote, which convertQuote reads when the quote holds no other kind',
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

/** Converts a module's parse tree into the surface syntax, rejecting syntax this environment does not support. */
export function convertModule(root: Node, extensions: Extensions, defaultName = 'Main'): Module {
  const features = extensions.gates('convert');
  checkPragmas(features, root);
  const header = namedChildren(root).find((child) => child.type === 'header');
  const importsNode = field(root, 'imports');
  const declarationsNode = field(root, 'declarations');
  // An import for splices only (`import splice M`) gives the program that runs a splice its names, not this module.
  const imports = importsNode
    ? fields(importsNode, 'import')
        .filter((node) => field(node, 'level')?.text.trim() !== 'splice')
        .map((node) => convertImport(features, node))
    : [];
  const decls: Decl[] = [];
  if (declarationsNode) {
    for (const child of namedChildren(declarationsNode)) {
      if (child.type === 'import') {
        throw syntaxError(spanOf(child), 'import は、宣言より前に書いてください。');
      }
      decls.push(...convertTopDecl(features, child));
    }
  }
  return {
    name: header ? moduleName(required(header, 'module')) : defaultName,
    extensions,
    exports: header ? convertExports(features, header) : undefined,
    imports,
    decls,
    span: spanOf(root),
  };
}

function checkPragmas(features: FeatureGates<'convert'>, root: Node): void {
  const cpp = root.descendantsOfType('cpp')[0];
  if (cpp) throw syntaxError(spanOf(cpp), '書き方に誤りがあります。');
  for (const pragma of root.descendantsOfType('pragma')) {
    if (pragma) checkPragma(pragma);
  }
  if (!features.allows('unicodeSyntax')) {
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
    if (pragma.parent?.type !== 'instance') {
      throw syntaxError(spanOf(pragma), `${keyword} プラグマは、instance の直後に書いてください。`);
    }
    return;
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
  if (scope?.type === 'haskell' || scope?.type === 'instance' || scope?.type === 'class') {
    scope = field(scope, 'declarations') ?? scope;
  } else if (scope?.type === 'where_clause' || scope?.type === 'let' || scope?.type === 'let_in') {
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

function convertExports(features: FeatureGates<'convert'>, header: Node): ImportItem[] | undefined {
  const exportsNode = field(header, 'exports');
  if (!exportsNode) return undefined;
  const items: ImportItem[] = [];
  for (const child of namedChildren(exportsNode)) {
    rejectUnsupported(child);
    if (child.type === 'module_export') {
      const module = required(child, 'module');
      items.push({ kind: 'module', name: { name: moduleName(module), span: spanOf(child) } });
    } else if (child.type === 'default_export') {
      if (!features.allows('namedDefaults')) {
        throw syntaxError(spanOf(child), 'default の export には、NamedDefaults の拡張が要ります。');
      }
    } else if (child.type === 'export') {
      items.push(convertImportItem(features, child, true));
    }
  }
  return items;
}

/** The modules of the containers package, which `import "containers"` may name. */
const CONTAINERS_MODULES = /^Data\.(Map|Set|IntMap|IntSet|Sequence|Tree|Graph|Containers)(\.|$)/;

function convertImport(features: FeatureGates<'convert'>, node: Node): Import {
  const level = field(node, 'level');
  if (level && !features.allows('levelImports')) {
    throw syntaxError(spanOf(level), 'import に段階を書くには、ExplicitLevelImports の拡張が要ります。');
  }
  const packageNode = field(node, 'package');
  if (packageNode) {
    if (!features.allows('packageImports')) {
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
  if (hasToken(node, 'safe') && !features.allows('safeImports')) {
    throw syntaxError(spanOf(node), 'safe を付けた import には、Safe・Trustworthy・Unsafe のどれかの拡張が要ります。');
  }
  const namesNode = field(node, 'names');
  const aliasNode = field(node, 'alias');
  return {
    module: moduleName(required(node, 'module')),
    qualified: hasToken(node, 'qualified'),
    alias: aliasNode ? moduleName(aliasNode) : undefined,
    hiding: hasToken(node, 'hiding') || (namesNode !== undefined && hasToken(namesNode, 'hiding')),
    items: namesNode ? fields(namesNode, 'name').map((node) => convertImportItem(features, node)) : undefined,
    span: spanOf(node),
  };
}

function convertImportItem(features: FeatureGates<'convert'>, node: Node, exporting = false): ImportItem {
  const nameOf = (name: Node): QName => (exporting ? qualifiedName(name).name : plainName(name));
  const namespace = field(node, 'namespace');
  if (namespace && !features.allows('namespaceKeyword')) {
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

function convertTopDecl(features: FeatureGates<'convert'>, node: Node): Decl[] {
  // Pragmas among declarations only guide the compiler, which checkPragmas has checked.
  if (node.type === 'pragma') return [];
  rejectUnsupported(node);
  switch (node.type) {
    case 'data_type': {
      return [convertData(features, node)];
    }
    case 'newtype': {
      return [convertNewtype(features, node)];
    }
    case 'deriving_instance': {
      return [convertStandaloneDeriving(features, node)];
    }
    case 'role_annotation': {
      return [convertRoleAnnotation(features, node)];
    }
    case 'pattern_synonym': {
      return [convertPatternSynonym(features, node)];
    }
    case 'kind_signature': {
      if (!features.allows('standaloneKindSignatures')) {
        throw syntaxError(spanOf(node), '独立した種類のシグネチャには、StandaloneKindSignatures の拡張が要ります。');
      }
      return [
        {
          kind: 'kindSig',
          name: typeDeclName(features, node),
          kindSig: convertType(features, required(node, 'kind')),
          span: spanOf(node),
        },
      ];
    }
    case 'default_types': {
      const cls = field(node, 'class');
      if (cls && !features.allows('namedDefaults')) {
        throw syntaxError(spanOf(cls), 'クラスを指定した default 宣言には、NamedDefaults の拡張が要ります。');
      }
      return [
        {
          kind: 'defaultTypes',
          cls: cls ? qualifiedName(cls).name : undefined,
          types: fields(node, 'type').map((node) => convertType(features, node)),
          span: spanOf(node),
        },
      ];
    }
    case 'type_synonym': {
      return [convertTypeSynonym(features, node)];
    }
    case 'type_family':
    case 'type_instance':
    case 'data_family':
    case 'data_instance': {
      return [convertFamilyDecl(features, node)];
    }
    case 'class': {
      return convertClassWithFamilies(features, node);
    }
    case 'instance': {
      return convertInstanceWithFamilies(features, node);
    }
    default: {
      return convertDecl(features, node);
    }
  }
}

/** Converts a declaration that may appear in a `let`, a `where`, a class, an instance, or at the top level. */
function convertDecl(features: FeatureGates<'convert'>, node: Node): Decl[] {
  if (node.type === 'pragma') return [];
  rejectUnsupported(node);
  switch (node.type) {
    case 'signature': {
      return [convertSignature(features, node)];
    }
    case 'fixity': {
      return [convertFixity(node)];
    }
    case 'function': {
      return [convertFunction(features, node)];
    }
    case 'bind': {
      return [convertBind(features, node)];
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

function convertSignature(features: FeatureGates<'convert'>, node: Node): Decl {
  const namesNode = field(node, 'names');
  const nameNode = field(node, 'name');
  for (const name of ['synonym', 'kind', 'pattern', 'constraint', 'expression']) {
    const child = field(node, name);
    if (child) throw syntaxError(spanOf(child), '書き方に誤りがあります。');
  }
  const names = namesNode ? fields(namesNode, 'name').map(plainName) : nameNode ? [plainName(nameNode)] : [];
  if (names.length === 0) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  const span = spanOf(node);
  return { kind: 'sig', names, sig: { ...convertSigType(features, required(node, 'type')), span }, span };
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

function convertFunction(features: FeatureGates<'convert'>, node: Node): Decl {
  for (const name of ['parameter', 'result', 'arrow']) {
    if (field(node, name)) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  }
  const head = field(node, 'head');
  const rhs = convertRhs(features, node, '=');
  if (head) {
    // An operator or backticked function defined infix: `x .+ y = ...`, possibly with more arguments after `(x .+ y)`.
    const operator = field(head, 'operator') ?? fields(head, 'operator')[0];
    if (!operator) throw syntaxError(spanOf(head), '書き方に誤りがあります。');
    const op = convertOperator(operator);
    if (op.qualifier) throw syntaxError(spanOf(operator), '修飾された名前は、ここには書けません。');
    if (op.isConstructor) throw syntaxError(spanOf(operator), '構成子は、関数として定義できません。');
    const left = strictPattern(features, convertPattern(features, required(head, 'left_operand')));
    const right = strictPattern(features, convertPattern(features, required(head, 'right_operand')));
    const extra = fields(node, 'patterns').flatMap((patterns) =>
      namedChildren(patterns).map((child) => strictPattern(features, convertPattern(features, child)))
    );
    return {
      kind: 'funClause',
      name: { name: op.name, span: op.span },
      args: [left, right, ...extra],
      rhs,
      span: spanOf(node),
    };
  }
  const nameNode = required(node, 'name');
  const patterns = fields(node, 'patterns').flatMap((patternsNode) =>
    namedChildren(patternsNode).map((child) => strictPattern(features, convertPattern(features, child)))
  );
  return { kind: 'funClause', name: plainName(nameNode), args: patterns, rhs, span: spanOf(node) };
}

function convertBind(features: FeatureGates<'convert'>, node: Node): Decl {
  const implicitName = field(node, 'implicit');
  if (implicitName) throw syntaxError(spanOf(implicitName), '暗黙のパラメータは、let ... in の中でだけ束縛できます。');
  const multiplicity = field(node, 'multiplicity');
  if (multiplicity) throw unsupported(multiplicity);
  if (field(node, 'arrow')) throw syntaxError(spanOf(node), '<- は、do の中にだけ書けます。');
  const rhs = convertRhs(features, node, '=');
  const nameNode = field(node, 'name');
  if (nameNode) {
    if (nameNode.type === 'prefix_id') {
      const op = convertOperator(namedChildren(nameNode)[0] ?? nameNode);
      if (op.isConstructor) throw syntaxError(spanOf(nameNode), '構成子は、関数として定義できません。');
    }
    return { kind: 'funClause', name: plainName(nameNode), args: [], rhs, span: spanOf(node) };
  }
  const pattern = convertPattern(features, required(node, 'pattern'));
  if (pattern.kind === 'pvar') return { kind: 'funClause', name: pattern.name, args: [], rhs, span: spanOf(node) };
  return { kind: 'patBind', pat: pattern, rhs, span: spanOf(node) };
}

function convertRhs(features: FeatureGates<'convert'>, node: Node, separator: '=' | '->'): Rhs {
  const matches = fields(node, 'match');
  if (matches.length === 0) throw syntaxError(spanOf(node), `「${separator}」が足りません。`);
  const whereNode = field(node, 'binds');
  const { decls: where, forced } = strictBindings(
    features,
    whereNode ? convertLocalBinds(features, field(whereNode, 'binds')) : []
  );
  const rhs = convertRhsBody(features, node, separator, matches, where);
  if (forced.length === 0) return rhs;
  // The banged bindings of a where are evaluated before the guards are.
  const span = rhs.span;
  if (rhs.body.kind === 'plain') return { ...rhs, body: { kind: 'plain', expr: forcing(forced, rhs.body.expr, span) } };
  const truth: Expr = { kind: 'con', name: { name: 'True', span }, span };
  const guard: Guard = { kind: 'bool', expr: forcing(forced, truth, span), span };
  return {
    ...rhs,
    body: {
      kind: 'guarded',
      branches: rhs.body.branches.map((branch) => ({ ...branch, guards: [guard, ...branch.guards] })),
    },
  };
}

function convertRhsBody(
  features: FeatureGates<'convert'>,
  node: Node,
  separator: '=' | '->',
  matches: Node[],
  where: Decl[]
): Rhs {
  const first = matches[0];
  const last = matches.at(-1) as Node;
  const span = { ...spanOf(first), endRow: spanOf(last).endRow, endCol: spanOf(last).endCol };
  if (matches.length === 1 && !field(first, 'guards')) {
    checkSeparator(first, separator);
    return { body: { kind: 'plain', expr: convertExpr(features, required(first, 'expression')) }, where, span };
  }
  const branches: GuardedExpr[] = matches.map((match) => {
    checkSeparator(match, separator);
    const guardsNode = field(match, 'guards');
    if (!guardsNode) throw syntaxError(spanOf(match), 'ガード（|）が足りません。');
    return {
      guards: fields(guardsNode, 'guard').flatMap((node) => convertGuard(features, node)),
      expr: convertExpr(features, required(match, 'expression')),
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

/** A guard, as one or more: a `let` with banged bindings is followed by a guard that evaluates them. */
function convertGuard(features: FeatureGates<'convert'>, node: Node): Guard[] {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'boolean': {
      return [{ kind: 'bool', expr: convertExpr(features, namedChildren(node)[0] ?? node), span }];
    }
    case 'let': {
      const { decls, forced } = strictBindings(features, convertLocalBinds(features, field(node, 'binds')));
      const guard: Guard = { kind: 'let', decls, span };
      return forced.length === 0 ? [guard] : [guard, { kind: 'bool', expr: forcing(forced, trueOf(span), span), span }];
    }
    case 'pattern_guard': {
      if (!features.allows('patternGuards')) {
        throw syntaxError(spanOf(node), 'パターンガードを使うには、PatternGuards の拡張が要ります。');
      }
      return [
        {
          kind: 'pat',
          pat: convertPattern(features, required(node, 'pattern')),
          expr: convertExpr(features, required(node, 'expression')),
          span,
        },
      ];
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

function trueOf(span: Span): Expr {
  return { kind: 'con', name: { name: 'True', span }, span };
}

/** A `let` qualifier of a comprehension, followed by a guard that evaluates its banged bindings. */
function withForcedQualifier(features: FeatureGates<'convert'>, stmt: Stmt): Stmt[] {
  if (stmt.kind !== 'let') return [stmt];
  const { decls, forced } = strictBindings(features, stmt.decls);
  if (forced.length === 0) return [stmt];
  return [
    { kind: 'let', decls, span: stmt.span },
    { kind: 'exp', expr: forcing(forced, trueOf(stmt.span), stmt.span), span: stmt.span },
  ];
}

/** Under Strict, a pattern that binds is matched strictly, as if it had a `!`, unless it is lazy, `~p`. */
function strictPattern(features: FeatureGates<'convert'>, pat: Pat): Pat {
  if (!features.allows('strict') || pat.kind === 'plazy' || pat.kind === 'pbang') return pat;
  return { kind: 'pbang', pat, span: pat.span };
}

/**
 * The bindings of a `let` or `where`, with the ones a `!` makes strict (all of the variable bindings under Strict)
 * and the variables whose values must be evaluated before the body: `!x = e` evaluates `x`, and `!(a, b) = e`
 * binds a new variable to `e` to evaluate, which the pattern then matches.
 */
function strictBindings(features: FeatureGates<'convert'>, decls: Decl[]): { decls: Decl[]; forced: string[] } {
  const forced: string[] = [];
  const result: Decl[] = [];
  for (const decl of decls) {
    const banged =
      decl.kind === 'patBind' && decl.pat.kind === 'pbang'
        ? decl.pat.pat
        : decl.kind === 'funClause' && decl.args.length === 0 && features.allows('strict')
          ? ({ kind: 'pvar', name: decl.name, span: decl.span } as Pat)
          : undefined;
    if (!banged || (decl.kind !== 'patBind' && decl.kind !== 'funClause')) {
      result.push(decl);
      continue;
    }
    if (banged.kind === 'pvar') {
      forced.push(banged.name.name);
      result.push({ kind: 'funClause', name: banged.name, args: [], rhs: decl.rhs, span: decl.span });
      continue;
    }
    const name = generatedName('strict', forced.length);
    forced.push(name);
    result.push(
      { kind: 'funClause', name: { name, span: decl.span }, args: [], rhs: decl.rhs, span: decl.span },
      {
        kind: 'patBind',
        pat: banged,
        rhs: { body: { kind: 'plain', expr: varOf(name, decl.span) }, where: [], span: decl.span },
        span: decl.span,
      }
    );
  }
  return { decls: result, forced };
}

/** An expression that evaluates variables before it gives its value, `x `seq` e`. */
function forcing(names: string[], expr: Expr, span: Span): Expr {
  let result = expr;
  for (const name of names.toReversed()) {
    const seq: Expr = { kind: 'support', name: 'seq', span };
    result = { kind: 'app', fn: { kind: 'app', fn: seq, arg: varOf(name, span), span }, arg: result, span };
  }
  return result;
}

/** A `let` statement of a `do` block, followed by one that evaluates its banged bindings. */
function withForcedLets(features: FeatureGates<'convert'>, stmt: Stmt): Stmt[] {
  if (stmt.kind !== 'let') return [stmt];
  const { decls, forced } = strictBindings(features, stmt.decls);
  if (forced.length === 0) return [stmt];
  const unit: Expr = { kind: 'con', name: { name: '()', span: stmt.span }, span: stmt.span };
  const done: Expr = {
    kind: 'app',
    fn: { kind: 'support', name: 'return', span: stmt.span },
    arg: unit,
    span: stmt.span,
  };
  return [
    { kind: 'let', decls, span: stmt.span },
    { kind: 'exp', expr: forcing(forced, done, stmt.span), span: stmt.span },
  ];
}

function convertLocalBinds(features: FeatureGates<'convert'>, node: Node | undefined): Decl[] {
  if (!node) return [];
  return namedChildren(node).flatMap((child) => convertDecl(features, child));
}

function convertData(features: FeatureGates<'convert'>, node: Node, isInstance = false): Decl {
  const forallNode = field(node, 'forall');
  if (forallNode) throw unsupported(forallNode);
  const contextNode = field(node, 'context');
  if (contextNode && !features.allows('datatypeContexts')) {
    throw syntaxError(spanOf(contextNode), 'data 宣言に文脈を書くには、DatatypeContexts の拡張が要ります。');
  }
  const kindNode = field(node, 'kind');
  const constructorsNode = field(node, 'constructors');
  let cons: ConDecl[] = [];
  if (constructorsNode?.type === 'gadt_constructors') {
    if (!features.allows('gadtSyntax')) {
      throw syntaxError(spanOf(constructorsNode), 'GADT の構文を使うには、GADTSyntax の拡張が要ります。');
    }
    cons = fields(constructorsNode, 'constructor').flatMap((node) => convertGadtConstructor(features, node));
  } else if (constructorsNode)
    cons = fields(constructorsNode, 'constructor').map((node) => convertConstructor(features, node));
  if (cons.length === 0 && !constructorsNode && !features.allows('emptyDataDecls')) {
    throw syntaxError(spanOf(node), '構成子のない data 宣言には、EmptyDataDecls の拡張が要ります。');
  }
  return {
    ...(kindNode ? { kindSig: convertKind(features, kindNode) } : {}),
    ...(hasInvisibleBinder(node) ? { invisibleBinders: true } : {}),
    kind: 'data',
    name: typeDeclName(features, node),
    params: isInstance ? [] : typeParams(features, node),
    ...(contextNode ? { datatypeContext: convertContext(features, contextNode) } : {}),
    cons,
    deriving: convertDerivingClauses(features, node),
    span: spanOf(node),
    paramKinds: isInstance ? undefined : typeParamKinds(features, node),
  };
}

function convertDerivingClauses(features: FeatureGates<'convert'>, node: Node): DerivingClause[] {
  const deriving: DerivingClause[] = [];
  for (const derivingNode of fields(node, 'deriving')) {
    const { strategy, via } = derivingStrategy(features, derivingNode);
    const classes = required(derivingNode, 'classes');
    for (const cls of derivingClasses(classes)) deriving.push({ cls, strategy, via, span: cls.span });
  }
  return deriving;
}

/** The strategy a `deriving` clause or standalone declaration names, if any. */
function derivingStrategy(
  features: FeatureGates<'convert'>,
  node: Node
): { strategy?: DerivingStrategy; via?: TypeExpr } {
  const via = field(node, 'via');
  if (via) {
    if (!features.allows('derivingVia'))
      throw syntaxError(spanOf(via), 'deriving via を使うには、DerivingVia の拡張が要ります。');
    return { strategy: 'via', via: convertType(features, required(via, 'type')) };
  }
  const strategyNode = field(node, 'strategy');
  if (!strategyNode) return {};
  if (!features.allows('derivingStrategies')) {
    throw syntaxError(spanOf(strategyNode), 'deriving の戦略を書くには、DerivingStrategies の拡張が要ります。');
  }
  const strategy = strategyNode.text.trim() as DerivingStrategy;
  if (strategy === 'anyclass' && !features.allows('anyclassStrategy')) {
    throw syntaxError(spanOf(strategyNode), 'deriving anyclass を使うには、DeriveAnyClass の拡張が要ります。');
  }
  if (strategy === 'newtype' && !features.allows('newtypeStrategy')) {
    throw syntaxError(
      spanOf(strategyNode),
      'deriving newtype を使うには、GeneralizedNewtypeDeriving の拡張が要ります。'
    );
  }
  return { strategy };
}

/** The multiplicity of LinearTypes' arrow: `%1` or `⊸` (no modifier), `%Many`, `%One`, or a variable. */
function convertMultiplicity(node: Node | null | undefined): Multiplicity {
  if (!node) return { kind: 'one' };
  const inner = namedChildren(node)[0];
  const text = inner?.text.trim() ?? '';
  if (text === '1' || text === 'One') return { kind: 'one' };
  if (text === 'Many') return { kind: 'many' };
  if (inner?.type === 'variable') return { kind: 'var', name: text, span: spanOf(inner) };
  throw syntaxError(spanOf(node), `多重度 ${text} は書けません（%1・%Many・型変数のどれかを書いてください）。`);
}

/** Converts `type role T nominal _`. */
function convertRoleAnnotation(features: FeatureGates<'convert'>, node: Node): Decl {
  if (!features.allows('roleAnnotations')) {
    throw syntaxError(spanOf(node), '型の役割の注釈には、RoleAnnotations の拡張が要ります。');
  }
  const roles = fields(node, 'role').map((roleNode) => {
    const text = roleNode.text.trim();
    return text === '_' ? undefined : (text as Role);
  });
  return { kind: 'roleAnnotation', name: qualifiedName(required(node, 'type')).name, roles, span: spanOf(node) };
}

function convertStandaloneDeriving(features: FeatureGates<'convert'>, node: Node): Decl {
  if (!features.allows('standaloneDeriving')) {
    throw syntaxError(spanOf(node), '独立した deriving 宣言を使うには、StandaloneDeriving の拡張が要ります。');
  }
  for (const name of ['forall', 'head']) {
    const child = field(node, name);
    if (child) throw unsupported(child);
  }
  const { strategy, via } = derivingStrategy(features, node);
  const contextNode = field(node, 'context');
  const nameNode = required(node, 'name');
  const types = fields(node, 'patterns').flatMap((patternsNode) => namedChildren(patternsNode));
  if (types.length !== 1) {
    throw unsupportedError(spanOf(node), types.length === 0 ? '型を書かないインスタンス' : '多引数の型クラス');
  }
  return {
    kind: 'standaloneDeriving',
    context: contextNode ? convertContext(features, contextNode) : [],
    cls: qualifiedName(nameNode).name,
    type: convertType(features, types[0]),
    strategy,
    via,
    span: spanOf(node),
  };
}

/** Converts `pattern P x = p` and its variants, and `pattern P :: t`. */
function convertPatternSynonym(features: FeatureGates<'convert'>, node: Node): Decl {
  if (!features.allows('patternSynonyms')) {
    throw syntaxError(spanOf(node), 'パターンシノニムを使うには、PatternSynonyms の拡張が要ります。');
  }
  const span = spanOf(node);
  const inner = namedChildren(node)[0];
  if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
  if (inner.type === 'signature') {
    const synonym = required(inner, 'synonym');
    const names = synonym.type === 'binding_list' ? fields(synonym, 'name').map(plainName) : [plainName(synonym)];
    return { kind: 'patSynSig', names, sig: { ...convertSigType(features, required(inner, 'type')), span }, span };
  }
  const head = convertPatternSynonymHead(required(inner, 'synonym'));
  const constructors = field(inner, 'constructors');
  const builder = constructors
    ? namedChildren(constructors).map((clause): Decl => {
        const pattern = convertPatternSynonymHead(required(clause, 'pattern'));
        return {
          kind: 'funClause',
          name: pattern.name,
          args: pattern.params.map((param): Pat => ({ kind: 'pvar', name: param, span: param.span })),
          rhs: convertRhs(features, clause, '='),
          span: spanOf(clause),
        };
      })
    : undefined;
  return {
    kind: 'patSyn',
    ...head,
    pattern: convertPattern(features, required(inner, 'pattern')),
    direction: builder ? 'explicit' : hasToken(inner, '<-') ? 'unidirectional' : 'bidirectional',
    builder,
    span,
  };
}

/** The name and parameters of a pattern synonym's head: `P x y`, `x :> y`, or `P {x, y}`. */
function convertPatternSynonymHead(node: Node): { name: Name; params: Name[]; fields?: boolean; isInfix: boolean } {
  switch (node.type) {
    case 'apply': {
      const inner = convertPatternSynonymHead(required(node, 'function'));
      return { ...inner, params: [...inner.params, plainName(required(node, 'argument'))] };
    }
    case 'record': {
      const params = fields(node, 'field').map((fieldNode) => plainName(required(fieldNode, 'field')));
      return { name: plainName(required(node, 'constructor')), params, fields: true, isInfix: false };
    }
    case 'infix':
    case 'infix_chain': {
      const operands = [...fields(node, 'operand'), ...fields(node, 'left_operand'), ...fields(node, 'right_operand')];
      const operator = fields(node, 'operator')[0];
      if (!operator || operands.length !== 2) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
      return { name: plainName(operator), params: operands.map((operand) => plainName(operand)), isInfix: true };
    }
    case 'parens': {
      return convertPatternSynonymHead(namedChildren(node)[0] ?? node);
    }
    default: {
      return { name: plainName(node), params: [], isInfix: false };
    }
  }
}

/** Converts the declarations of type families and data families, and their instances. */
/** Converts `type family F a`, with its result kind and injectivity, or a closed family with its equations. */
function convertTypeFamily(features: FeatureGates<'convert'>, node: Node, span: Span): Decl {
  const equationsNode = field(node, 'closed_family');
  const resultNode = namedChildren(node).find((child) => child.type === 'type_family_result');
  const params = typeParams(features, node);
  const kindNode = field(node, 'kind');
  let resultKind = kindNode ? convertKind(features, kindNode) : undefined;
  const result = resultNode ? required(resultNode, 'result') : undefined;
  if (result && (result.type === 'parens' || result.type === 'annotated'))
    resultKind = convertBinder(features, result).kind;
  if (equationsNode?.type === 'abstract_family') {
    throw syntaxError(spanOf(equationsNode), '中身を書かない閉じた型族は、hs-boot ファイルにだけ書けます。');
  }
  return {
    kind: 'typeFamily',
    name: typeDeclName(features, node),
    params,
    paramKinds: typeParamKinds(features, node),
    resultKind,
    equations: equationsNode
      ? fields(equationsNode, 'equation').map((node) => convertEquation(features, node))
      : undefined,
    injective: familyInjectivity(features, node, params),
    span,
  };
}

/** The positions of the arguments an injectivity annotation, `= r | r -> a`, says a family's result determines. */
function familyInjectivity(features: FeatureGates<'convert'>, node: Node, params: Name[]): number[] | undefined {
  const injectivityNode = namedChildren(node).find((child) => child.type === 'type_family_injectivity');
  if (!injectivityNode) return undefined;
  if (!features.allows('typeFamilyDependencies')) {
    throw syntaxError(spanOf(injectivityNode), '単射の注釈には、TypeFamilyDependencies の拡張が要ります。');
  }
  return fields(injectivityNode, 'determined').map((determined) => {
    const index = params.findIndex((param) => param.name === determined.text);
    if (index === -1) throw syntaxError(spanOf(determined), `${determined.text} は、型族の引数ではありません。`);
    return index;
  });
}

function convertFamilyDecl(features: FeatureGates<'convert'>, node: Node): Decl {
  if (!features.allows('typeFamilies')) {
    throw syntaxError(spanOf(node), '型族やデータ族を使うには、TypeFamilies の拡張が要ります。');
  }
  const span = spanOf(node);
  switch (node.type) {
    case 'type_family': {
      return convertTypeFamily(features, node, span);
    }
    case 'type_instance': {
      return { kind: 'typeInstance', ...convertEquation(features, node) };
    }
    case 'data_family': {
      const kindNode = field(node, 'kind');
      return {
        kind: 'dataFamily',
        name: typeDeclName(features, node),
        params: typeParams(features, node),
        paramKinds: typeParamKinds(features, node),
        kindSig: kindNode ? convertKind(features, kindNode) : undefined,
        span,
      };
    }
    default: {
      const inner = namedChildren(node)[0];
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      const decl =
        inner.type === 'newtype' ? convertNewtype(features, inner, true) : convertData(features, inner, true);
      if (decl.kind !== 'data') throw syntaxError(span, '書き方に誤りがあります。');
      return {
        ...decl,
        instanceOf: {
          family: qualifiedName(required(inner, 'name')).name,
          patterns: instancePatterns(features, inner),
        },
        span,
      };
    }
  }
}

/** An equation of a type family: `F Int = Bool` in a closed family, or `type instance F Int = Bool`. */
function convertEquation(features: FeatureGates<'convert'>, node: Node): TypeEquation {
  const nameNode = required(node, 'name');
  const rhsNode = unnamedFieldChildren(node).at(-1);
  if (!rhsNode) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  return {
    family: qualifiedName(nameNode).name,
    patterns: instancePatterns(features, node),
    rhs: convertType(features, rhsNode),
    span: spanOf(node),
  };
}

function instancePatterns(features: FeatureGates<'convert'>, node: Node): TypeExpr[] {
  return fields(node, 'patterns').flatMap((patterns) =>
    namedChildren(patterns).map((node) => convertType(features, node))
  );
}

function convertNewtype(features: FeatureGates<'convert'>, node: Node, isInstance = false): Decl {
  for (const name of ['context', 'forall', 'kind']) {
    const child = field(node, name);
    if (child) {
      if (name === 'context') throw unsupportedError(spanOf(child), 'newtype 宣言の文脈（DatatypeContexts）');
      throw unsupported(child);
    }
  }
  const constructorsNode = field(node, 'constructors');
  let con: ConDecl;
  if (constructorsNode?.type === 'gadt_constructors') {
    if (!features.allows('gadtSyntax')) {
      throw syntaxError(spanOf(constructorsNode), 'GADT の構文を使うには、GADTSyntax の拡張が要ります。');
    }
    const cons = fields(constructorsNode, 'constructor').flatMap((node) => convertGadtConstructor(features, node));
    if (cons.length !== 1 || cons[0].fields.length !== 1) {
      throw syntaxError(spanOf(constructorsNode), 'newtype には、フィールドが 1 つの構成子を 1 つだけ書いてください。');
    }
    con = cons[0];
  } else {
    con = convertNewtypeConstructor(features, required(node, 'constructor'));
  }
  return {
    kind: 'data',
    name: typeDeclName(features, node),
    params: isInstance ? [] : typeParams(features, node),
    cons: [con],
    deriving: convertDerivingClauses(features, node),
    span: spanOf(node),
    newtype: true,
    paramKinds: isInstance ? undefined : typeParamKinds(features, node),
  };
}

function convertNewtypeConstructor(features: FeatureGates<'convert'>, constructor: Node): ConDecl {
  const fieldNode = required(constructor, 'field');
  let con: ConDecl;
  if (fieldNode.type === 'record') {
    const fieldDecl = required(fieldNode, 'field');
    con = {
      name: plainName(required(constructor, 'name')),
      fields: [convertNewtypeField(features, required(fieldDecl, 'type'))],
      fieldNames: [plainName(required(fieldDecl, 'name'))],
      isInfix: false,
      span: spanOf(constructor),
    };
  } else {
    const typeNode = field(fieldNode, 'type') ?? namedChildren(fieldNode)[0];
    if (!typeNode) throw syntaxError(spanOf(fieldNode), '書き方に誤りがあります。');
    con = {
      name: plainName(required(constructor, 'name')),
      fields: [convertNewtypeField(features, typeNode)],
      isInfix: false,
      span: spanOf(constructor),
    };
  }
  return con;
}

function convertNewtypeField(features: FeatureGates<'convert'>, node: Node): TypeExpr {
  if (node.type === 'strict_field' || node.type === 'lazy_field') {
    throw syntaxError(spanOf(node), 'newtype の構成子のフィールドには、! や ~ を付けられません。');
  }
  return convertFieldType(features, node);
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

function typeDeclName(features: FeatureGates<'convert'>, node: Node): Name {
  const head = field(node, 'head');
  if (head) {
    requireTypeOperators(features, head);
    return plainName(required(head, 'operator'));
  }
  const nameNode = required(node, 'name');
  if (nameNode.type !== 'name') {
    rejectUnsupported(nameNode);
    requireTypeOperators(features, nameNode);
  }
  return plainName(nameNode);
}

function requireImplicitParams(features: FeatureGates<'convert'>, span: Span): void {
  if (!features.allows('implicitParams'))
    throw syntaxError(span, '暗黙のパラメータを使うには、ImplicitParams の拡張が要ります。');
}

function requireDataKinds(features: FeatureGates<'convert'>, span: Span): void {
  if (!features.allows('promotedSyntax'))
    throw syntaxError(span, '型の中で構成子やリテラルを使うには、DataKinds の拡張が要ります。');
}

/** Converts what a tick promotes: a constructor, `'[]`, a list `'[a, b]`, or a tuple `'(a, b)`. */
function convertPromoted(features: FeatureGates<'convert'>, inner: Node, span: Span): TypeExpr {
  switch (inner.type) {
    case 'empty_list': {
      return { kind: 'tpromoted', name: { name: '[]', span }, span };
    }
    case 'list': {
      return {
        kind: 'tpromotedList',
        elems: fields(inner, 'element').map((node) => convertType(features, node)),
        span,
      };
    }
    case 'tuple': {
      return {
        kind: 'tpromotedTuple',
        elems: fields(inner, 'element').map((node) => convertType(features, node)),
        span,
      };
    }
    case 'unit': {
      return { kind: 'tpromoted', name: { name: '()', span }, span };
    }
    default: {
      return { kind: 'tpromoted', name: qualifiedName(inner).name, span };
    }
  }
}

function requireTypeOperators(features: FeatureGates<'convert'>, node: Node): void {
  if (!features.allows('typeOperators')) {
    throw syntaxError(spanOf(node), '演算子の型を使うには、TypeOperators の拡張が要ります。');
  }
}

function typeParams(features: FeatureGates<'convert'>, node: Node): Name[] {
  return typeParamBinders(features, node).map((binder) => binder.name);
}

/** The kinds a declaration's parameters' annotations give, or `undefined` when none has one. */
function typeParamKinds(features: FeatureGates<'convert'>, node: Node): (TypeExpr | undefined)[] | undefined {
  const kinds = typeParamBinders(features, node).map((binder) => binder.kind);
  return kinds.some((kind) => kind !== undefined) ? kinds : undefined;
}

function typeParamBinders(features: FeatureGates<'convert'>, node: Node): TyVarBinder[] {
  const head = field(node, 'head');
  const headBinders = head ? fields(head, 'bind').map((node) => convertBinder(features, node)) : [];
  return [
    ...headBinders,
    ...fields(node, 'patterns').flatMap((patterns) => {
      if (patterns.type !== 'type_params') throw unsupported(patterns);
      // `@k` binds a kind variable, which the kinds of the other parameters name.
      return namedChildren(patterns)
        .filter((param) => {
          if (param.type !== 'invisible') return true;
          requireTypeAbstractions(features, spanOf(param));
          return false;
        })
        .map((node) => convertBinder(features, node));
    }),
  ];
}

function hasInvisibleBinder(node: Node): boolean {
  return fields(node, 'patterns').some((patterns) =>
    namedChildren(patterns).some((param) => param.type === 'invisible')
  );
}

function requireTypeAbstractions(features: FeatureGates<'convert'>, span: Span): void {
  if (!features.allows('typeAbstractions')) {
    throw syntaxError(span, '@ による型変数の束縛には、TypeAbstractions の拡張が要ります。');
  }
}

/** A type variable binder: `a`, `(a :: k)`, or `{a}`, which a `forall` or a declaration's head binds. */
function convertBinder(features: FeatureGates<'convert'>, node: Node): TyVarBinder {
  switch (node.type) {
    case 'variable': {
      return { name: plainName(node) };
    }
    case 'parens': {
      const inner = namedChildren(node)[0];
      if (!inner) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
      return convertBinder(features, inner);
    }
    case 'annotated': {
      return { name: plainName(required(node, 'bind')), kind: convertKind(features, required(node, 'kind')) };
    }
    case 'inferred': {
      const inner = field(node, 'bind') ?? namedChildren(node)[0];
      if (!inner) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
      return { ...convertBinder(features, inner), inferred: true };
    }
    default: {
      rejectUnsupported(node);
      throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    }
  }
}

/** Converts a kind, which reads as a type: `Type`, `*`, `Constraint`, `k1 -> k2`, or a kind variable. */
function convertKind(features: FeatureGates<'convert'>, node: Node): TypeExpr {
  if (!features.allows('kindSignatures')) {
    throw syntaxError(spanOf(node), '種類の注釈を書くには、KindSignatures の拡張が要ります。');
  }
  return convertType(features, node);
}

/** A constructor with its existential variables and constraints, `forall a. Show a => MkT a`. */
function convertConstructor(features: FeatureGates<'convert'>, node: Node): ConDecl {
  const forallNode = field(node, 'forall');
  const contextNode = field(node, 'context');
  const converted = convertConstructorBody(features, node);
  if (!forallNode && !contextNode) return converted;
  if (!features.allows('existentials')) {
    throw syntaxError(spanOf(node), '存在型の構成子には、ExistentialQuantification の拡張が要ります。');
  }
  return {
    ...converted,
    exVars: forallNode
      ? namedChildren(required(forallNode, 'variables')).map((node) => convertBinder(features, node))
      : [],
    context: contextNode ? convertContext(features, contextNode) : [],
  };
}

/** Converts `C1, C2 :: forall a. ctx => t1 -> t2 -> T a`, a constructor declared by its signature. */
function convertGadtConstructor(features: FeatureGates<'convert'>, node: Node): ConDecl[] {
  const forallNode = field(node, 'forall');
  const contextNode = field(node, 'context');
  const typeNode = required(node, 'type');
  const exVars = forallNode
    ? namedChildren(required(forallNode, 'variables')).map((node) => convertBinder(features, node))
    : undefined;
  const context = contextNode ? convertContext(features, contextNode) : [];
  let fieldTypes: TypeExpr[] = [];
  let fieldNames: Name[] | undefined;
  const strictFields: number[] = [];
  let result: TypeExpr;
  if (typeNode.type === 'record') {
    fieldNames = [];
    for (const fieldNode of fields(required(typeNode, 'fields'), 'field')) {
      const fieldType = required(fieldNode, 'type');
      for (const nameNode of fields(fieldNode, 'name')) {
        if (isStrictField(features, fieldType)) strictFields.push(fieldTypes.length);
        fieldNames.push(plainName(nameNode));
        fieldTypes.push(convertFieldType(features, fieldType));
      }
    }
    result = convertType(features, required(typeNode, 'type'));
  } else {
    let current = typeNode.type === 'prefix' ? required(typeNode, 'type') : typeNode;
    // A constructor's fields are linear, so an arrow of a multiplicity separates them like any other.
    while (current.type === 'function' || current.type === 'linear_function') {
      const parameter = required(current, 'parameter');
      if (isStrictField(features, parameter)) strictFields.push(fieldTypes.length);
      fieldTypes.push(convertFieldType(features, parameter));
      current = required(current, 'result');
    }
    if (current.type === 'context' || current.type === 'forall')
      throw unsupportedError(spanOf(current), '入れ子の forall');
    result = convertType(features, current);
  }
  return fields(node, 'name').map((nameNode) => ({
    name: plainName(nameNode),
    fields: fieldTypes,
    ...(fieldNames ? { fieldNames } : {}),
    ...(strictFields.length > 0 ? { strictFields } : {}),
    isInfix: false,
    span: spanOf(node),
    exVars,
    context,
    result,
  }));
}

function convertConstructorBody(features: FeatureGates<'convert'>, node: Node): ConDecl {
  const inner = required(node, 'constructor');
  rejectUnsupported(inner);
  if (inner.type === 'special') {
    // Only GHC's own modules declare `()`, `[]`, and tuples; a program cannot bind those names again.
    throw syntaxError(
      spanOf(inner),
      `既にある名前 ${inner.text.replaceAll(/[^(),[\]#]/g, '')} は、構成子として宣言できません。`
    );
  }
  switch (inner.type) {
    case 'prefix': {
      return convertPrefixConstructor(features, inner);
    }
    case 'infix': {
      const operator = fields(inner, 'operator')[0];
      if (!operator) throw syntaxError(spanOf(inner), '書き方に誤りがあります。');
      const op = convertOperator(operator);
      if (!op.isConstructor) throw syntaxError(spanOf(operator), '構成子の演算子は「:」で始めてください。');
      return {
        name: { name: op.name, span: op.span },
        ...constructorFields(features, [required(inner, 'left_operand'), required(inner, 'right_operand')]),
        isInfix: true,
        span: spanOf(inner),
      };
    }
    case 'record': {
      return convertRecordConstructor(features, inner);
    }
    default: {
      throw syntaxError(spanOf(inner), '書き方に誤りがあります。');
    }
  }
}

function convertRecordConstructor(features: FeatureGates<'convert'>, node: Node): ConDecl {
  const nameNode = required(node, 'name');
  const fieldsNode = field(node, 'fields');
  const fieldTypes: TypeExpr[] = [];
  const fieldNames: Name[] = [];
  const strictFields: number[] = [];
  for (const fieldNode of fieldsNode ? fields(fieldsNode, 'field') : []) {
    const typeNode = required(fieldNode, 'type');
    const type = convertFieldType(features, typeNode);
    for (const nameNode2 of fields(fieldNode, 'name')) {
      if (isStrictField(features, typeNode)) strictFields.push(fieldTypes.length);
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

function convertPrefixConstructor(features: FeatureGates<'convert'>, node: Node): ConDecl {
  if (field(node, 'type')) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
  const fieldNodes = fields(node, 'field');
  return {
    name: plainName(required(node, 'name')),
    ...constructorFields(features, fieldNodes),
    isInfix: false,
    span: spanOf(node),
  };
}

function constructorFields(features: FeatureGates<'convert'>, nodes: Node[]): Pick<ConDecl, 'fields' | 'strictFields'> {
  const strictFields = nodes.flatMap((node, index) => (isStrictField(features, node) ? [index] : []));
  return {
    fields: nodes.map((node) => convertFieldType(features, node)),
    ...(strictFields.length > 0 ? { strictFields } : {}),
  };
}

function convertFieldType(features: FeatureGates<'convert'>, node: Node): TypeExpr {
  if (node.type === 'strict_field') return convertType(features, required(node, 'type'));
  if (node.type === 'lazy_field') {
    if (!features.allows('strictData')) {
      throw syntaxError(spanOf(node), 'フィールドに ~ を付けるには、StrictData の拡張が要ります。');
    }
    return convertType(features, required(node, 'type'));
  }
  rejectUnsupported(node);
  return convertType(features, node);
}

/** Whether constructing a value evaluates a field first: one marked `!`, or any not marked `~` under StrictData. */
function isStrictField(features: FeatureGates<'convert'>, node: Node): boolean {
  return node.type === 'strict_field' || (features.allows('strictData') && node.type !== 'lazy_field');
}

function convertTypeSynonym(features: FeatureGates<'convert'>, node: Node): Decl {
  const typeNode = required(node, 'type');
  if (typeNode.type === 'signature') throw unsupported(typeNode);
  return {
    kind: 'typeSyn',
    name: typeDeclName(features, node),
    params: typeParams(features, node),
    paramKinds: typeParamKinds(features, node),
    type: convertQuantifiedType(features, typeNode),
    span: spanOf(node),
  };
}

/** The family declarations a class or instance holds, which become top-level declarations of their own. */
const FAMILY_NODES = new Set(['type_family', 'data_family', 'type_instance', 'data_instance']);

/**
 * Converts a class with its associated families, which become top-level families of the class; a `type instance`
 * in the class is its family's default, which instances that leave it out use.
 */
function convertClassWithFamilies(features: FeatureGates<'convert'>, node: Node): Decl[] {
  const cls = convertClass(features, node);
  if (cls.kind !== 'class') return [cls];
  const decls: Decl[] = [cls];
  for (const member of familyMembers(node)) {
    const decl = convertFamilyDecl(features, member);
    if (decl.kind === 'typeInstance') decls.push({ ...decl, defaultOf: cls.name.name });
    else if (decl.kind === 'typeFamily' || decl.kind === 'dataFamily')
      decls.push({ ...decl, associatedWith: cls.name.name });
    else throw syntaxError(spanOf(member), 'クラスの中には、data instance は書けません。');
  }
  return decls;
}

function convertInstanceWithFamilies(features: FeatureGates<'convert'>, node: Node): Decl[] {
  const instance = convertInstance(features, node);
  return [
    instance,
    ...familyMembers(node).map((member) => {
      if (member.type !== 'type_instance' && member.type !== 'data_instance') {
        throw syntaxError(spanOf(member), 'インスタンスの中には、型族やデータ族の宣言は書けません。');
      }
      return convertFamilyDecl(features, member);
    }),
  ];
}

function familyMembers(node: Node): Node[] {
  const declarationsNode = field(node, 'declarations');
  return declarationsNode
    ? fields(declarationsNode, 'declaration').filter((child) => FAMILY_NODES.has(child.type))
    : [];
}

function convertClass(features: FeatureGates<'convert'>, node: Node): Decl {
  const binders = typeParamBinders(features, node);
  const params = binders.map((binder) => binder.name);
  if (params.length !== 1 && !features.allows('multiParamClasses')) {
    throw syntaxError(spanOf(node), '型引数が1つでないクラスには、MultiParamTypeClasses の拡張が要ります。');
  }
  const fundepsNode = field(node, 'fundeps');
  if (fundepsNode && !features.allows('functionalDependencies')) {
    throw syntaxError(spanOf(fundepsNode), '関数従属性を書くには、FunctionalDependencies の拡張が要ります。');
  }
  const fundeps = (fundepsNode ? fields(fundepsNode, 'fundep') : []).map((fundep) => ({
    from: fields(fundep, 'matched').map(plainName),
    to: fields(fundep, 'determined').map(plainName),
  }));
  const contextNode = field(node, 'context');
  const declarationsNode = field(node, 'declarations');
  const decls = declarationsNode
    ? fields(declarationsNode, 'declaration').flatMap((child) => {
        if (FAMILY_NODES.has(child.type)) return [];
        if (child.type === 'default_signature') {
          if (!features.allows('defaultSignatures')) {
            throw syntaxError(spanOf(child), 'default のシグネチャを使うには、DefaultSignatures の拡張が要ります。');
          }
          return [{ ...convertSignature(features, required(child, 'signature')), isDefault: true } as Decl];
        }
        rejectUnsupported(child);
        return convertDecl(features, child);
      })
    : [];
  return {
    kind: 'class',
    context: contextNode ? convertContext(features, contextNode) : [],
    name: typeDeclName(features, node),
    params,
    paramKinds: binders.some((binder) => binder.kind) ? binders.map((binder) => binder.kind) : undefined,
    fundeps,
    decls,
    span: spanOf(node),
  };
}

function convertInstance(features: FeatureGates<'convert'>, node: Node): Decl {
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
  for (const type of types) rejectUnsupported(type);
  const declarationsNode = field(node, 'declarations');
  const decls = declarationsNode
    ? fields(declarationsNode, 'declaration').flatMap((child) => {
        if (FAMILY_NODES.has(child.type)) return [];
        rejectUnsupported(child);
        return convertDecl(features, child);
      })
    : [];
  const overlap = namedChildren(node)
    .filter((child) => child.type === 'pragma')
    .map((child) => /^\{-#\s*([A-Za-z]+)/.exec(child.text)?.[1].toUpperCase())
    .find((keyword): keyword is OverlapMode =>
      ['OVERLAPPING', 'OVERLAPPABLE', 'OVERLAPS', 'INCOHERENT'].includes(keyword ?? '')
    );
  return {
    kind: 'instance',
    context: contextNode ? convertContext(features, contextNode) : [],
    cls: qualifiedName(nameNode).name,
    types: types.map((node) => convertType(features, node)),
    decls,
    ...(overlap ? { overlap } : {}),
    // GHC reports an instance at its head, from the context to the type.
    span: {
      ...spanOf(contextNode?.firstChild ?? nameNode),
      endRow: spanOf(types.at(-1) ?? nameNode).endRow,
      endCol: spanOf(types.at(-1) ?? nameNode).endCol,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Types

function convertSigType(features: FeatureGates<'convert'>, node: Node): SigType {
  if (node.type === 'forall_required') {
    if (!features.allows('requiredTypeArguments')) {
      throw syntaxError(spanOf(node), 'forall a -> を使うには、RequiredTypeArguments の拡張が要ります。');
    }
    const variables = required(node, 'variables');
    const inner = convertSigType(features, required(node, 'type'));
    if (inner.forall) throw unsupportedError(spanOf(node), '入れ子の forall');
    return {
      ...inner,
      forall: namedChildren(variables).map((binder) => ({ ...convertBinder(features, binder), required: true })),
      span: spanOf(node),
    };
  }
  if (node.type === 'forall') {
    if (!features.allows('explicitForAll')) {
      throw syntaxError(spanOf(node), 'forall を使うには、ExplicitForAll の拡張が要ります。');
    }
    const variables = required(node, 'variables');
    const inner = convertSigType(features, required(node, 'type'));
    if (inner.forall) throw unsupportedError(spanOf(node), '入れ子の forall');
    return {
      ...inner,
      forall: namedChildren(variables).map((node) => convertBinder(features, node)),
      span: spanOf(node),
    };
  }
  rejectUnsupported(node);
  if (node.type === 'context') {
    const typeNode = field(node, 'type');
    if (!typeNode) throw syntaxError(spanOf(node), '書き方に誤りがあります。');
    const inner = convertSigType(features, typeNode);
    if (inner.context.length > 0) {
      return { context: [...convertContext(features, node), ...inner.context], type: inner.type, span: spanOf(node) };
    }
    return { context: convertContext(features, node), type: inner.type, span: spanOf(node) };
  }
  return { context: [], type: convertQuantifiedType(features, node), span: spanOf(node) };
}

function convertContext(features: FeatureGates<'convert'>, node: Node): Constraint[] {
  const constraint = field(node, 'constraint');
  if (constraint) throw syntaxError(spanOf(constraint), '書き方に誤りがあります。');
  const contextNode = required(node, 'context');
  return constraintsOf(features, contextNode);
}

function constraintsOf(features: FeatureGates<'convert'>, node: Node): Constraint[] {
  rejectUnsupported(node);
  switch (node.type) {
    case 'tuple': {
      return namedChildren(node).flatMap((node) => constraintsOf(features, node));
    }
    case 'parens': {
      const inner = namedChildren(node)[0];
      return inner ? constraintsOf(features, inner) : [];
    }
    case 'unit': {
      return [];
    }
    case 'apply':
    case 'name':
    case 'qualified':
    case 'variable': {
      return [convertType(features, node)];
    }
    case 'infix_chain': {
      return [convertType(features, node)];
    }
    case 'implicit_parameter': {
      requireImplicitParams(features, spanOf(node));
      return [
        {
          kind: 'timplicit',
          name: required(node, 'name').text.slice(1),
          type: convertType(features, required(node, 'type')),
          span: spanOf(node),
        },
      ];
    }
    default: {
      throw unsupportedError(spanOf(node), 'この形の制約');
    }
  }
}

/** Converts a type that may be polymorphic itself, `forall a. C a => t`, as a function's argument may be. */
function convertQuantifiedType(features: FeatureGates<'convert'>, node: Node): TypeExpr {
  if (node.type === 'forall' || node.type === 'context') {
    if (!features.allows('rankNTypes')) {
      throw syntaxError(spanOf(node), '型の内側の forall や制約には、RankNTypes の拡張が要ります。');
    }
    const sig = convertSigType(features, node);
    return { kind: 'tforall', binders: sig.forall ?? [], context: sig.context, body: sig.type, span: spanOf(node) };
  }
  rejectUnsupported(node);
  return convertType(features, node);
}

// code-gauge-allow functionCognitiveComplexity -- One case per type node kind of the grammar.
// code-gauge-allow functionNcss -- One case per type node kind of the grammar.
function convertType(features: FeatureGates<'convert'>, node: Node): TypeExpr {
  const span = spanOf(node);
  if (node.type === 'prefix_tuple') {
    return { kind: 'tcon', name: { name: node.text.replaceAll(/\s+/g, ''), span }, span };
  }
  if (node.type === 'forall') return convertQuantifiedType(features, node);
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
      const argument = required(node, 'argument');
      if (argument.type === 'kind_application') {
        requireTypeAbstractions(features, spanOf(argument));
        return {
          kind: 'tkindapp',
          type: convertType(features, constructor),
          kindArg: convertKind(features, required(argument, 'type')),
          span,
        };
      }
      return { kind: 'tapp', fn: convertType(features, constructor), arg: convertType(features, argument), span };
    }
    case 'function': {
      const parameter = required(node, 'parameter');
      const result = required(node, 'result');
      return {
        kind: 'tfun',
        from: convertQuantifiedType(features, parameter),
        to: convertQuantifiedType(features, result),
        span,
      };
    }
    case 'linear_function': {
      if (!features.allows('linearTypes')) {
        throw syntaxError(span, '線形型の矢印を使うには、LinearTypes の拡張が要ります。');
      }
      const parameter = required(node, 'parameter');
      const result = required(node, 'result');
      return {
        kind: 'tfun',
        from: convertQuantifiedType(features, parameter),
        to: convertQuantifiedType(features, result),
        multiplicity: convertMultiplicity(field(node, 'multiplicity')),
        span,
      };
    }
    case 'list': {
      const elements = fields(node, 'element');
      if (elements.length !== 1) throw unsupportedError(span, "昇格したリストの型（'[a, b]）");
      return { kind: 'tlist', elem: convertType(features, elements[0]), span };
    }
    case 'tuple': {
      const elements = fields(node, 'element');
      if (elements.length < 2) throw unsupportedError(span, 'タプルの型の節');
      return { kind: 'ttuple', elems: elements.map((node) => convertType(features, node)), span };
    }
    case 'unit': {
      return { kind: 'tcon', name: { name: '()', span }, span };
    }
    case 'unboxed_unit':
    case 'unboxed_tuple':
    case 'unboxed_sum':
    case 'prefix_unboxed_tuple':
    case 'prefix_unboxed_sum': {
      const { name, elems } = unboxedParts(features, node, true);
      let type: TypeExpr = { kind: 'tcon', name: { name, span }, span };
      for (const elem of elems) type = { kind: 'tapp', fn: type, arg: convertType(features, elem), span };
      return type;
    }
    case 'star': {
      // Whether `*` is the kind Type (StarIsType) or GHC.TypeLits' multiplication, the renamer decides.
      return { kind: 'tcon', name: { name: '*', span }, star: true, span };
    }
    case 'parens': {
      const inner = field(node, 'type') ?? namedChildren(node)[0];
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      if (inner.type === 'signature') {
        return {
          kind: 'tkinded',
          type: convertType(features, required(inner, 'type')),
          kindSig: convertKind(features, required(inner, 'kind')),
          span,
        };
      }
      const type = convertQuantifiedType(features, inner);
      // An application with `*` in it may be a product the renamer splits; a one-operand chain keeps the parentheses
      // so that the product never joins an enclosing chain.
      return hasStarArgument(type) ? { kind: 'tchain', items: [{ kind: 'operand', value: type }], span } : type;
    }
    case 'prefix_id': {
      const inner = namedChildren(node)[0];
      if (inner?.text === '->') return { kind: 'tcon', name: { name: '->', span }, span };
      if (inner?.text !== '~') requireTypeOperators(features, node);
      return { kind: 'tcon', name: qualifiedName(inner ?? node).name, span };
    }
    case 'infix_chain':
    case 'infix': {
      const items = chainItems(features, node, (operand) => convertQuantifiedType(features, operand));
      for (const item of items) {
        if (item.kind === 'operator' && item.op.name !== '~') requireTypeOperators(features, node);
        if (item.kind === 'negate') throw syntaxError(item.span, '書き方に誤りがあります。');
      }
      return { kind: 'tchain', items, span };
    }
    case 'literal': {
      requireDataKinds(features, span);
      const literal = convertLiteral(features, namedChildren(node)[0] ?? node);
      if (literal.kind === 'int') return { kind: 'tlit', value: literal.value, span };
      if (literal.kind === 'string') return { kind: 'tlit', value: literal.value.join(''), span };
      throw unsupportedError(span, 'この形の型のリテラル');
    }
    case 'promoted': {
      requireDataKinds(features, span);
      return convertPromoted(features, namedChildren(node)[0] ?? node, span);
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

/** A type argument, or `undefined` for the wildcard `_`, which leaves the type for inference. */
function wildcardOr(node: Node, convert: (node: Node) => TypeExpr): TypeExpr | undefined {
  return node.type === 'wildcard' ? undefined : convert(node);
}

/** Whether a type is an application with the `*` token among its parts. */
export function hasStarArgument(type: TypeExpr): boolean {
  let head = type;
  while (head.kind === 'tapp') {
    if (head.arg.kind === 'tcon' && head.arg.star) return true;
    head = head.fn;
  }
  return head !== type && head.kind === 'tcon' && head.star === true;
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions

// code-gauge-allow functionNcss -- One short case per expression node kind of the grammar.
export function convertExpr(features: FeatureGates<'convert'>, node: Node): Expr {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'variable':
    case 'constructor':
    case 'qualified':
    case 'prefix_id':
    case 'parenthesized_name':
    case 'typed_hole': {
      return convertNameExpression(node, span);
    }
    case 'quote':
    case 'typed_quote': {
      return convertQuote(features, node, span);
    }
    case 'th_quoted_name': {
      requireTemplateHaskell(features, span, true);
      const typeNode = field(node, 'type');
      const nameNode = typeNode ?? required(node, 'name');
      const { name, isConstructor } = qualifiedName(nameNode);
      return { kind: 'thName', name, namespace: typeNode ? 'type' : isConstructor ? 'con' : 'var', span };
    }
    case 'splice': {
      const inner = namedChildren(node)[0];
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      return {
        kind: 'thSplice',
        expr: convertExpr(features, inner.type === 'parens' ? required(inner, 'expression') : inner),
        span,
      };
    }
    case 'literal': {
      const literal: Expr = { kind: 'lit', lit: convertLiteral(features, namedChildren(node)[0] ?? node), span };
      if (literal.lit.kind !== 'string' || !features.allows('overloadedStrings')) return literal;
      return { kind: 'app', fn: { kind: 'support', name: 'overloadedFromString', span }, arg: literal, span };
    }
    case 'label': {
      if (!features.allows('overloadedLabels'))
        throw syntaxError(span, 'ラベルを使うには、OverloadedLabels の拡張が要ります。');
      return {
        kind: 'tyapp',
        expr: { kind: 'support', name: 'overloadedFromLabel', span },
        type: { kind: 'tlit', value: node.text.slice(1), span },
        span,
      };
    }
    case 'apply': {
      const fn = required(node, 'function');
      const argument = required(node, 'argument');
      if (argument.type === 'explicit_type') {
        if (!features.allows('typeArgumentKeyword')) {
          throw syntaxError(
            spanOf(argument),
            '(type t) を使うには、RequiredTypeArguments と ExplicitNamespaces の拡張が要ります。'
          );
        }
        return {
          kind: 'tyapp',
          expr: convertExpr(features, fn),
          type: wildcardOr(required(argument, 'type'), (typeNode) => convertType(features, typeNode)),
          required: true,
          span,
        };
      }
      if (argument.type === 'type_application') {
        if (!features.allows('typeApplications')) {
          throw syntaxError(spanOf(argument), '型の適用（@）を使うには、TypeApplications の拡張が要ります。');
        }
        const typeNode = required(argument, 'type');
        const type = typeNode.type === 'wildcard' ? undefined : convertType(features, typeNode);
        return { kind: 'tyapp', expr: convertExpr(features, fn), type, span };
      }
      rejectUnsupported(argument);
      return { kind: 'app', fn: convertExpr(features, fn), arg: convertExpr(features, argument), span };
    }
    case 'operator_chain': {
      return {
        kind: 'chain',
        items: chainItems(features, node, (operand) => convertExpr(features, operand), true),
        span,
      };
    }
    case 'parens': {
      const inner = field(node, 'expression');
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      return { kind: 'paren', expr: convertExpr(features, inner), span };
    }
    case 'tuple':
    case 'list':
    case 'arithmetic_sequence':
    case 'list_comprehension': {
      return convertCollection(features, node, span);
    }
    case 'unit': {
      return { kind: 'con', name: { name: '()', span }, span };
    }
    case 'unboxed_unit':
    case 'unboxed_tuple':
    case 'unboxed_sum':
    case 'prefix_unboxed_tuple': {
      const { name, elems } = unboxedParts(features, node, false);
      let expr: Expr = { kind: 'con', name: { name, span }, span };
      for (const elem of elems) expr = { kind: 'app', fn: expr, arg: convertExpr(features, elem), span };
      return expr;
    }
    case 'prefix_tuple': {
      return { kind: 'con', name: { name: node.text.replaceAll(/\s+/g, ''), span }, span };
    }
    case 'left_section':
    case 'right_section': {
      return convertSection(features, node, span);
    }
    case 'lambda': {
      const patterns = namedChildren(required(node, 'patterns')).map((child) =>
        strictPattern(features, convertPattern(features, child))
      );
      return { kind: 'lambda', pats: patterns, body: convertExpr(features, required(node, 'expression')), span };
    }
    case 'conditional': {
      return {
        kind: 'if',
        cond: convertExpr(features, required(node, 'if')),
        ifTrue: convertExpr(features, required(node, 'then')),
        ifFalse: convertExpr(features, required(node, 'else')),
        span,
      };
    }
    case 'case':
    case 'do': {
      return convertBlock(features, node, span);
    }
    case 'lambda_case':
    case 'lambda_cases': {
      return convertLambdaCase(features, node, span);
    }
    case 'multi_way_if': {
      return convertMultiWayIf(features, node, span);
    }
    case 'projection': {
      requireRecordDot(features, span);
      return {
        kind: 'projection',
        expr: convertExpr(features, required(node, 'expression')),
        field: fieldLabel(required(node, 'field')),
        span,
      };
    }
    case 'projection_selector': {
      requireRecordDot(features, span);
      const name = generatedName('record', 0);
      const fields = fieldsOfSelector(node);
      let body: Expr = varOf(name, span);
      for (const label of fields) body = { kind: 'projection', expr: body, field: label, span };
      return lambdaOf([name], body, span);
    }
    case 'let_in': {
      const bindsNode = field(node, 'binds');
      const implicitBinds = bindsNode ? namedChildren(bindsNode).filter((decl) => field(decl, 'implicit')) : [];
      if (implicitBinds.length > 0) {
        requireImplicitParams(features, span);
        if (implicitBinds.length !== namedChildren(bindsNode as Node).length) {
          throw syntaxError(span, '暗黙のパラメータの束縛と、ふつうの束縛は、同じ let には書けません。');
        }
        return {
          kind: 'implicitLet',
          binds: implicitBinds.map((decl) => ({
            name: (field(decl, 'implicit') as Node).text.slice(1),
            expr: convertExpr(features, required(required(decl, 'match'), 'expression')),
            span: spanOf(decl),
          })),
          body: convertExpr(features, required(node, 'expression')),
          span,
        };
      }
      const { decls, forced } = strictBindings(features, convertLocalBinds(features, bindsNode));
      return {
        kind: 'let',
        decls,
        body: forcing(forced, convertExpr(features, required(node, 'expression')), span),
        span,
      };
    }
    case 'implicit_variable': {
      requireImplicitParams(features, span);
      return { kind: 'implicit', name: node.text.slice(1), span };
    }
    case 'record': {
      return convertRecordExpr(features, node);
    }
    case 'signature': {
      const expression = field(node, 'expression');
      const type = field(node, 'type');
      if (!expression || !type) throw syntaxError(span, '書き方に誤りがあります。');
      return { kind: 'typed', expr: convertExpr(features, expression), sig: convertSigType(features, type), span };
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

function convertSection(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  if (node.type === 'left_section') {
    return {
      kind: 'leftSection',
      left: convertExpr(features, required(node, 'left_operand')),
      op: convertOperator(required(node, 'operator')),
      span,
    };
  }
  const operator = unnamedFieldChildren(node)[0];
  if (!operator) throw syntaxError(span, '書き方に誤りがあります。');
  return {
    kind: 'rightSection',
    op: convertOperator(operator),
    right: convertExpr(features, required(node, 'right_operand')),
    span,
  };
}

function convertCollection(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  switch (node.type) {
    case 'tuple': {
      return convertTupleExpr(features, node, span);
    }
    case 'list': {
      const list: Expr = {
        kind: 'list',
        elems: fields(node, 'element').map((node) => convertExpr(features, node)),
        span,
      };
      if (!features.allows('overloadedLists')) return list;
      const count: Expr = { kind: 'lit', lit: { kind: 'int', value: BigInt(list.elems.length) }, span };
      const fromListN: Expr = { kind: 'support', name: 'overloadedFromListN', span };
      return { kind: 'app', fn: { kind: 'app', fn: fromListN, arg: count, span }, arg: list, span };
    }
    case 'arithmetic_sequence': {
      const step = field(node, 'step');
      const to = field(node, 'to');
      const sequence: Expr = {
        kind: 'arith',
        from: convertExpr(features, required(node, 'from')),
        next: step ? convertExpr(features, step) : undefined,
        to: to ? convertExpr(features, to) : undefined,
        span,
      };
      if (!features.allows('overloadedLists')) return sequence;
      return { kind: 'app', fn: { kind: 'support', name: 'overloadedFromList', span }, arg: sequence, span };
    }
    case 'list_comprehension': {
      const branches = fields(node, 'qualifiers').map((qualifiers) =>
        fields(qualifiers, 'qualifier').flatMap((node) =>
          withForcedQualifier(features, convertStatement(features, node))
        )
      );
      if (branches.length > 1 && !features.allows('parallelListComp')) {
        throw syntaxError(span, '並列の内包表記を使うには、ParallelListComp の拡張が要ります。');
      }
      return {
        kind: 'comprehension',
        expr: convertExpr(features, required(node, 'expression')),
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
function convertTupleExpr(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  const slots: (Expr | undefined)[] = [undefined];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child || isComment(child)) continue;
    if (child.type === ',') slots.push(undefined);
    else if (node.fieldNameForChild(index) === 'element') slots[slots.length - 1] = convertExpr(features, child);
  }
  if (slots.every((slot) => slot !== undefined)) return { kind: 'tuple', elems: slots as Expr[], span };
  if (!features.allows('tupleSections')) {
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
function convertLambdaCase(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  const what = node.type === 'lambda_case' ? String.raw`\case` : String.raw`\cases`;
  if (!features.allows('lambdaCase')) throw syntaxError(span, `${what} を使うには、LambdaCase の拡張が要ります。`);
  const alternatives = field(node, 'alternatives');
  const alternativeNodes = alternatives ? fields(alternatives, 'alternative') : [];
  if (node.type === 'lambda_case') {
    if (alternativeNodes.length === 0 && !features.allows('emptyCase')) {
      throw syntaxError(span, String.raw`選択肢のない \case を使うには、EmptyCase の拡張が要ります。`);
    }
    const name = generatedName('case', 0);
    const alts = alternativeNodes.map((node) => convertAlternative(features, node));
    return lambdaOf([name], { kind: 'case', scrutinee: varOf(name, span), alts, span, what }, span);
  }
  const clauses = alternativeNodes.map((alternative) => {
    const patternsNode = field(alternative, 'patterns');
    const pats = patternsNode
      ? namedChildren(patternsNode).map((node) => convertPattern(features, node))
      : [convertPattern(features, required(alternative, 'pattern'))];
    return { pats, rhs: convertRhs(features, alternative, '->'), span: spanOf(alternative) };
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
function convertMultiWayIf(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  if (!features.allows('multiWayIf'))
    throw syntaxError(span, '複数の分岐の if を使うには、MultiWayIf の拡張が要ります。');
  const branches: GuardedExpr[] = fields(node, 'match').map((match) => {
    checkSeparator(match, '->');
    const guardsNode = field(match, 'guards');
    if (!guardsNode) throw syntaxError(spanOf(match), 'ガード（|）が足りません。');
    return {
      guards: fields(guardsNode, 'guard').flatMap((node) => convertGuard(features, node)),
      expr: convertExpr(features, required(match, 'expression')),
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

/**
 * The constructor (or, in a type, the type) an unboxed tuple or sum names, with its parts: `(# a, b #)` is `(#,#)`
 * applied to `a` and `b`; `(# | x #)` is the second alternative of two, `(#|_#)`, applied to `x`.
 */
function unboxedParts(features: FeatureGates<'convert'>, node: Node, inType: boolean): { name: string; elems: Node[] } {
  const span = spanOf(node);
  const sum = node.type === 'unboxed_sum' || node.type === 'prefix_unboxed_sum';
  if (!features.allows(sum ? 'unboxedSums' : 'unboxedTuples')) {
    const extension = sum ? 'UnboxedSums' : 'UnboxedTuples';
    throw syntaxError(span, `ボックス化されない${sum ? '和型' : 'タプル'}を使うには、${extension} の拡張が要ります。`);
  }
  const text = node.text.replaceAll(/\s+/g, '');
  if (node.type === 'prefix_unboxed_tuple') return { name: text === '(##)' ? '(# #)' : text, elems: [] };
  if (node.type === 'prefix_unboxed_sum') return { name: text, elems: [] };
  const elems = fields(node, 'element');
  if (node.type === 'unboxed_unit') return { name: unboxedTupleName(0), elems: [] };
  if (node.type === 'unboxed_tuple') return { name: unboxedTupleName(elems.length), elems };
  const bars = node.children.filter((child) => child?.type === '|').length;
  if (inType) return { name: `(#${'|'.repeat(bars)}#)`, elems };
  if (elems.length !== 1) throw syntaxError(span, 'ボックス化されない和型の値には、要素を 1 つ書いてください。');
  const element = elems[0];
  const before = node.children.filter((child) => child?.type === '|' && child.startIndex < element.startIndex).length;
  return { name: unboxedSumConName(before, bars + 1), elems };
}

function requireTemplateHaskell(features: FeatureGates<'convert'>, span: Span, quotes = false): void {
  if (!features.allows(quotes ? 'templateHaskellQuotes' : 'templateHaskell')) {
    throw syntaxError(span, 'Template Haskell を使うには、TemplateHaskell の拡張が要ります。');
  }
}

/** Converts a quote, `[| e |]`, `[p| p |]`, `[t| t |]`, `[d| ds |]`, or `[|| e ||]`, into code building its tree. */
function convertQuote(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  requireTemplateHaskell(features, span, true);
  const builder = new QuoteBuilder(span);
  const inner = namedChildren(node).find((child) => child.type.startsWith('quoted_'));
  if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
  switch (inner.type) {
    case 'quoted_pattern': {
      return builder.pattern(convertPattern(features, namedChildren(inner)[0]));
    }
    case 'quoted_type': {
      return builder.type(convertType(features, namedChildren(inner)[0]));
    }
    case 'quoted_decls': {
      return builder.declarations(fields(inner, 'declaration').flatMap((node) => convertTopDecl(features, node)));
    }
    default: {
      const expr = convertExpr(features, namedChildren(inner)[0]);
      const built = builder.expression(expr);
      if (node.type !== 'typed_quote') return built;
      // The typed quote's function only gives the type of its expression, which it never runs.
      const typer: Expr = { kind: 'lambda', pats: [{ kind: 'pwild', span }], body: expr, span };
      return {
        kind: 'app',
        fn: { kind: 'app', fn: { kind: 'support', name: 'typedQuote', span }, arg: typer, span },
        arg: built,
        span,
      };
    }
  }
}

function requireRecordDot(features: FeatureGates<'convert'>, span: Span): void {
  if (!features.allows('overloadedRecordDot')) {
    throw syntaxError(span, 'レコードのドット記法を使うには、OverloadedRecordDot の拡張が要ります。');
  }
}

function fieldLabel(node: Node): string {
  return node.type === 'field_name' ? (namedChildren(node)[0] ?? node).text : node.text;
}

/** The fields `(.a.b)` selects, in order. */
function fieldsOfSelector(node: Node): string[] {
  return fields(node, 'field').map(fieldLabel);
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

function convertBlock(features: FeatureGates<'convert'>, node: Node, span: Span): Expr {
  switch (node.type) {
    case 'case': {
      const scrutinee = unnamedFieldChildren(node)[0];
      if (!scrutinee) throw syntaxError(span, '書き方に誤りがあります。');
      const alternatives = field(node, 'alternatives');
      if ((!alternatives || fields(alternatives, 'alternative').length === 0) && !features.allows('emptyCase')) {
        throw syntaxError(span, '選択肢のない case を使うには、EmptyCase の拡張が要ります。');
      }
      return {
        kind: 'case',
        scrutinee: convertExpr(features, scrutinee),
        alts: alternatives ? fields(alternatives, 'alternative').map((node) => convertAlternative(features, node)) : [],
        span,
      };
    }
    case 'do': {
      const doModule = namedChildren(node).find((child) => child.type === 'do_module');
      if (doModule) return convertQualifiedDo(features, node, moduleName(required(doModule, 'module')), span);
      const statements = fields(node, 'statement').flatMap((child) =>
        withForcedLets(features, convertStatement(features, child))
      );
      if (statements.length === 0) throw syntaxError(span, 'do の中に文がありません。');
      if (hasToken(node, 'mdo')) {
        if (!features.allows('recursiveDo')) throw syntaxError(span, 'mdo を使うには、RecursiveDo の拡張が要ります。');
        const last = statements.at(-1) as Stmt;
        const rest = statements.slice(0, -1);
        return { kind: 'do', stmts: rest.length > 0 ? [{ kind: 'rec', stmts: rest, span }, last] : [last], span };
      }
      return { kind: 'do', stmts: statements, span };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

/** What the case of a qualified do block's bind is, whose failing alternative the renamer may drop. */
export const QUALIFIED_DO_BIND = 'qualified do bind';

/**
 * Converts `M.do`, which QualifiedDo reads with the `>>=`, `>>`, and `fail` of the module `M`: `x <- e; s` as
 * `e M.>>= \x -> s`, `e; s` as `e M.>> s`, and a bind whose pattern can fail as one that calls `M.fail` then.
 */
function convertQualifiedDo(features: FeatureGates<'convert'>, node: Node, module: string, span: Span): Expr {
  if (!features.allows('qualifiedDo'))
    throw syntaxError(span, '修飾つきの do を使うには、QualifiedDo の拡張が要ります。');
  if (hasToken(node, 'mdo')) throw unsupportedError(span, '修飾つきの mdo');
  const statements = fields(node, 'statement').map((node) => convertStatement(features, node));
  if (statements.length === 0) throw syntaxError(span, 'do の中に文がありません。');
  const qualified = (name: string, at: Span): Expr => ({
    kind: 'var',
    name: { name, qualifier: module, span: at },
    span: at,
  });
  let result: Expr | undefined;
  for (const [index, stmt] of statements.entries().toArray().toReversed()) {
    const isLast = index === statements.length - 1;
    if (isLast) {
      if (stmt.kind !== 'exp') throw syntaxError(stmt.span, 'do の最後の文は、式にしてください。');
      result = stmt.expr;
      continue;
    }
    const rest = result as Expr;
    if (stmt.kind === 'exp') {
      result = {
        kind: 'app',
        fn: { kind: 'app', fn: qualified('>>', stmt.span), arg: stmt.expr, span: stmt.span },
        arg: rest,
        span,
      };
    } else if (stmt.kind === 'let') {
      result = { kind: 'let', decls: stmt.decls, body: rest, span };
    } else if (stmt.kind === 'rec' || stmt.kind === 'transform') {
      throw unsupportedError(stmt.span, '修飾つきの do の中の rec');
    } else {
      const name = generatedName('bind', index);
      const failMessage: Expr = {
        kind: 'lit',
        lit: {
          kind: 'string',
          value: [
            ...`Pattern match failure in qualified 'do' block at ${PROGRAM_SOURCE}:${stmt.span.row + 1}:${stmt.span.col + 1}`,
          ],
        },
        span: stmt.span,
      };
      // Whether the pattern can fail, which decides whether M.fail is needed, depends on its constructors, which
      // the renamer knows: it drops the failing alternative of a pattern that cannot fail.
      const body: Expr = {
        kind: 'case',
        scrutinee: varOf(name, stmt.span),
        alts: [
          { pat: stmt.pat, rhs: plainRhs(rest, span), span },
          {
            pat: { kind: 'pwild', span },
            rhs: plainRhs({ kind: 'app', fn: qualified('fail', stmt.span), arg: failMessage, span }, span),
            span,
          },
        ],
        span,
        what: QUALIFIED_DO_BIND,
      };
      const lambda = lambdaOf([name], body, span);
      result = {
        kind: 'app',
        fn: { kind: 'app', fn: qualified('>>=', stmt.span), arg: stmt.expr, span: stmt.span },
        arg: lambda,
        span,
      };
    }
  }
  return result as Expr;
}

/** The file name GHC's messages show for the program. */
const PROGRAM_SOURCE = 'Main.hs';

function plainRhs(expr: Expr, span: Span): Rhs {
  return { body: { kind: 'plain', expr }, where: [], span };
}

function convertRecordPattern(features: FeatureGates<'convert'>, node: Node, span: Span): Pat {
  const con = convertPattern(features, required(node, 'constructor'));
  if (con.kind !== 'pcon' || con.args.length > 0) throw syntaxError(span, '書き方に誤りがあります。');
  let wildcard: Span | undefined;
  const fieldPatterns = fields(node, 'field').flatMap((fieldNode) => {
    rejectUnsupported(fieldNode);
    const wildcardNode = namedChildren(fieldNode).find((child) => child.type === 'wildcard');
    if (wildcardNode) {
      wildcard = recordWildcard(features, wildcardNode);
      return [];
    }
    const fieldName = qualifiedName(required(fieldNode, 'field')).name;
    const pattern = field(fieldNode, 'pattern');
    const fieldSpan = spanOf(fieldNode);
    return [
      {
        field: fieldName,
        pat: pattern
          ? convertPattern(features, pattern)
          : ({
              kind: 'pvar',
              name: { name: punnedName(features, fieldName, fieldSpan), span: fieldSpan },
              span: fieldSpan,
            } as Pat),
        span: fieldSpan,
      },
    ];
  });
  return { kind: 'precord', con: con.con, fields: fieldPatterns, span, wildcard };
}

/** The variable a punned field `x` (or `M.x`) binds or reads, which requires NamedFieldPuns. */
function punnedName(features: FeatureGates<'convert'>, field: QName, span: Span): string {
  if (!features.allows('namedFieldPuns')) {
    throw syntaxError(span, 'フィールド名だけを書くには、NamedFieldPuns の拡張が要ります。');
  }
  return field.name;
}

function recordWildcard(features: FeatureGates<'convert'>, node: Node): Span {
  if (!features.allows('recordWildCards')) {
    throw syntaxError(spanOf(node), 'レコードの .. を使うには、RecordWildCards の拡張が要ります。');
  }
  return spanOf(node);
}

function convertRecordExpr(features: FeatureGates<'convert'>, node: Node): Expr {
  const span = spanOf(node);
  const target = required(node, 'expression');
  let wildcard: Span | undefined;
  const fieldBinds: FieldBind[] = fields(node, 'field').flatMap((fieldNode) => {
    rejectUnsupported(fieldNode);
    if (fieldNode.type !== 'field_update') throw syntaxError(spanOf(fieldNode), '書き方に誤りがあります。');
    const wildcardNode = namedChildren(fieldNode).find((child) => child.type === 'wildcard');
    if (wildcardNode) {
      wildcard = recordWildcard(features, wildcardNode);
      return [];
    }
    const fieldNameNode = required(fieldNode, 'field');
    if (fieldNameNode.type === 'field_path') {
      // GHC's OverloadedRecordUpdate needs RebindableSyntax, with getField and setField of the program's own, and
      // RebindableSyntax is not available here.
      throw unsupportedError(spanOf(fieldNameNode), '入れ子のレコードの更新（OverloadedRecordUpdate）');
    }
    rejectUnsupported(fieldNameNode);
    const fieldName = qualifiedName(fieldNameNode).name;
    const value = field(fieldNode, 'expression');
    const fieldSpan = spanOf(fieldNode);
    return [
      {
        field: fieldName,
        value: value ? convertExpr(features, value) : varOf(punnedName(features, fieldName, fieldSpan), fieldSpan),
        span: fieldSpan,
      },
    ];
  });
  const converted = convertExpr(features, target);
  if (converted.kind === 'con') return { kind: 'recordCon', con: converted.name, fields: fieldBinds, span, wildcard };
  if (wildcard) throw syntaxError(wildcard, 'レコードの更新には、.. は書けません。');
  if (fieldBinds.length === 0) throw syntaxError(span, 'レコードの更新には、項目を1つ以上書いてください。');
  return { kind: 'recordUpdate', expr: converted, fields: fieldBinds, span };
}

function convertAlternative(features: FeatureGates<'convert'>, node: Node): Alt {
  if (field(node, 'patterns')) throw unsupported(node);
  return {
    pat: strictPattern(features, convertPattern(features, required(node, 'pattern'))),
    rhs: convertRhs(features, node, '->'),
    span: spanOf(node),
  };
}

/** Converts a statement of a `do` block or a qualifier of a list comprehension. */
function convertStatement(features: FeatureGates<'convert'>, node: Node): Stmt {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'exp':
    case 'boolean': {
      return { kind: 'exp', expr: convertExpr(features, namedChildren(node)[0] ?? node), span };
    }
    case 'bind':
    case 'generator': {
      if (node.type === 'bind' && !field(node, 'arrow')) {
        throw syntaxError(span, 'do の中で束縛するには、let か <- を使ってください。');
      }
      const patternNode = field(node, 'pattern') ?? field(node, 'name');
      if (!patternNode) throw syntaxError(span, '書き方に誤りがあります。');
      const pat = strictPattern(features, convertPattern(features, patternNode));
      return { kind: 'bind', pat, expr: convertExpr(features, required(node, 'expression')), span };
    }
    case 'let': {
      return { kind: 'let', decls: convertLocalBinds(features, field(node, 'binds')), span };
    }
    case 'transform':
    case 'group': {
      if (!features.allows('transformListComp')) {
        throw syntaxError(span, 'then を使うには、TransformListComp の拡張が要ります。');
      }
      const key = field(node, 'key');
      return {
        kind: 'transform',
        fn: convertExpr(features, required(node, node.type === 'group' ? 'classifier' : 'transformation')),
        by: key ? convertExpr(features, key) : undefined,
        group: node.type === 'group',
        span,
      };
    }
    case 'rec': {
      if (!features.allows('recursiveDo')) throw syntaxError(span, 'rec を使うには、RecursiveDo の拡張が要ります。');
      return { kind: 'rec', stmts: fields(node, 'statement').map((node) => convertStatement(features, node)), span };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}

function chainItems<T>(
  features: FeatureGates<'convert'>,
  node: Node,
  convertOperand: (operand: Node) => T,
  expressions = false
): ChainItem<T>[] {
  const items: ChainItem<T>[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (!child || isComment(child)) continue;
    const fieldName = node.fieldNameForChild(index);
    const negated = fieldName === 'operator' ? tightNegation(features, child, node.child(index + 1)) : undefined;
    if (negated && expressions) {
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
      if (child.type === 'promoted') {
        requireDataKinds(features, spanOf(child));
        const inner = namedChildren(child)[0] ?? child;
        items.push({ kind: 'operator', op: { ...convertOperator(inner), promoted: true } });
        continue;
      }
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
function tightNegation(features: FeatureGates<'convert'>, operator: Node, next: Node | null): Expr | undefined {
  if (!next || operator.text !== '-' || next.startIndex !== operator.endIndex) return undefined;
  const before = operator.tree.rootNode.text[operator.startIndex - 1] ?? ' ';
  if (!/[\s([,;]/.test(before)) return undefined;
  const isNumber = next.type === 'literal' && ['integer', 'float'].includes(namedChildren(next)[0]?.type ?? '');
  if (!(features.allows('lexicalNegation') || (isNumber && features.allows('negativeLiterals')))) return undefined;
  const span = { ...spanOf(operator), endRow: spanOf(next).endRow, endCol: spanOf(next).endCol };
  const operand = convertExpr(features, next);
  if (operand.kind === 'lit' && operand.lit.kind === 'int') {
    return { kind: 'lit', lit: { kind: 'int', value: -operand.lit.value }, span };
  }
  return { kind: 'paren', expr: { kind: 'neg', expr: operand, span }, span };
}

function convertLiteral(features: FeatureGates<'convert'>, node: Node): SourceLiteral {
  const span = spanOf(node);
  // MagicHash's literals are values of the machine's own types, Int# and the like, whose size depends on the CPU.
  if (node.text.endsWith('#')) throw unsupportedError(span, `ボックス化されない値のリテラル（${node.text}）`);
  switch (node.type) {
    case 'integer':
    case 'float': {
      const literal = parseNumberLiteral(node.text, span, features);
      return literal.kind === 'int' ? { ...literal, text: node.text } : literal;
    }
    case 'char': {
      return { kind: 'char', value: parseCharLiteral(node.text, span), text: node.text };
    }
    case 'string': {
      return {
        kind: 'string',
        value: parseStringLiteral(node.text, span, features.allows('multilineStrings')),
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
export function convertPattern(features: FeatureGates<'convert'>, node: Node): Pat {
  rejectUnsupported(node);
  const span = spanOf(node);
  switch (node.type) {
    case 'wildcard': {
      return { kind: 'pwild', span };
    }
    case 'literal': {
      const lit = convertLiteral(features, namedChildren(node)[0] ?? node);
      if (lit.kind === 'string' && features.allows('overloadedStrings')) {
        // GHC matches an overloaded string by (==) with the literal's value at the pattern's type.
        const matches: Expr = {
          kind: 'app',
          fn: { kind: 'support', name: 'overloadedStringEq', span },
          arg: { kind: 'lit', lit, span },
          span,
        };
        return {
          kind: 'pview',
          expr: matches,
          exprText: '==',
          pat: { kind: 'pcon', con: { name: 'True', span }, args: [], span },
          written: { kind: 'plit', lit, negative: false, span },
          span,
        };
      }
      return { kind: 'plit', lit, negative: false, span };
    }
    case 'negation': {
      const number = required(node, 'number');
      return { kind: 'plit', lit: convertLiteral(features, number), negative: true, span };
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
      const head = convertPattern(features, fn);
      if (head.kind !== 'pcon') throw syntaxError(span, 'パターンの中で、関数は呼び出せません。');
      return { kind: 'pcon', con: head.con, args: [...head.args, convertPattern(features, argument)], span };
    }
    case 'parens': {
      const inner = field(node, 'pattern');
      if (!inner) throw syntaxError(span, '書き方に誤りがあります。');
      return { ...convertPattern(features, inner), span };
    }
    case 'tuple': {
      const elements = fields(node, 'element');
      return { kind: 'ptuple', elems: elements.map((node) => convertPattern(features, node)), span };
    }
    case 'unit': {
      return { kind: 'pcon', con: { name: '()', span }, args: [], span };
    }
    case 'unboxed_unit':
    case 'unboxed_tuple':
    case 'unboxed_sum': {
      const { name, elems } = unboxedParts(features, node, false);
      return { kind: 'pcon', con: { name, span }, args: elems.map((node) => convertPattern(features, node)), span };
    }
    case 'prefix_tuple': {
      return { kind: 'pcon', con: { name: node.text.replaceAll(/\s+/g, ''), span }, args: [], span };
    }
    case 'list': {
      const list: Pat = {
        kind: 'plist',
        elems: fields(node, 'element').map((node) => convertPattern(features, node)),
        span,
      };
      if (!features.allows('overloadedLists')) return list;
      return {
        kind: 'pview',
        expr: { kind: 'support', name: 'overloadedToList', span },
        exprText: 'toList',
        pat: list,
        written: list,
        span,
      };
    }
    case 'as': {
      return {
        kind: 'pas',
        name: plainName(required(node, 'bind')),
        pat: convertPattern(features, required(node, 'pattern')),
        span,
      };
    }
    case 'record': {
      return convertRecordPattern(features, node, span);
    }
    case 'infix_chain': {
      return {
        kind: 'pchain',
        items: chainItems(features, node, (operand) => convertPattern(features, operand)),
        span,
      };
    }
    case 'strict': {
      if (!features.allows('bangPatterns'))
        throw syntaxError(span, '! のパターンを使うには、BangPatterns の拡張が要ります。');
      return { kind: 'pbang', pat: convertPattern(features, required(node, 'pattern')), span };
    }
    case 'irrefutable': {
      return { kind: 'plazy', pat: convertPattern(features, required(node, 'pattern')), span };
    }
    case 'view_pattern': {
      if (!features.allows('viewPatterns'))
        throw syntaxError(span, 'ビューパターンを使うには、ViewPatterns の拡張が要ります。');
      const expression = required(node, 'expression');
      return {
        kind: 'pview',
        expr: convertExpr(features, expression),
        exprText: expression.text,
        pat: convertPattern(features, required(node, 'pattern')),
        span,
      };
    }
    case 'or_pattern': {
      if (!features.allows('orPatterns'))
        throw syntaxError(span, 'or パターンを使うには、OrPatterns の拡張が要ります。');
      return { kind: 'por', alts: fields(node, 'alternative').map((node) => convertPattern(features, node)), span };
    }
    case 'type_binder': {
      requireTypeAbstractions(features, span);
      const typeNode = required(node, 'type');
      if (typeNode.type !== 'variable') throw unsupportedError(span, 'この形の型の束縛');
      return { kind: 'ptybinder', name: plainName(typeNode), span };
    }
    case 'signature': {
      if (!features.allows('patternSignatures')) {
        throw syntaxError(span, 'パターンに型シグネチャを書くには、ScopedTypeVariables の拡張が要ります。');
      }
      return {
        kind: 'psig',
        pat: convertPattern(features, required(node, 'pattern')),
        type: convertType(features, required(node, 'type')),
        span,
      };
    }
    default: {
      throw syntaxError(span, '書き方に誤りがあります。');
    }
  }
}
