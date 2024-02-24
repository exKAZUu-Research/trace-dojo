import { instrumentCode, traceCode } from '../app/lib/solveProblem';

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

export function generateProgram(programId: ProgramId, languageId: LanguageId): string {
  // TODO(exKAZUu): 問題IDに紐づくプログラム（テンプレート）を取得して、乱数を使って具体的なプログラムを生成する。
  const code = `const bear = new Character(); /* 1 */
bear.moveForward(); /* 2 */
bear.turnLeft(); /* 3 */
bear.upPen(); /* 4 */
let i = 0; /* 5 */
bear.moveForward(); /* 6 */
const turtle = new Character({x: 3, y: 1, color: 'green'}); /* 7 */
turtle.moveForward(); /* 8 */
const foo = 'あいうえお'; /* 9 */
var bar = 123; /* 10 */
i = i + 1; /* 11 */
turtle.moveForward(); /* 12 */
turtle.moveForward(); /* 13 */`;
  traceCode(instrumentCode(code));
  return (
    `const bear = new Character();
bear.moveForward();
bear.turnLeft();
bear.upPen();
let i = 0;
bear.moveForward();
const turtle = new Character({x: 3, y: 1, color: 'green'});
turtle.moveForward();
const foo = 'あいうえお';
var bar = 123;
i = i + 1;
turtle.moveForward();
turtle.moveForward();` || programIdToLanguageIdToProgram[programId][languageId]
  );
}

export function getExplanation(programId: ProgramId, languageId: LanguageId): string {
  return programIdToLanguageIdToExplanation[programId][languageId];
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
