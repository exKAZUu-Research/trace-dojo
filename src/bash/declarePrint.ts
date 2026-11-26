import { appendMetered, type CostMeter } from './budget';
import { ATTRIBUTE_ORDER, rejectUnsupportedVariableRead } from './capabilities';
import { ansicQuote, ansicShouldQuote, containsShellMetas, doubleQuote } from './quoting';
import type { OutputTarget } from './runtime';
import type { Shell } from './shell';
import { sortedElements, type VariableView } from './variables';

export function printDeclarations(
  shell: Shell,
  builtin: string,
  names: readonly (string | { name: string })[]
): number {
  const spend: CostMeter = (cost) => shell.runtime.spend(cost);
  let status = 0;
  for (const operand of names) {
    const name = typeof operand === 'string' ? operand : operand.name;
    const view = declarationViewToShow(shell, builtin, name);
    if (!view) {
      shell.reportError(`${builtin}: ${name}: not found`);
      status = 1;
      continue;
    }
    writeDeclarationToTarget(shell.fd1, view, spend);
    shell.fd1.write('\n');
  }
  return status;
}

function declarationViewToShow(shell: Shell, builtin: string, name: string): VariableView | undefined {
  rejectUnsupportedVariableRead(name);
  const found = shell.store.ownView(name);
  if (builtin !== 'local') {
    return found ?? shell.store.dynamicView(name);
  }
  return found?.isCurrentLocal ? found : undefined;
}

function writeDeclarationToTarget(target: OutputTarget, view: VariableView, spend: CostMeter): void {
  writeDeclaration(view, spend, (chunk) => {
    if (chunk.length === 0) return;
    spend(Math.ceil(chunk.length / 256));
    target.write(chunk);
  });
}

export function declarationText(view: VariableView, spend: CostMeter): string {
  let text = '';
  writeDeclaration(view, spend, (chunk) => {
    text = appendMetered(text, chunk, spend);
  });
  return text;
}

function writeDeclaration(view: VariableView, spend: CostMeter, emit: (chunk: string) => void): void {
  const flags = ATTRIBUTE_ORDER.filter((attribute) => view.attributes.has(attribute)).join('');
  const prefix = `declare -${flags || '-'} ${view.name}`;
  if (view.kind === 'unset') {
    emit(prefix);
    return;
  }
  if (view.kind === 'scalar') {
    emit(`${prefix}=`);
    emit(quoteValue(view.scalar ?? '', spend));
    return;
  }
  emit(`${prefix}=(`);
  if (view.kind === 'indexed') {
    for (const [pos, [index, element]] of sortedElements(view.indexed as ReadonlyMap<bigint, string>).entries()) {
      emit(`${pos > 0 ? ' ' : ''}[${index}]=`);
      emit(quoteValue(element, spend));
    }
  } else {
    for (const [key, element] of view.associative?.entries() ?? []) {
      emit(`[${quoteKey(key, spend)}]=`);
      emit(`${quoteValue(element, spend)} `);
    }
  }
  emit(')');
}

export function quoteValue(text: string, spend?: CostMeter): string {
  if (spend && text.length > 0) spend(Math.ceil(text.length / 256));
  return ansicShouldQuote(text) ? ansicQuote(text) : doubleQuote(text);
}

export function quoteKey(key: string, spend?: CostMeter): string {
  if (spend && key.length > 0) spend(Math.ceil(key.length / 256));
  if (ansicShouldQuote(key)) return ansicQuote(key);
  if (containsShellMetas(key) || key === '@' || key === '*') return doubleQuote(key);
  return key;
}
