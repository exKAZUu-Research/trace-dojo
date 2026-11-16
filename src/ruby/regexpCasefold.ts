import { RegExpParser, RegExpSyntaxError, visitRegExpAST } from '@eslint-community/regexpp';

import { ExecutionLimitError } from '../interpreter/limits';
import { UnsupportedFeatureError } from './runtime';

// Ruby 4.0.9 characters whose Unicode upper/lowercase mapping expands to multiple code points.
const expandingCharacters =
  'ßİŉǰΐΰևẖẗẘẙẚὐὒὔὖᾀᾁᾂᾃᾄᾅᾆᾇᾈᾉᾊᾋᾌᾍᾎᾏᾐᾑᾒᾓᾔᾕᾖᾗᾘᾙᾚᾛᾜᾝᾞᾟᾠᾡᾢᾣᾤᾥᾦᾧᾨᾩᾪᾫᾬᾭᾮᾯᾲᾳᾴᾶᾷᾼῂῃῄῆῇῌῒΐῖῗῢΰῤῦῧῲῳῴῶῷῼﬀﬁﬂﬃﬄﬅﬆﬓﬔﬕﬖﬗ';

export function regexpHasExpandingCasefold(source: string, subject: string): boolean {
  if ([...subject].some(expands)) return true;
  const upper = subject.toUpperCase();
  const lower = subject.toLowerCase();
  const candidates = [...expandingCharacters].filter(
    (char) => upper.includes(char.toUpperCase()) || lower.includes(char.toLowerCase())
  );
  let expanding = false;
  try {
    const pattern = new RegExpParser().parsePattern(source, 0, source.length, { unicode: true });
    const characterSet = (start: number, end: number): void => {
      const matcher = new RegExp(`^(?:${source.slice(start, end)})$`, 'iu');
      if (candidates.some((char) => matcher.test(char))) expanding = true;
    };
    visitRegExpAST(pattern, {
      onCharacterEnter(node) {
        if (expands(String.fromCodePoint(node.value))) expanding = true;
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

function expands(char: string): boolean {
  return char.toUpperCase().length > char.length || char.toLowerCase().length > char.length;
}
