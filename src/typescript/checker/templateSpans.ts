import { isPatternKey } from './indexInfos';
import { isIntrinsic, newTypeId, stringType, type Type } from './types';

/**
 * The texts and placeholders of a template literal type with each placeholder that is a template literal type or spells
 * one text spliced into the texts, as TypeScript's `getTemplateLiteralType` adds its spans.
 */
export function splicedSpans(texts: string[], types: Type[]): { texts: string[]; types: Type[] } {
  const spliced = { texts: [] as string[], types: [] as Type[] };
  let text = texts[0];
  const addSpans = (spanTexts: string[], spanTypes: Type[]): void => {
    for (const [index, type] of spanTypes.entries()) {
      if (type.kind === 'templateLiteral') {
        text += type.texts[0];
        addSpans(type.texts, type.types);
      } else if (isSpelledLiteral(type)) {
        text += appendEach([''], [type], '')[0];
      } else {
        spliced.texts.push(text);
        spliced.types.push(type);
        text = '';
      }
      text += spanTexts[index + 1];
    }
  };
  addSpans(texts, types);
  spliced.texts.push(text);
  return spliced;
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

/** Each prefix followed by the text of each literal, `null`, or `undefined` member and the suffix. */
export function appendEach(prefixes: string[], members: Type[], suffix: string): string[] {
  return prefixes.flatMap((prefix) =>
    members.map(
      (member) =>
        prefix + (member.kind === 'literal' ? String(member.value) : (member as { name: string }).name) + suffix
    )
  );
}
