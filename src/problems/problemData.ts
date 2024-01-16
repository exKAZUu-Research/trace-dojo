import { Character } from '../app/lib/Character';

export const courseIds = ['tuBeginner1', 'tuBeginner2'];
export type CourseId = (typeof courseIds)[number];

export const programIds = ['straight', 'curve', 'stairs', 'square', 'rectangle', 'diamond'];
export type ProgramId = (typeof programIds)[number];

export const languageIds = ['js', 'java'];
export type LanguageId = (typeof languageIds)[number];

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

export function generateProgram(programId: ProgramId, languageId: LanguageId): string {
  // TODO(exKAZUu): 問題IDに紐づくプログラム（テンプレート）を取得して、乱数を使って具体的なプログラムを生成する。
  return (
    `const turtle = new Turtle();
turtle.moveForward(5);` || programIdToLanguageIdToProgram[programId][languageId]
  );
}

export function getExplanation(programId: ProgramId, languageId: LanguageId): string {
  return programIdToLanguageIdToExplanation[programId][languageId];
}

export function getTurtleGraphicsInitialCharacters(programId: ProgramId): Character[] {
  return programIdToTurtleGraphicsInitialCharacters[programId];
}

export const programIdToLanguageIdToProgram: Record<ProgramId, Record<LanguageId, string>> = {
  straight: {
    js: `
const turtle = new Turtle();
turtle.moveForward(<3-5>);
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var turtle = new Turtle();
    turtle.moveForward(<3-5>);
  }
}
`.trim(),
  },
  curve: {
    js: `
const turtle = new Turtle();
turtle.moveForward(<3-5>);
turtle.turnLeft();
turtle.moveForward(<3-5>);
`.trim(),
    java: `
public class Curve {
  public static void main(String[] args) {
    var turtle = new Turtle();
    turtle.moveForward(<3-5>);
    turtle.turnLeft();
    turtle.moveForward(<3-5>);
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

export const programIdToTurtleGraphicsInitialCharacters: Record<ProgramId, Character[]> = {
  straight: [
    new Character(1, 'Turtle1', 1, 1, 'up', 'blue', false, ['1,1']),
    new Character(2, 'Turtle2', 3, 3, 'up', 'red', true, ['2,3', '3,3']),
  ],
  curve: [],
};
