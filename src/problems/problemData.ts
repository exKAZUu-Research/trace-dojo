export const courseIds = ['tuBeginner1', 'tuBeginner2'] as const;
export type CourseId = (typeof courseIds)[number];

export const programIds = [
  'straight',
  'curve',
  'stairs',
  'square',
  'square2',
  'variable',
  'variable2',
  'test1',
  'test2',
  'test3',
  'test4',
  'test5',
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
  square2: '図形を描こう(2)',
  variable: '変数を使おう(1)',
  variable2: '変数を使おう(2)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
};

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'curve', 'stairs'],
    ['square', 'square2', 'variable', 'variable2'],
  ],
  tuBeginner2: [['test1', 'test2', 'test3', 'test4', 'test5']],
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
  square: {
    instrumented: `
s.set('c', new Character());
s.get('c').forward();
s.get('c').turnRight();
s.get('c').forward(); // CP
s.get('c').turnRight();
s.get('c').forward();
`.trim(),
    js: `
const c = new Character(); // sid
c.forward(); // sid
c.turnRight(); // sid
c.forward(); // sid
c.turnRight(); // sid
c.forward(); // sid
`.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
	Character c = new Character(); // sid
	c.forward(); // sid
	c.turnRight(); // sid
	c.forward(); // sid
	c.turnRight(); // sid
	c.forward(); // sid
  }
}`.trim(),
  },
  square2: {
    instrumented: `
s.set('c', new Character(<1-5>, <1-4>));
s.get('c').forward();
s.get('c').turnRight();
s.get('c').forward(); // CP
s.get('c').turnRight();
s.get('c').forward();
`.trim(),
    js: `
const c = new Character(<1-5>, <1-4>); // sid
c.forward(); // sid
c.turnRight(); // sid
c.forward(); // sid
c.turnRight(); // sid
c.forward(); // sid
`.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
	Character c = new Character(<1-5>, <1-4>); // sid
	c.forward(); // sid
	c.turnRight(); // sid
	c.forward(); // sid
	c.turnRight(); // sid
	c.forward(); // sid
  }
}`.trim(),
  },
  variable: {
    instrumented: `
 s.set('x', <1-5>);
 s.set('c', new Character(s.get('x'), <1-5>)); // CP
s.get('c').forward();
 `.trim(),
    js: `
 let x = <1-5>;
 const c = new Character(x, <1-5>); // sid
 c.forward(); // sid
 `.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
	int x = <1-5>;
	Character c = new Character(x, <1-5>); // sid
	c.forward(); // sid
  }
}`.trim(),
  },
  variable2: {
    instrumented: `
s.set('x', <1-5>);
s.set('x', s.get('x') - 1);
s.set('y', s.get('x') * 2);
s.set('y', Math.floor(s.get('y') / 3));
s.set('c', new Character(s.get('x'), s.get('y')));
s.get('c').forward();
`.trim(),
    js: `
let x = <1-5>; // sid
x -= 1; // sid
let y = x * 2; // sid
y = y / 3; // sid
const c = new Character(x, y); // sid
c.forward(); // sid
`.trim(),
    java: `
import net.exkazuu.Character;

public class Main {
  public static void main(String[] args) {
	int x = <1-5>; // sid
	x--; // sid
	int y = x * 2; // sid
	y = y / 3; // sid
	Character c = new Character(x, y); // sid
	c.forward(); // sid
  }
}`.trim(),
  },
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
s.get('c1').penUp();
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
const c1 = new Character(); // sid
c1.forward(); // sid
c1.turnLeft(); // sid
c1.penUp(); // sid
let i = 0; // sid
c1.forward(); // sid

const c2 = new Character({x: <2-5>, y: <3-5>, color: 'green'}); // sid
c2.forward(); // sid
const foo = 'あいうえお'; // sid
let bar = <1-100>; // sid
i = bar + 1; // sid
c2.forward(); // sid
c2.forward(); // sid
`.trim(),
    java: `
public class Main {
  public static void main(String[] args) {
    Character c1 = new Character(); // sid
    c1.forward(); // sid
    c1.turnLeft(); // sid
    c1.penUp(); // sid
    int i = 0; // sid
    c1.forward(); // sid

    Character c2 = new Character(<2-5>, <3-5>, "green"); // sid
    c2.forward(); // sid
    String foo = "あいうえお"; // sid
    int bar = <1-100>; // sid
    i = bar + 1; // sid
    c2.forward(); // sid
    c2.forward(); // sid
  }
}
`.trim(),
  },
  test5: {
    instrumented: `
s.set('c', new Character());
s.get('c').forward(); // CP
s.get('c').forward();
s.get('c').turnRight();
s.get('c').forward(); // CP
s.get('c').forward(); // CP character at end: OK
s.get('c').forward();
s.get('c').forward();
`.trim(),
    js: `
const c = new Character(); // sid
c.forward(); // sid
c.forward(); // sid
c.turnRight(); // sid
c.forward(); // sid
c.forward(); // sid
c.forward(); // sid
c.forward(); // sid
`.trim(),
    java: `
public class Straight {
  public static void main(String[] args) {
    var c = new Character(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.turnRight(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
    c.forward(); // sid
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
  square: defaultExplanation,
  square2: defaultExplanation,
  variable: defaultExplanation,
  variable2: defaultExplanation,
  stairs: defaultExplanation,
  test1: defaultExplanation,
  test2: defaultExplanation,
  test3: defaultExplanation,
  test4: defaultExplanation,
  test5: defaultExplanation,
};
