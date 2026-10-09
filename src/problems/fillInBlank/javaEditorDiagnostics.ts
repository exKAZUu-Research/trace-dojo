import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { linter, setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';

import type { JavaDiagnostic } from './javaDiagnostics';
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
  linter(
    (view) => {
      if (view.state.doc.length <= 20_000) ensureSyntaxTree(view.state, view.state.doc.length, 20);
      return combinedDiagnostics(view.state);
    },
    {
      delay: 250,
      needsRefresh: (update) =>
        update.startState.field(feedbackState).composing !== update.state.field(feedbackState).composing,
    }
  ),
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
    diagnostics.push({ from: line.from, to: line.to, severity: 'error', message: item.message, source: 'コンパイル' });
    occupiedLines.add(line.number);
  }
  if (state.doc.length > 20_000 || hasIncompleteJavaPlaceholders(state.doc.toString())) return diagnostics;
  syntaxTree(state).iterate({
    enter(node) {
      if (!node.type.isError || diagnostics.length >= 20) return;
      const line = state.doc.lineAt(node.from);
      if (occupiedLines.has(line.number)) return;
      occupiedLines.add(line.number);
      const from = node.from === line.to && line.length > 0 ? node.from - 1 : node.from;
      diagnostics.push({
        from,
        to: Math.min(line.to, Math.max(from + 1, node.to)),
        severity: 'error',
        source: '構文のヒント',
        message: 'この付近のコードの書き方を確認してください。',
      });
    },
  });
  return diagnostics;
}
