// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { assignReference } from './assignment';
import type { Expr } from './ast';
import { formatFloat, valueName } from './conversions';
import { throwError } from './errors';
import { consumeExpression, ev, isCompiledVariable, prepareOperand, withSilence } from './interp';
import { strictEquals } from './operators';
import { rt, type Runtime } from './runtime';
import { deref, Ref, type Value } from './values';

// code-gauge-allow functionCognitiveComplexity -- Evaluates match conditions in order while preserving the subject slot.
export function matchExpression(e: Extract<Expr, { k: 'match' }>): Value {
  const runtime = rt();
  const variable = e.subject.k === 'var' && isCompiledVariable(e.subject) ? e.subject : undefined;
  const slot = variable ? null : readMatchTemporary(runtime, e.subject);
  const readSubject = variable ? prepareOperand(variable) : () => deref(slot);
  const snapshot = e.jumpTable ? readSubject() : undefined;
  for (const arm of e.arms) {
    if (!arm.conditions) continue;
    for (const condition of arm.conditions) {
      if (
        consumeExpression(condition, (value) =>
          strictEquals(snapshot === undefined ? readSubject(condition.row) : snapshot, value)
        )
      )
        return ev(arm.body);
    }
  }
  const fallback = e.arms.find((arm) => !arm.conditions);
  if (fallback) return ev(fallback.body);
  const subject = variable ? (runtime.frame.vars.get(variable.name) ?? null) : slot;
  runtime.row = (e.jumpTable ? e.subject : (e.arms.at(-1)?.conditions?.at(-1) ?? e.subject)).row;
  throwError('UnhandledMatchError', `Unhandled match case ${matchCaseText(subject)}`);
}

function readMatchTemporary(runtime: Runtime, e: Expr): Value | Ref {
  if (e.k === 'silence') return withSilence(runtime, () => readMatchTemporary(runtime, e.e));
  if (e.k === 'assignRef') {
    const slot = assignReference(e.target, e.source);
    if (slot instanceof Ref) runtime.holdTemporaryReference(slot);
    else runtime.frame.temporaries.push(slot);
    return slot;
  }
  const call = e.k === 'call' || e.k === 'mcall' || e.k === 'scall' || e.k === 'pipe';
  if (call) runtime.lastReturnRef = undefined;
  const value = ev(e);
  const ref = call ? runtime.lastReturnRef : undefined;
  if (call) runtime.lastReturnRef = undefined;
  if (ref) {
    if (e.k === 'pipe') runtime.holdTemporaryReference(ref);
    return ref;
  }
  runtime.frame.temporaries.push(value);
  return value;
}

function matchCaseText(value: Value | Ref): string {
  if (value instanceof Ref) {
    if (value.isRef) return matchTypeText(value.v);
    value = value.v;
  }
  if (typeof value === 'string') {
    return `'${escapeTruncated(value.slice(0, 15))}${value.length > 15 ? '...' : ''}'`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    const text = formatFloat(value);
    return Number.isFinite(value) && !/[.E]/.test(text) ? `${text}.0` : text;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null) return 'NULL';
  return matchTypeText(value);
}

function matchTypeText(value: Value): string {
  return `of type ${typeof value === 'boolean' ? 'bool' : valueName(value)}`;
}

const TRUNCATED_ESCAPES: Record<string, string> = {
  '\\': '\\',
  '\n': 'n',
  '\r': 'r',
  '\t': 't',
  '\f': 'f',
  '\v': 'v',
  '\u001B': 'e',
};

/** Escapes bytes as PHP's `smart_str_append_escaped` does for messages. */
function escapeTruncated(bytes: string): string {
  return bytes.replaceAll(/[\\\0-\u001F\u007F-\u00FF]/g, (byte) => {
    const escape = TRUNCATED_ESCAPES[byte];
    return escape ? `\\${escape}` : `\\x${byte.codePointAt(0)!.toString(16).toUpperCase().padStart(2, '0')}`;
  });
}
