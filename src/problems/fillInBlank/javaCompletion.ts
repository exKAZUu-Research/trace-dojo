/* oxlint-disable unicorn/no-null -- CodeMirror completion sources and syntax-node parents use null. */
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { ensureSyntaxTree } from '@codemirror/language';

import { isJavaComposing } from './javaEditorDiagnostics';
import { maskJavaNonCode } from './javaSource';

type SyntaxNode = NonNullable<ReturnType<typeof ensureSyntaxTree>>['topNode'];
interface VisibleVariable {
  name: string;
  turtle: boolean;
  position: number;
}
const scopeNames =
  /^(Block|ConstructorBody|SwitchBlock|ForStatement|EnhancedForStatement|MethodDeclaration|ConstructorDeclaration|LambdaExpression|CatchClause)$/;

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
  if (!maskJavaNonCode(state.sliceDoc(0, pos) + 'x').endsWith('x')) return null;
  const tree = ensureSyntaxTree(state, pos, 20);
  const node = tree?.resolveInner(pos, -1);
  for (let current: SyntaxNode | null | undefined = node; current; current = current.parent) {
    if (/Comment|StringLiteral|CharacterLiteral|TextBlock/.test(current.name)) return null;
  }
  const word = context.matchBefore(identifier);
  const from = word?.from ?? pos;
  const before = state.sliceDoc(Math.max(0, from - 200), from);
  const receiver = /([\p{L}_$][\p{L}\p{N}\p{M}_$]*)\.$/u.exec(before);
  if (receiver) {
    if (!node) return null;
    if (/[.\p{L}\p{N}\p{M}_$]$/u.test(before.slice(0, receiver.index).trimEnd())) return null;
    const variable = visibleVariables(context, node, from).find((entry) => entry.name === receiver[1]);
    return variable?.turtle ? { from, options: methods } : null;
  }
  if (before.endsWith('.') || (!context.explicit && !word?.text)) return null;
  const variables = !node || node.name === 'Definition' ? [] : visibleVariables(context, node, from);
  const options: Completion[] = [
    ...variables.map(({ name }) => ({ label: name, type: 'variable' })),
    ...snippets,
    ...keywords,
  ];
  if (word?.text) {
    const seen = new Set(options.map(({ label }) => label));
    const source = maskJavaNonCode(state.doc.toString());
    for (const match of source.matchAll(/[\p{L}_$][\p{L}\p{N}\p{M}_$]*/gu)) {
      if (match.index <= from && match.index + match[0].length >= pos) continue;
      const label = match[0];
      if (seen.has(label)) continue;
      seen.add(label);
      options.push({ label, type: 'text', detail: 'コード内の単語' });
    }
  }
  return { from, options };
}

function visibleVariables(context: CompletionContext, node: SyntaxNode, from: number): VisibleVariable[] {
  const visible = new Map<string, VisibleVariable>();
  let method: SyntaxNode | undefined;
  const merge = (variables: VisibleVariable[]): void => {
    for (const variable of variables.toSorted((a, b) => b.position - a.position)) {
      if (!visible.has(variable.name)) visible.set(variable.name, variable);
    }
  };
  for (let scope: SyntaxNode | null = node; scope; scope = scope.parent) {
    if (scope.name === 'ClassBody') {
      if (method) {
        const staticOnly = Boolean(method.getChild('Modifiers')?.getChild('static'));
        for (const field of scope.getChildren('FieldDeclaration')) {
          if (staticOnly && !field.getChild('Modifiers')?.getChild('static')) continue;
          merge(declarationVariables(context, field, Number.POSITIVE_INFINITY));
        }
      }
      break;
    }
    if (!scopeNames.test(scope.name)) continue;
    if (/^(MethodDeclaration|ConstructorDeclaration)$/.test(scope.name)) method = scope;
    const variables: VisibleVariable[] = [];
    const root = scope;
    scope.cursor().iterate((candidate) => {
      if (candidate.from >= from) return false;
      if (
        (candidate.from !== root.from || candidate.to !== root.to || candidate.name !== root.name) &&
        (scopeNames.test(candidate.name) || /^(ClassBody|ClassDeclaration)$/.test(candidate.name))
      )
        return false;
      if (/^(InferredParameters|LambdaExpression)$/.test(candidate.name)) {
        variables.push(...declarationVariables(context, candidate.node, from));
        if (candidate.name === 'InferredParameters') return false;
      }
      if (
        !/^(LocalVariableDeclaration|FormalParameter|SpreadParameter|CatchFormalParameter|ForSpec)$/.test(
          candidate.name
        )
      )
        return;
      if (candidate.name === 'ForSpec') {
        if (candidate.node.parent?.name !== 'EnhancedForStatement') return;
        if (context.pos <= candidate.to) return false;
      }
      variables.push(...declarationVariables(context, candidate.node, from));
      return false;
    });
    merge(variables);
  }
  return [...visible.values()];
}

function declarationVariables(context: CompletionContext, declaration: SyntaxNode, before: number): VisibleVariable[] {
  const { state } = context;
  const type = declaration.getChild('TypeName');
  const scalarTurtle = Boolean(
    type &&
    state.sliceDoc(type.from, type.to) === 'Turtle' &&
    declaration.name !== 'SpreadParameter' &&
    !declaration.getChild('Dimension') &&
    !declaration.getChild('ArrayType')
  );
  const declarators = declaration.getChildren('VariableDeclarator');
  const definitions =
    declarators.length > 0
      ? declarators.map((variable) => ({
          definition: variable.getChild('Definition'),
          turtle: scalarTurtle && !variable.getChild('Dimension'),
        }))
      : declaration.getChildren('Definition').map((definition) => ({ definition, turtle: scalarTurtle }));
  return definitions.flatMap(({ definition, turtle }) =>
    definition && definition.to < before
      ? [
          {
            name: state.sliceDoc(definition.from, definition.to),
            turtle,
            position: definition.from,
          },
        ]
      : []
  );
}
