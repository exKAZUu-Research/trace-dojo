import { literalType, type TemplateLiteralType, type Type } from './types';

/**
 * The part of a template literal type each placeholder of another takes, as TypeScript's
 * `inferFromLiteralPartsToTemplateLiteral` splits it: a placeholder ends at the first occurrence of the text after it,
 * which may lie in a later text of the source, or after one character when another placeholder follows directly.
 */
export function templateParts(
  source: TemplateLiteralType,
  target: TemplateLiteralType,
  template: (texts: string[], types: Type[]) => Type
): Type[] | undefined {
  const sourceTexts = source.texts;
  const lastSource = sourceTexts.length - 1;
  const targetStart = target.texts[0];
  const targetEnd = target.texts.at(-1) ?? '';
  const sourceEnd = sourceTexts[lastSource];
  if (
    (lastSource === 0 && sourceTexts[0].length < targetStart.length + targetEnd.length) ||
    !sourceTexts[0].startsWith(targetStart) ||
    !sourceEnd.endsWith(targetEnd)
  )
    return undefined;
  const remainingEnd = sourceEnd.slice(0, sourceEnd.length - targetEnd.length);
  const textAt = (index: number): string => (index < lastSource ? sourceTexts[index] : remainingEnd);
  const parts: Type[] = [];
  let start: TemplatePosition = [0, targetStart.length];
  const addPart = (end: TemplatePosition): void => {
    parts.push(templatePart(source, textAt, start, end, template));
    start = end;
  };
  for (const delimiter of target.texts.slice(1, -1)) {
    const end = templatePartEnd(textAt, lastSource, start, delimiter);
    if (!end) return undefined;
    addPart(end);
    start = [end[0], end[1] + delimiter.length];
  }
  addPart([lastSource, textAt(lastSource).length]);
  return parts;
}

/** A position in the texts of a template literal type: the index of a text and the offset in it. */
type TemplatePosition = [number, number];

/** Where a part that `delimiter` follows ends, from the first occurrence of `delimiter` in the source's texts. */
function templatePartEnd(
  textAt: (index: number) => string,
  lastSource: number,
  [segment, position]: TemplatePosition,
  delimiter: string
): TemplatePosition | undefined {
  if (delimiter.length === 0) {
    if (position < textAt(segment).length) return [segment, position + 1];
    return segment < lastSource ? [segment + 1, 0] : undefined;
  }
  let endSegment = segment;
  let endPosition = textAt(segment).indexOf(delimiter, position);
  while (endPosition < 0) {
    endSegment++;
    if (endSegment > lastSource) return undefined;
    endPosition = textAt(endSegment).indexOf(delimiter);
  }
  return [endSegment, endPosition];
}

/** The part of a template literal type between two positions: a string literal within one text, else a template. */
function templatePart(
  source: TemplateLiteralType,
  textAt: (index: number) => string,
  [segment, position]: TemplatePosition,
  [endSegment, endPosition]: TemplatePosition,
  template: (texts: string[], types: Type[]) => Type
): Type {
  if (endSegment === segment) return literalType(textAt(segment).slice(position, endPosition));
  return template(
    [
      source.texts[segment].slice(position),
      ...source.texts.slice(segment + 1, endSegment),
      textAt(endSegment).slice(0, endPosition),
    ],
    source.types.slice(segment, endSegment)
  );
}
