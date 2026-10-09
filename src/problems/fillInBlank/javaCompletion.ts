/* oxlint-disable unicorn/no-null -- CodeMirror completion sources and syntax-node parents use null. */
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { ensureSyntaxTree } from '@codemirror/language';

import { isJavaComposing } from './javaEditorDiagnostics';

const identifier = /[\p{L}\p{N}\p{M}_$]*/u;
const methods: Completion[] = [
  ['前に進む', 'void', '向いている方向に1マス進む'],
  ['後に戻る', 'void', '向きを変えずに後ろに1マス戻る'],
  ['右を向く', 'void', '右に90度向きを変える'],
  ['左を向く', 'void', '左に90度向きを変える'],
  ['前に進めるか', 'boolean', '盤面の外や別の亀のいるマスでなければtrue'],
  ['前のマスが塗られているか', 'boolean', '前のマスが塗られていればtrue'],
].map(([label, result, info]) => ({
  label,
  type: 'method',
  detail: `${result} ${label}()`,
  info,
  apply: `${label}()`,
}));
const keywords: Completion[] = [
  'class',
  'public',
  'static',
  'void',
  'int',
  'boolean',
  'String',
  'return',
  'new',
  'else',
  'true',
  'false',
  'break',
  'continue',
].map((label) => ({ label, type: 'keyword', detail: 'Javaキーワード' }));
const snippets = [
  snippetCompletion('if (${condition}) {\n\t${}\n}', { label: 'if', detail: '条件分岐', type: 'keyword' }),
  snippetCompletion('for (int ${index} = 0; ${index} < ${bound}; ${index}++) {\n\t${}\n}', {
    label: 'for',
    detail: '回数を指定して繰り返す',
    type: 'keyword',
  }),
  snippetCompletion('while (${condition}) {\n\t${}\n}', {
    label: 'while',
    detail: '条件を満たす間繰り返す',
    type: 'keyword',
  }),
  snippetCompletion('Turtle ${turtle} = new Turtle();', { label: 'Turtle', detail: '亀を作る', type: 'class' }),
  snippetCompletion('Turtle ${turtle} = new Turtle(${x}, ${y});', {
    label: 'Turtle(x, y)',
    detail: '位置を指定して亀を作る',
    type: 'class',
  }),
];

export function javaCompletion(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context;
  if (state.readOnly || isJavaComposing(state) || state.doc.length > 20_000) return null;
  const tree = ensureSyntaxTree(state, pos, 20);
  if (!tree) return null;
  let node = tree.resolveInner(pos, -1);
  for (let current: typeof node | null = node; current; current = current.parent) {
    if (/Comment|StringLiteral|CharacterLiteral|TextBlock/.test(current.name)) return null;
  }
  const word = context.matchBefore(identifier);
  const from = word?.from ?? pos;
  const before = state.sliceDoc(Math.max(0, from - 200), from);
  const receiver = /([\p{L}_$][\p{L}\p{N}\p{M}_$]*)\.$/u.exec(before);
  if (receiver) {
    if (/[.\p{L}\p{N}\p{M}_$]$/u.test(before.slice(0, receiver.index).trimEnd())) return null;
    const scopes: (typeof node)[] = [];
    while (node.parent) {
      if (node.name === 'ClassBody') break;
      if (
        /^(Block|SwitchBlock|ForStatement|EnhancedForStatement|MethodDeclaration|ConstructorDeclaration|LambdaExpression|CatchClause)$/.test(
          node.name
        )
      )
        scopes.push(node);
      node = node.parent;
    }
    for (const scope of scopes) {
      let found: boolean | undefined;
      const cursor = scope.cursor();
      cursor.iterate((candidate) => {
        if (candidate.from >= from) return false;
        if (
          (candidate.from !== scope.from || candidate.to !== scope.to || candidate.name !== scope.name) &&
          /^(Block|SwitchBlock|ClassBody|MethodDeclaration|ConstructorDeclaration|ForStatement|EnhancedForStatement|LambdaExpression|CatchClause)$/.test(
            candidate.name
          )
        )
          return false;
        if (
          (candidate.name === 'InferredParameters' || candidate.name === 'LambdaExpression') &&
          candidate.node
            .getChildren('Definition')
            .some((definition) => state.sliceDoc(definition.from, definition.to) === receiver[1])
        ) {
          found = false;
          return false;
        }
        if (
          !/^(LocalVariableDeclaration|FormalParameter|SpreadParameter|CatchFormalParameter|ForSpec)$/.test(
            candidate.name
          )
        )
          return;
        const declaration = candidate.node;
        const definitions =
          declaration.name === 'FormalParameter' ||
          declaration.name === 'CatchFormalParameter' ||
          declaration.name === 'ForSpec'
            ? [declaration.getChild('Definition')]
            : declaration.getChildren('VariableDeclarator').map((variable) => variable.getChild('Definition'));
        if (
          definitions.some((definition) => definition && state.sliceDoc(definition.from, definition.to) === receiver[1])
        ) {
          const type = declaration.getChild('TypeName');
          found = Boolean(
            type &&
            state.sliceDoc(type.from, type.to) === 'Turtle' &&
            declaration.name !== 'SpreadParameter' &&
            !declaration.getChild('ArrayType') &&
            !declaration.getChild('Dimension') &&
            !declaration.getChildren('VariableDeclarator').some((variable) => variable.getChild('Dimension'))
          );
        }
        return false;
      });
      if (found !== undefined) return found ? { from, options: methods } : null;
    }
    return null;
  }
  if (before.endsWith('.') || (!context.explicit && !word?.text)) return null;
  return { from, options: [...snippets, ...keywords] };
}
