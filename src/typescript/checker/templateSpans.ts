import type { ExecutionBudget } from '../../interpreter/limits';
import { isPatternKey } from './indexInfos';
import { isIntrinsic, newTypeId, stringType, type Type } from './types';

/**
 * The texts and placeholders of a template literal type with each placeholder that is a template literal type or spells
 * one text spliced into the texts, as TypeScript's `getTemplateLiteralType` adds its spans.
 */
export function splicedSpans(
  texts: string[],
  types: Type[],
  budget: ExecutionBudget
): { texts: string[]; types: Type[] } {
  const spliced = { texts: [] as string[], types: [] as Type[] };
  let text = texts[0];
  const append = (added: string): void => {
    chargeText(budget, added.length);
    text += added;
  };
  const addSpans = (spanTexts: string[], spanTypes: Type[]): void => {
    for (const [index, type] of spanTypes.entries()) {
      if (type.kind === 'templateLiteral') {
        append(type.texts[0]);
        addSpans(type.texts, type.types);
      } else if (isSpelledLiteral(type)) {
        append(spelledText(type));
      } else {
        spliced.texts.push(text);
        spliced.types.push(type);
        text = '';
      }
      append(spanTexts[index + 1]);
    }
  };
  addSpans(texts, types);
  spliced.texts.push(text);
  return spliced;
}

/** The strings a template spells when each placeholder is a literal or a union of them, else `undefined`. */
export function literalCombinations(texts: string[], types: Type[], budget: ExecutionBudget): string[] | undefined {
  let combinations: string[] = [texts[0]];
  for (const [index, type] of types.entries()) {
    const members = type.kind === 'union' ? type.types : [type];
    if (!members.every(isSpelledLiteral)) return undefined;
    budget.spend(combinations.length * members.length);
    combinations = appendEach(combinations, members, texts[index + 1], budget);
  }
  return combinations;
}

export type StringMapping = 'Uppercase' | 'Lowercase' | 'Capitalize' | 'Uncapitalize';

/** The text `Uppercase<T>` or its kin maps a text to, charged before it is built. */
export function mapText(budget: ExecutionBudget, mapping: StringMapping, text: string): string {
  chargeText(budget, text.length);
  switch (mapping) {
    case 'Uppercase': {
      return text.toUpperCase();
    }
    case 'Lowercase': {
      return text.toLowerCase();
    }
    case 'Capitalize': {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    default: {
      return text.charAt(0).toLowerCase() + text.slice(1);
    }
  }
}

/**
 * The template literal type of spliced texts and placeholders that are neither literals nor unions: `string` for
 * `${string}`, and the placeholder itself for one pattern, as `${Uppercase<string>}` is `Uppercase<string>`.
 */
export function placeholderTemplate(texts: string[], types: Type[]): Type {
  if (texts.every((text) => text === '')) {
    if (types.every((type) => isIntrinsic(type, 'string'))) return stringType;
    if (types.length === 1 && isPatternKey(types[0])) return types[0];
  }
  return { kind: 'templateLiteral', id: newTypeId(), texts, types };
}

/** Whether a template placeholder spells one text, as a literal, `null`, or `undefined` does. */
export function isSpelledLiteral(member: Type): boolean {
  return member.kind === 'literal' || isIntrinsic(member, 'null') || isIntrinsic(member, 'undefined');
}

/**
 * Each prefix followed by the text of each literal, `null`, or `undefined` member and the suffix, charged before it is
 * built.
 */
function appendEach(prefixes: string[], members: Type[], suffix: string, budget: ExecutionBudget): string[] {
  const memberTexts = members.map(spelledText);
  const prefixLength = prefixes.reduce((sum, prefix) => sum + prefix.length, 0);
  const memberLength = memberTexts.reduce((sum, memberText) => sum + memberText.length, 0);
  chargeText(budget, prefixLength * members.length + (memberLength + suffix.length * members.length) * prefixes.length);
  return prefixes.flatMap((prefix) => memberTexts.map((memberText) => prefix + memberText + suffix));
}

/**
 * Charges for building `length` characters of a literal type's text, as the runtime charges for building a string, so
 * that a short chain of templates that each double the text runs out of the budget instead of memory.
 */
function chargeText(budget: ExecutionBudget, length: number): void {
  budget.spend(Math.ceil(length / 16));
}

function spelledText(member: Type): string {
  return member.kind === 'literal' ? String(member.value) : (member as { name: string }).name;
}
