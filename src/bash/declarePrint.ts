import { ATTRIBUTE_ORDER } from './capabilities';
import { ansicQuote, ansicShouldQuote, containsShellMetas, doubleQuote } from './quoting';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { sortedElements, type VariableView } from './variables';

export function printDeclarations(
  shell: Shell,
  builtin: string,
  names: readonly (string | { name: string })[]
): number {
  let status = 0;
  for (const operand of names) {
    const name = typeof operand === 'string' ? operand : operand.name;
    const view = declarationViewToShow(shell, builtin, name);
    if (!view) {
      shell.reportError(`${builtin}: ${name}: not found`);
      status = 1;
      continue;
    }
    shell.fd1.write(`${declarationText(view)}\n`);
  }
  return status;
}

function declarationViewToShow(shell: Shell, builtin: string, name: string): VariableView | undefined {
  const found = shell.store.ownView(name);
  if (builtin !== 'local') {
    if (!found && shell.store.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
    return found ?? shell.store.dynamicView(name);
  }
  return found?.isCurrentLocal ? found : undefined;
}

export function declarationText(view: VariableView): string {
  const flags = ATTRIBUTE_ORDER.filter((attribute) => view.attributes.has(attribute)).join('');
  const prefix = `declare -${flags || '-'} ${view.name}`;
  if (view.kind === 'unset') return prefix;
  if (view.kind === 'scalar') return `${prefix}=${quoteValue(view.scalar ?? '')}`;
  if (view.kind === 'indexed') {
    const body = sortedElements(view.indexed as ReadonlyMap<bigint, string>)
      .map(([index, element]) => `[${index}]=${quoteValue(element)}`)
      .join(' ');
    return `${prefix}=(${body})`;
  }
  const body = (view.associativeEntries as readonly [string, string][])
    .map(([key, element]) => `[${quoteKey(key)}]=${quoteValue(element)} `)
    .join('');
  return `${prefix}=(${body})`;
}

export function quoteValue(text: string): string {
  return ansicShouldQuote(text) ? ansicQuote(text) : doubleQuote(text);
}

export function quoteKey(key: string): string {
  if (ansicShouldQuote(key)) return ansicQuote(key);
  if (containsShellMetas(key) || key === '@' || key === '*') return doubleQuote(key);
  return key;
}
