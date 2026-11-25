import type { Assignment, Word } from './ast';
import type { DeclarationArgument, DeclarationOptions } from './declare';
import type { Shell } from './shell';
import type { CompoundElement, Variable } from './variables';

export interface PrefixedDeclareHooks {
  resolveTargetName: (shell: Shell, name: string, options: DeclarationOptions) => string;
  hasValue: (operand: DeclarationArgument, parsed: { value?: string } | undefined) => boolean;
  isCompound: (operand: DeclarationArgument) => boolean;
  findOperandEquals: (word: string) => number;
  checkReadonlyConflict: (
    shell: Shell,
    builtin: string,
    targetName: string,
    variable: Variable | undefined,
    options: DeclarationOptions,
    assigns: boolean
  ) => boolean;
  applyAttributes: (
    shell: Shell,
    builtin: string,
    variable: Variable,
    options: DeclarationOptions,
    assigns: boolean,
    impliesIndexed: boolean
  ) => boolean;
  assignLocally: (
    shell: Shell,
    variable: Variable,
    assignment: Assignment & { expandedElements?: CompoundElement[] }
  ) => boolean;
}

// code-gauge-allow functionParameterCount -- Resolves nameref-aware command-prefix targets before delegating to declarePrefixed.
export function tryDeclarePrefixed(
  shell: Shell,
  builtin: string,
  name: string,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: DeclarationOptions,
  ctx: { isLocal: boolean; isSubscripted: boolean; hooks: PrefixedDeclareHooks }
): boolean | undefined {
  if (ctx.isLocal || ctx.isSubscripted || (builtin !== 'export' && builtin !== 'readonly')) return undefined;
  const targetName = ctx.hooks.resolveTargetName(shell, name, options);
  const tempVar = shell.declarationPrefixVariable(targetName);
  return tempVar
    ? declarePrefixed(shell, builtin, targetName, tempVar, operand, parsed, options, ctx.hooks)
    : undefined;
}

// code-gauge-allow functionParameterCount -- Needs shell, builtin, operand name, prefix cell, raw/parsed operand, options, and hooks.
function declarePrefixed(
  shell: Shell,
  builtin: string,
  name: string,
  tempVar: Variable,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: DeclarationOptions,
  hooks: PrefixedDeclareHooks
): boolean {
  const assigns = hooks.hasValue(operand, parsed);
  let enclosing = shell.findEnclosingForPrefix(name);
  if (
    hooks.checkReadonlyConflict(
      shell,
      builtin,
      name,
      tempVar.attributes.has('r') ? tempVar : enclosing,
      options,
      assigns
    )
  ) {
    return false;
  }
  if (enclosing?.attributes.has('n')) {
    return applyPrefixedTempOnly(shell, builtin, tempVar, operand, parsed, options, { assigns, hooks });
  }
  const ensureEnclosing = (): Variable => {
    if (!enclosing) {
      enclosing = { name, value: undefined, attributes: new Set() };
      shell.state.scopes[0].set(name, enclosing);
    }
    return enclosing;
  };
  if (!assignPrefixedOperand(shell, builtin, tempVar, ensureEnclosing, operand, parsed, options, hooks)) return false;
  return propagatePrefixedAttributes(shell, builtin, tempVar, ensureEnclosing, operand, options, { assigns, hooks });
}

// code-gauge-allow functionParameterCount -- Carries shell, builtin, temporary cell, lazy enclosing cell, raw/parsed operand, options, and hooks.
function assignPrefixedOperand(
  shell: Shell,
  builtin: string,
  tempVar: Variable,
  ensureEnclosing: () => Variable,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: DeclarationOptions,
  hooks: PrefixedDeclareHooks
): boolean {
  if (parsed?.value !== undefined) {
    if (!shell.assignScalarTo(ensureEnclosing(), parsed.value, parsed.append)) return false;
    tempVar.value = { kind: 'scalar', value: parsed.value };
    return true;
  }
  if (typeof operand === 'string') return true;
  if (operand.array) {
    const target = ensureEnclosing();
    return (
      hooks.applyAttributes(shell, builtin, target, options, true, false) && hooks.assignLocally(shell, target, operand)
    );
  }
  if (operand.value === undefined && hooks.findOperandEquals(operand.text) === -1) return true;
  const rhs = operand.value
    ? shell.expander.withSpacedStar(() => shell.expander.expandAssignmentValue(operand.value as Word))
    : '';
  if (!shell.assignScalarTo(ensureEnclosing(), rhs, operand.append)) return false;
  tempVar.value = { kind: 'scalar', value: rhs };
  return true;
}

// code-gauge-allow functionParameterCount -- Carries shell, builtin, temporary cell, lazy enclosing cell, operand, options, and context.
function propagatePrefixedAttributes(
  shell: Shell,
  builtin: string,
  tempVar: Variable,
  ensureEnclosing: () => Variable,
  operand: DeclarationArgument,
  options: DeclarationOptions,
  ctx: { assigns: boolean; hooks: PrefixedDeclareHooks }
): boolean {
  if (options.set.has('x')) tempVar.attributes.add('x');
  if (options.unset.has('x')) tempVar.attributes.delete('x');
  if (options.set.has('r')) tempVar.attributes.add('r');
  if (options.unset.has('x')) return true;
  const target = ensureEnclosing();
  if (
    !ctx.hooks.isCompound(operand) &&
    !ctx.hooks.applyAttributes(shell, builtin, target, options, ctx.assigns, false)
  ) {
    return false;
  }
  if (tempVar.value?.kind === 'scalar' && !shell.assignScalarTo(target, tempVar.value.value, false)) return false;
  for (const attr of tempVar.attributes) target.attributes.add(attr);
  return true;
}

// code-gauge-allow functionParameterCount -- Updates only the temporary prefix cell when an enclosing nameref must stay intact.
function applyPrefixedTempOnly(
  shell: Shell,
  builtin: string,
  tempVar: Variable,
  operand: DeclarationArgument,
  parsed: { append: boolean; value?: string } | undefined,
  options: DeclarationOptions,
  ctx: { assigns: boolean; hooks: PrefixedDeclareHooks }
): boolean {
  if (
    !ctx.hooks.applyAttributes(shell, builtin, tempVar, options, ctx.assigns || ctx.hooks.isCompound(operand), false)
  ) {
    return false;
  }
  let ok = true;
  if (parsed?.value !== undefined) ok = shell.assignScalarTo(tempVar, parsed.value, parsed.append);
  else if (typeof operand !== 'string') ok = ctx.hooks.assignLocally(shell, tempVar, operand);
  if (options.set.has('r')) tempVar.attributes.add('r');
  return ok;
}
