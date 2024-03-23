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
  'test2',
  'test3',
  'test4',
  'testCheckpoints',
] as const;
export type ProgramId = (typeof programIds)[number];

export const languageIds = ['instrumented', 'js', 'java'] as const;
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
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  testCheckpoints: 'チェックポイント取得のテスト用問題',
};

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'curve', 'stairs'],
    ['square', 'rectangle', 'diamond'],
  ],
  tuBeginner2: [['test1', 'test2', 'test3', 'test4', 'testCheckpoints']],
};

export function getExplanation(programId: ProgramId, languageId: VisibleLanguageId): Record<'title' | 'body', string> {
  return programIdToLanguageIdToExplanation[programId]?.[languageId];
}

const defaultProgram = {
  instrumented: '',
  js: '',
  java: '',
};

export const programIdToLanguageIdToProgram: Record<ProgramId, Record<LanguageId, string>> = {
  straight: {
    instrumented: `
s.set('c', new Character());
s.get('c').forward();
s.get('c').forward(); // CP
s.get('c').forward();
`.trim(),
    js: `
const c = new Character(); // sid: 1
c.forward(); // sid: 2
c.forward(); // sid: 3
c.forward(); // sid: 4
`.trim(),
    // sidがただの連番である場合、番号を省略できる。
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
  }
}
`.trim(),
  },
  curve: {
    instrumented: `
s.set('c', new Character());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  s.get('c').forward();
  s.get('c').forward(); // CP
  s.get('c').turnRight();
}
`.trim(),
    js: `
const c = new Character(); // sid
for (let i = 0; i < 2; i++) { // sid
  c.forward(); // sid
  c.forward(); // sid
  c.turnRight(); // sid
}
`.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character(); // sid
    for (let i = 0; i < 2; i++) { // sid
      c.forward(); // sid
      c.forward(); // sid
      c.turnRight(); // sid
    }
  }
}
`.trim(),
  },
  diamond: defaultProgram,
  rectangle: defaultProgram,
  square: defaultProgram,
  stairs: defaultProgram,
  test1: {
    instrumented: `
s.set('c', new Character());
s.get('c').forward();
s.get('c').forward(); // CP
s.get('c').forward();
`.trim(),
    js: `
const c = new Character(); // sid: 1
c.forward(); // sid: 2
c.forward(); // sid: 3
c.forward(); // sid: 4
`.trim(),
    // sidがただの連番である場合、番号を省略できる。
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
  }
}
`.trim(),
  },
  test2: {
    instrumented: `
s.set('c', new Character());
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
  s.get('c').forward();
  s.get('c').forward(); // CP
  s.get('c').turnRight();
}
`.trim(),
    js: `
const c = new Character(); // sid
for (let i = 0; i < 2; i++) { // sid
  c.forward(); // sid
  c.forward(); // sid
  c.turnRight(); // sid
}
`.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    Character c = new Character(); // sid
    for (let i = 0; i < 2; i++) { // sid
      c.forward(); // sid
      c.forward(); // sid
      c.turnRight(); // sid
    }
  }
}
`.trim(),
  },
  test3: {
    instrumented: `
s.set('a', 1);
if (s.get('a') > 0) {
  s.set('b', 2);
  s.set('a', f(s.get('a'), s.get('b')));
}
s.set('c', s.get('a') * 2);

function f(x, y) {
  try {
    s.enterNewScope();
    s.set('ret', x * y);
    return s.get('ret');
  } finally {
    s.leaveScope();
  }
}
`,
    js: `
let a = 1; // sid
if (a > 0) {
  let b = 2; // sid
  a = f(a, b); // sid
}
let c = a * 2; // sid

function f(x, y) {
  return x * y; // sid
}
`,
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
    int a = 1; // sid: 1
    if (a > 0) {
      int b = 2; // sid: 2
      a = f(a, b); // sid: 3
    }
    int c = a * 2; // sid: 4

    public static int f(int x, int y) {
      return x * y; // sid: 5
    }
  }
}
`.trim(),
  },
  test4: {
    instrumented: `
s.set('c1', new Character());
s.get('c1').forward();
s.get('c1').turnLeft();
s.get('c1').upPen();
s.set('i', 0);
s.get('c1').forward();

s.set('c2', new Character(<2-5>, <3-5>, 'G'));
s.get('c2').forward();
s.set('foo', 'あいうえお');
s.set('bar', <1-100>);
s.set('i', s.get('bar') + 1);
s.get('c2').forward();
s.get('c2').forward();
`.trim(),
    js: `
const c1 = new Character();
c1.forward();
c1.turnLeft();
c1.upPen();
let i = 0;
c1.forward();

const c2 = new Character({x: <2-5>, y: <3-5>, color: 'green'});
c2.forward();
const foo = 'あいうえお';
let bar = <1-100>;
i = bar + 1;
c2.forward();
c2.forward();
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Character c1 = new Character();
    c1.forward();
    c1.turnLeft();
    c1.upPen();
    int i = 0;
    c1.forward();

    Character c2 = new Character(<2-5>, <3-5>, "green");
    c2.forward();
    String foo = "あいうえお";
    int bar = <1-100>;
    i = bar + 1;
    c2.forward();
    c2.forward();
  }
};
`.trim(),
  },
  testCheckpoints: {
    instrumented: `
s.set('t', new Character());
s.get('t').forward(); // CP
s.get('t').forward();
s.get('t').turnRight();
s.get('t').forward(); // CP
s.get('t').forward(); // CP character at end: OK
s.get('t').forward();
s.get('t').forward();
`.trim(),
    js: `
const t = new Character(); // sid
t.forward(); // sid
t.forward(); // sid
t.turnRight(); // sid
t.forward(); // sid
t.forward(); // sid
t.forward(); // sid
t.forward(); // sid
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var t = new Character(); // sid
    t.forward(); // sid
    t.forward(); // sid
    t.turnRight(); // sid
    t.forward(); // sid
    t.forward(); // sid
    t.forward(); // sid
    t.forward(); // sid
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
  test2: defaultExplanation,
  test3: defaultExplanation,
  test4: defaultExplanation,
  testCheckpoints: defaultExplanation,
};
