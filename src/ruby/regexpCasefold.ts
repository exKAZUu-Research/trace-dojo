import { type AST, RegExpParser, RegExpSyntaxError, visitRegExpAST } from '@eslint-community/regexpp';

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
  const { subjectFolds, candidates } = casefoldCandidates(subject);
  let expanding = false;
  try {
    const pattern = new RegExpParser().parsePattern(source, 0, source.length, { unicode: true });
    const width = maximumScopeWidth(pattern);
    const possibleSubjectFolds = subjectFolds.filter((fold) => codePointCharacters(fold).length <= width);
    const characterSet = (start: number, end: number): void => {
      const matcher = new RegExp(`^(?:${source.slice(start, end)})$`, 'iu');
      if (
        candidates.some((char) => matcher.test(char)) ||
        possibleSubjectFolds.some((fold) => codePointCharacters(fold).some((char) => matcher.test(char)))
      )
        expanding = true;
    };
    visitRegExpAST(pattern, {
      onCharacterEnter(node) {
        const char = String.fromCodePoint(node.value);
        if (expandingFolds.has(char) || possibleSubjectFolds.some((fold) => fold.includes(char.toLowerCase())))
          expanding = true;
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

function casefoldCandidates(subject: string): { subjectFolds: string[]; candidates: string[] } {
  const subjectFolds = codePointCharacters(subject).flatMap((char) => {
    const fold = expandingFolds.get(char);
    return fold === undefined ? [] : [fold];
  });
  const upper = subject.toUpperCase();
  const lower = subject.toLowerCase();
  const candidates = [...expandingFolds]
    .filter(([, fold]) => upper.includes(fold.toUpperCase()) || lower.includes(fold.toLowerCase()))
    .map(([char]) => char);
  return { subjectFolds, candidates };
}

function maximumScopeWidth(pattern: AST.Pattern): number {
  let width = maximumWidth(pattern);
  visitRegExpAST(pattern, {
    onAssertionEnter(node) {
      if (node.kind === 'lookahead' || node.kind === 'lookbehind')
        width = Math.max(width, ...node.alternatives.map(maximumWidth));
    },
  });
  return width;
}

function maximumWidth(node: AST.Node): number {
  switch (node.type) {
    case 'Pattern':
    case 'Group':
    case 'CapturingGroup': {
      return Math.max(0, ...node.alternatives.map(maximumWidth));
    }
    case 'Alternative': {
      let width = 0;
      for (const element of node.elements) width = Math.min(3, width + maximumWidth(element));
      return width;
    }
    case 'Quantifier': {
      return node.max === 0 ? 0 : Math.min(3, maximumWidth(node.element) * Math.min(3, node.max));
    }
    case 'Assertion': {
      return 0;
    }
    case 'Backreference': {
      return 3;
    }
    default: {
      return 1;
    }
  }
}
