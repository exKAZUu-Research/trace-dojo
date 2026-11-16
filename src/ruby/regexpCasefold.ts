import { RegExpParser, RegExpSyntaxError, visitRegExpAST } from '@eslint-community/regexpp';

import { ExecutionLimitError } from '../interpreter/limits';
import { UnsupportedFeatureError } from './runtime';
import { codePointCharacters } from './unicodeText';

const expandingFolds: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ß: 'ss',
    İ: 'i̇',
    ŉ: 'ʼn',
    ǰ: 'ǰ',
    ΐ: 'ΐ',
    ΰ: 'ΰ',
    և: 'եւ',
    ẖ: 'ẖ',
    ẗ: 'ẗ',
    ẘ: 'ẘ',
    ẙ: 'ẙ',
    ẚ: 'aʾ',
    ẞ: 'ss',
    ὐ: 'ὐ',
    ὒ: 'ὒ',
    ὔ: 'ὔ',
    ὖ: 'ὖ',
    ᾀ: 'ἀι',
    ᾁ: 'ἁι',
    ᾂ: 'ἂι',
    ᾃ: 'ἃι',
    ᾄ: 'ἄι',
    ᾅ: 'ἅι',
    ᾆ: 'ἆι',
    ᾇ: 'ἇι',
    ᾈ: 'ἀι',
    ᾉ: 'ἁι',
    ᾊ: 'ἂι',
    ᾋ: 'ἃι',
    ᾌ: 'ἄι',
    ᾍ: 'ἅι',
    ᾎ: 'ἆι',
    ᾏ: 'ἇι',
    ᾐ: 'ἠι',
    ᾑ: 'ἡι',
    ᾒ: 'ἢι',
    ᾓ: 'ἣι',
    ᾔ: 'ἤι',
    ᾕ: 'ἥι',
    ᾖ: 'ἦι',
    ᾗ: 'ἧι',
    ᾘ: 'ἠι',
    ᾙ: 'ἡι',
    ᾚ: 'ἢι',
    ᾛ: 'ἣι',
    ᾜ: 'ἤι',
    ᾝ: 'ἥι',
    ᾞ: 'ἦι',
    ᾟ: 'ἧι',
    ᾠ: 'ὠι',
    ᾡ: 'ὡι',
    ᾢ: 'ὢι',
    ᾣ: 'ὣι',
    ᾤ: 'ὤι',
    ᾥ: 'ὥι',
    ᾦ: 'ὦι',
    ᾧ: 'ὧι',
    ᾨ: 'ὠι',
    ᾩ: 'ὡι',
    ᾪ: 'ὢι',
    ᾫ: 'ὣι',
    ᾬ: 'ὤι',
    ᾭ: 'ὥι',
    ᾮ: 'ὦι',
    ᾯ: 'ὧι',
    ᾲ: 'ὰι',
    ᾳ: 'αι',
    ᾴ: 'άι',
    ᾶ: 'ᾶ',
    ᾷ: 'ᾶι',
    ᾼ: 'αι',
    ῂ: 'ὴι',
    ῃ: 'ηι',
    ῄ: 'ήι',
    ῆ: 'ῆ',
    ῇ: 'ῆι',
    ῌ: 'ηι',
    ῒ: 'ῒ',
    ΐ: 'ΐ',
    ῖ: 'ῖ',
    ῗ: 'ῗ',
    ῢ: 'ῢ',
    ΰ: 'ΰ',
    ῤ: 'ῤ',
    ῦ: 'ῦ',
    ῧ: 'ῧ',
    ῲ: 'ὼι',
    ῳ: 'ωι',
    ῴ: 'ώι',
    ῶ: 'ῶ',
    ῷ: 'ῶι',
    ῼ: 'ωι',
    ﬀ: 'ff',
    ﬁ: 'fi',
    ﬂ: 'fl',
    ﬃ: 'ffi',
    ﬄ: 'ffl',
    ﬅ: 'st',
    ﬆ: 'st',
    ﬓ: 'մն',
    ﬔ: 'մե',
    ﬕ: 'մի',
    ﬖ: 'վն',
    ﬗ: 'մխ',
  })
);

export function regexpHasExpandingCasefold(source: string, subject: string): boolean {
  if (codePointCharacters(subject).some((char) => expandingFolds.has(char))) return true;
  const upper = subject.toUpperCase();
  const lower = subject.toLowerCase();
  const candidates = [...expandingFolds]
    .filter(([, fold]) => upper.includes(fold.toUpperCase()) || lower.includes(fold.toLowerCase()))
    .map(([char]) => char);
  let expanding = false;
  try {
    const pattern = new RegExpParser().parsePattern(source, 0, source.length, { unicode: true });
    const characterSet = (start: number, end: number): void => {
      const matcher = new RegExp(`^(?:${source.slice(start, end)})$`, 'iu');
      if (candidates.some((char) => matcher.test(char))) expanding = true;
    };
    visitRegExpAST(pattern, {
      onCharacterEnter(node) {
        if (expandingFolds.has(String.fromCodePoint(node.value))) expanding = true;
      },
      onCharacterClassEnter(node) {
        characterSet(node.start, node.end);
      },
      onCharacterSetEnter(node) {
        characterSet(node.start, node.end);
      },
    });
  } catch (error) {
    if (error instanceof RangeError) throw new ExecutionLimitError('operations');
    if (error instanceof RegExpSyntaxError) throw new UnsupportedFeatureError('正規表現の casefold 構文の検証');
    throw error;
  }
  return expanding;
}
