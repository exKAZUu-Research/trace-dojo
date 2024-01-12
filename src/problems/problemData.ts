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

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'curve', 'stairs'],
    ['square', 'rectangle', 'diamond'],
  ],
  tuBeginner2: [],
};

export function generateProgramById(problemId: string): string {
  // TODO(exKAZUu): 問題IDに紐づくプログラム（テンプレート）を取得して、乱数を使って具体的なプログラムを生成する。
  return `const turtle = new Turtle();
turtle.moveForward(5);`;
}

export const programIdToProgram: Record<ProgramId, Record<LanguageId, string>> = {
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
