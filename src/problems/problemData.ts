import { Random } from '../app/lib/random';
import type { GeneratedProgram } from '../types';

export const courseIds = ['tuBeginner1', 'tuBeginner2'] as const;
export type CourseId = (typeof courseIds)[number];

export const programIds = [
  'straight',
  'curve',
  'stairs',
  'square',
  'rectangle',
  'diamond',
  'test1',
  'getProgramCheckpointsTest',
] as const;
export type ProgramId = (typeof programIds)[number];

export const languageIds = ['jsInstrumentation', 'js', 'java'] as const;
export type LanguageId = (typeof languageIds)[number];

export const visibleLanguageIds = ['java'] as const;
export type VisibleLanguageId = (typeof visibleLanguageIds)[number];

export const defaultLanguageId = 'java' as const;

export const languageIdToName: Record<VisibleLanguageId, string> = {
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
  test1: 'ステップ実行のテスト用問題(1)',
  getProgramCheckpointsTest: 'チェックポイント取得のテスト用問題',
};

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'curve', 'stairs'],
    ['square', 'rectangle', 'diamond'],
  ],
  tuBeginner2: [['test1', 'getProgramCheckpointsTest']],
};

export function generateProgram(programId: ProgramId, languageId: LanguageId, variableSeed: string): GeneratedProgram {
  const randomNumberRegex = /<(\d+)-(\d+)>/g;
  const programTemplate = programIdToLanguageIdToProgram[programId];
  const jsTemplate = programTemplate['jsInstrumentation'];
  const randomNumberArray: number[] = [];

  const random = new Random(variableSeed);
  const jsProgram = jsTemplate.replaceAll(randomNumberRegex, (match, min, max) => {
    const randomNumber = random.getInteger(Number(min), Number(max));
    randomNumberArray.push(randomNumber);
    return randomNumber.toString();
  });

  let index = 0;
  const displayProgram = languageId
    ? programTemplate[languageId].replaceAll(randomNumberRegex, () => randomNumberArray[index++].toString())
    : '';
  return {
    displayProgram,
    instrumentedProgram: jsProgram,
  };
}

export function getExplanation(programId: ProgramId, languageId: VisibleLanguageId): Record<'title' | 'body', string> {
  return programIdToLanguageIdToExplanation[programId]?.[languageId];
}

export function getProgramCheckpoints(programId: ProgramId): number[] {
  const jsInstrumentationProgram = programIdToLanguageIdToProgram[programId]['jsInstrumentation'];
  const lines = jsInstrumentationProgram.split('\n');

  const checkpoints: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (/(\/\/|#)\s*CP\s*$/.test(line)) {
      checkpoints.push(i + 1);
    }
  }

  return checkpoints;
}

const defaultProgram = {
  jsInstrumentation: '',
  js: '',
  java: '',
};

export const programIdToLanguageIdToProgram: Record<ProgramId, Record<LanguageId, string>> = {
  straight: {
    jsInstrumentation: '',
    js: `
const character1 = new Character();
character1.moveForward();
character1.moveForward();
character1.moveForward();
character1.moveForward();
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var character1 = new Character();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
    character1.moveForward();
  }
}
`.trim(),
  },
  curve: {
    jsInstrumentation: `
s.set('t', new Turtle(1, 1, 5, 'G'));
s.get('t').forward();
s.set('a', new Turtle(1, 0, 2, 'R'));
s.set('b', 1);
s.get('t').forward();
s.get('t').forward(); // CP
s.get('t').forward();
`.trim(),
    js: `
const t = new Turtle(1, 1, 5, 'G');
t.forward();
const a = new Turtle(1, 0, 2, 'R');
const b = 1;
t.forward();
t.forward();
t.forward();
`.trim(),
    java: `
const t = new Turtle(1, 1, 5, 'G');
t.forward();
const a = new Turtle(1, 0, 2, 'R');
const b = 1;
t.forward();
t.forward();
t.forward();
`.trim(),
  },
  diamond: defaultProgram,
  rectangle: defaultProgram,
  square: defaultProgram,
  stairs: defaultProgram,
  test1: {
    jsInstrumentation: `
stack = [];

enterScope();
set("a", 1);
if (get("a") > 0) {               // 2
  set("b", 2);                    // 3
  set("a", f(get("a"), get("b")); // 4
}
let c = get("a") * 2;             // 5

function f(x, y) {                // 6
  enterScope();
  const ret = x * y;              // 7
  leaveScope();
  return ret;
}

function enterScope() {
  stack.push({});
}

function leaveScope() {
  if (stack.length === 0) throw new Error();
  stack.pop();
}

function get(name) {
  for (let i = stack.length; i >= 0; i--) {
    if (stack[i][name] !== undefined) {
      return stack[i][name];
    }
  }
  throw new Error();
}

function set(value, name) {
  for (let i = stack.length; i >= 0; i--) {
    if (stack[i][name] !== undefined) {
      stack[i][name] = value;
      return;
    }
  }
  stack[i].at(-1) = value;
}
`,
    js: '',
    java: '',
  },
  getProgramCheckpointsTest: {
    jsInstrumentation: `
s.set('t', new Turtle());
s.get('t').forward(); // CP
s.get('t').forward();
s.get('t').rotateRight();
s.get('t').forward(); //  CP
s.get('t').forward(); // CP character at end: NG
s.get('t').forward();
s.get('t').forward();
`.trim(),
    js: `
const t = new Character();
t.moveForward();
t.moveForward();
t.turnRight();
t.moveForward();
t.moveForward();
t.moveForward();
t.moveForward();
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var t = new Character();
    t.moveForward();
    t.moveForward();
    t.turnRight();
    t.moveForward();
    t.moveForward();
    t.moveForward();
    t.moveForward();
  }
}
`.trim(),
  },
};

const defaultExplanation = {
  java: {
    title: '',
    body: '',
  },
};

export const programIdToLanguageIdToExplanation: Record<
  ProgramId,
  Record<VisibleLanguageId, Record<'title' | 'body', string>>
> = {
  straight: defaultExplanation,
  curve: defaultExplanation,
  diamond: defaultExplanation,
  rectangle: defaultExplanation,
  square: defaultExplanation,
  stairs: defaultExplanation,
  test1: defaultExplanation,
  getProgramCheckpointsTest: defaultExplanation,
};
