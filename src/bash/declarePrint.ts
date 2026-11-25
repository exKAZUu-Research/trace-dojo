import { ansicQuote, ansicShouldQuote, containsShellMetas, doubleQuote } from './quoting';
import type { Shell } from './shell';
import { UnsupportedFeatureError } from './unsupported';
import { ATTRIBUTE_ORDER, sortedElements, type Variable } from './variables';

export function printDeclarations(
  shell: Shell,
  builtin: string,
  names: readonly (string | { name: string })[]
): number {
  let status = 0;
  for (const operand of names) {
    const name = typeof operand === 'string' ? operand : operand.name;
    const variable = declarationToShow(shell, builtin, name);
    if (!variable) {
      shell.reportError(`${builtin}: ${name}: not found`);
      status = 1;
      continue;
    }
    shell.state.fd1.write(`${declarationText(variable)}\n`);
  }
  return status;
}

function declarationToShow(shell: Shell, builtin: string, name: string): Variable | undefined {
  const found = shell.findVariable(name, false);
  if (builtin !== 'local') {
    if (!found && shell.isUnreadHostEnv(name)) throw new UnsupportedFeatureError(`環境変数（${name}）`);
    return found ?? shell.dynamicDeclaration(name);
  }
  const { scopes, functionScopes } = shell.state;
  return scopes[functionScopes.at(-1) as number].get(name) === found ? found : undefined;
}

export function declarationText(variable: Variable): string {
  const flags = ATTRIBUTE_ORDER.filter((attribute) => variable.attributes.has(attribute)).join('');
  const prefix = `declare -${flags || '-'} ${variable.name}`;
  const { value } = variable;
  if (!value) return prefix;
  if (value.kind === 'scalar') return `${prefix}=${quoteValue(value.value)}`;
  if (value.kind === 'indexed') {
    const body = sortedElements(value.elements)
      .map(([index, element]) => `[${index}]=${quoteValue(element)}`)
      .join(' ');
    return `${prefix}=(${body})`;
  }
  const body = value.table
    .entries()
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
