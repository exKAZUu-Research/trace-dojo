import type { GeneratedProgram } from '../types';

export const courseIds = ['tuBeginner1', 'tuBeginner2'];
export type CourseId = (typeof courseIds)[number];

export const programIds = ['straight', 'curve', 'stairs', 'square', 'rectangle', 'diamond'];
export type ProgramId = (typeof programIds)[number];

export const languageIds = ['js', 'java'];
export type LanguageId = (typeof languageIds)[number];

export const languageIdToName: Record<LanguageId, string> = {
  js: 'JavaScript',
  java: 'Java',
};

export const courseIdToName: Record<CourseId, string> = {
  tuBeginner1: '初級プログラミングⅠ',
  tuBeginner2: '初級プログラミングⅡ',
};

export const programIdToName: Record<ProgramId, string> = {
  straight: '線を描こう(1)',
  curve: '線を描こう(2)',
  stairs: '線を描こう(3)',
  square: '図形を描こう(1)',
  rectangle: '図形を描こう(2)',
  diamond: '図形を描こう(3)',
};

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'curve', 'stairs'],
    ['square', 'rectangle', 'diamond'],
  ],
  tuBeginner2: [],
};

export function generateProgram(programId: ProgramId, languageId: LanguageId): GeneratedProgram {
  // TODO(exKAZUu): 問題IDに紐づくプログラム（テンプレート）を取得して、乱数を使って具体的なプログラムを生成する。
  console.log('languageId', languageId);
  const randomNumberRegex = /<(\d+)-(\d+)>/g;
  const programTemplete = programIdToLanguageIdToProgram[programId];
  const jsTemplete = programTemplete['js'];
  const randomNumberArray: number[] = [];
  const jsProgram = jsTemplete.replaceAll(randomNumberRegex, (match, min, max) => {
    const randomNumber = getRandomInt(Number(min), Number(max));
    randomNumberArray.push(randomNumber);
    return randomNumber.toString();
  });

  let index = 0;
  const displayProgram = programTemplete['java'].replaceAll(randomNumberRegex, () =>
    randomNumberArray[index++].toString()
  );
  const generateProgram = {
    displayProgram,
    excuteProgram: jsProgram,
  };
  return generateProgram;
}

function getRandomInt(min: number, max: number): number {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min)) + min;
}

export function getExplanation(programId: ProgramId, languageId: LanguageId): string {
  return programIdToLanguageIdToExplanation[programId][languageId];
}

export const programIdToLanguageIdToProgram: Record<ProgramId, Record<LanguageId, string>> = {
  straight: {
    js: `
const character1 = new Character();
character1.moveForward();
character1.moveForward();
character1.moveForward();
character1.moveForward();
<3-5>
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var character1 = new Character();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    <3-5>;
  }
}
`.trim(),
  },
  curve: {
    js: `
const character = new Character();
for (let i = 0; i < <3-10>; i++) {
  character.moveForward();
}
character.turnLeft();
for (let i = 0; i < <3-5>; i++) {
  character.moveForward();
}
`.trim(),
    java: `
public class Curve {
  public static void main(String[] args) {
    var character = new Character();
    for (int i = 0; i < <3-10>; i++) {
      character.moveForward();
    }
    character.turnLeft();
    for (int i = 0; i < <3-5>; i++) {
      character.moveForward();
    }
  }
}
`.trim(),
  },
};

export const programIdToLanguageIdToExplanation: Record<ProgramId, Record<LanguageId, string>> = {
  straight: {
    js: `
JavaScript向けの解説。JavaScript向けの解説。
`.trim(),
    java: `
Java向けの解説。Java向けの解説。
`.trim(),
  },
  curve: {
    js: `
JavaScript向けの解説。JavaScript向けの解説。
`.trim(),
    java: `
Java向けの解説。Java向けの解説。
`.trim(),
  },
};
