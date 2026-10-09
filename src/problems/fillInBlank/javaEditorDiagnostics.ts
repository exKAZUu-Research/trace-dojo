import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { linter, setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';

import { formatJavaDiagnostic, type JavaDiagnostic } from './javaDiagnostics';
import { hasIncompleteJavaPlaceholders } from './javaSource';

export const compilerFeedback = StateEffect.define<JavaDiagnostic[]>();
export const javaComposition = StateEffect.define<boolean>();
const feedbackState = StateField.define<{ diagnostics: JavaDiagnostic[]; composing: boolean }>({
  create: () => ({ diagnostics: [], composing: false }),
  update(value, transaction) {
    let next = transaction.docChanged ? { ...value, diagnostics: [] } : value;
    for (const effect of transaction.effects) {
      if (effect.is(compilerFeedback)) next = { ...next, diagnostics: effect.value };
      if (effect.is(javaComposition)) next = { diagnostics: [], composing: effect.value };
    }
    return next;
  },
});

export const javaEditorDiagnostics: Extension = [
  feedbackState,
  linter((view) => combinedDiagnostics(view.state), {
    delay: 250,
    needsRefresh: (update) =>
      update.startState.field(feedbackState).composing !== update.state.field(feedbackState).composing ||
      syntaxTree(update.startState) !== syntaxTree(update.state),
  }),
  EditorState.transactionExtender.of((transaction) => {
    if (
      transaction.docChanged ||
      transaction.effects.some(
        (effect) => effect.is(javaComposition) || effect.is(compilerFeedback) || effect.is(setDiagnosticsEffect)
      )
    ) {
      return { effects: setDiagnosticsEffect.of(transaction.docChanged ? [] : combinedDiagnostics(transaction.state)) };
    }
    // oxlint-disable-next-line unicorn/no-null -- CodeMirror requires null when an extender has no effects.
    return null;
  }),
];

export function isJavaComposing(state: EditorState): boolean {
  return state.field(feedbackState).composing;
}

function combinedDiagnostics(state: EditorState): Diagnostic[] {
  const feedback = state.field(feedbackState);
  if (feedback.composing) return [];
  const diagnostics: Diagnostic[] = [];
  const occupiedLines = new Set<number>();
  for (const item of feedback.diagnostics) {
    if (!item.line || item.line > state.doc.lines) continue;
    const line = state.doc.line(item.line);
    diagnostics.push({
      from: line.from,
      to: line.to,
      severity: 'error',
      message: formatJavaDiagnostic(item),
      source: '提出後の確認（コンパイル）',
    });
    occupiedLines.add(line.number);
  }
  if (state.doc.length > 20_000) return diagnostics;
  const source = state.doc.toString();
  if (hasIncompleteJavaPlaceholders(source)) return diagnostics;
  const completeTree = ensureSyntaxTree(state, state.doc.length, 20);
  const allowContext = Boolean(completeTree) && !/\\u/.test(source);
  let isFirstError = true;
  (completeTree ?? syntaxTree(state)).iterate({
    enter(node) {
      if (!node.type.isError) return;
      const useContext = isFirstError && allowContext;
      isFirstError = false;
      if (diagnostics.length >= 20) return;
      const line = state.doc.lineAt(node.from);
      if (occupiedLines.has(line.number)) return;
      occupiedLines.add(line.number);
      const from = node.from === line.to && line.length > 0 ? node.from - 1 : node.from;
      diagnostics.push({
        from,
        to: Math.min(line.to, Math.max(from + 1, node.to)),
        severity: 'error',
        source: '入力中のヒント（構文）',
        message:
          (useContext ? contextualHint(node.node, source) : undefined) ??
          'この付近の書き方を確認してください。括弧や記号の抜けがないか、直前の行も見てみましょう。',
      });
    },
  });
  return diagnostics;
}

function contextualHint(node: ReturnType<typeof syntaxTree>['topNode'], source: string): string | undefined {
  const operator = node.prevSibling;
  if (
    node.from !== node.to ||
    !operator ||
    !/^\s*$/.test(source.slice(operator.to, node.from)) ||
    !/^\s*(?:[;,)\]}]|$)/.test(source.slice(node.from))
  )
    return undefined;
  const spelling = source.slice(operator.from, operator.to);
  if (
    (node.parent?.name === 'VariableDeclarator' || node.parent?.name === 'AssignmentExpression') &&
    operator.name === 'AssignOp' &&
    spelling === '='
  )
    return '「=」の右側に、代入する値や計算式が書かれているか確認してください。';
  if (node.parent?.name === 'BinaryExpression' && operator.name === 'ArithOp' && /^[+*/%-]$/.test(spelling)) {
    return `「${spelling}」の右側に、計算する値や式が書かれているか確認してください。`;
  }
  return undefined;
}
