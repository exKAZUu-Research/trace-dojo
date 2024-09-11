export const courseIds = ['tuBeginner1', 'tuBeginner2'] as const;
export type CourseId = (typeof courseIds)[number];

export const programIds = [
  'straight',
  'stepBack',
  'turnRight',
  'turnRightAndTurnLeft',
  'square',
  'rectangle',
  'diamond',
  'test1',
  'test2',
  'test3',
  'test4',
  'test5',
] as const;
export type ProgramId = (typeof programIds)[number];

export const languageIds = ['instrumented', 'java'] as const;
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
  stepBack: '線を描こう(2)',
  turnRight: '線を描こう(3)',
  turnRightAndTurnLeft: '線を描こう(4)',
  square: '図形を描こう(1)',
  rectangle: '図形を描こう(2)',
  diamond: '図形を描こう(3)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
};

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'stepBack', 'turnRight', 'turnRightAndTurnLeft'],
    ['square', 'rectangle', 'diamond'],
  ],
  tuBeginner2: [['test1', 'test2', 'test3', 'test4', 'test5']],
};

export function getExplanation(programId: ProgramId, languageId: VisibleLanguageId): Record<'title' | 'body', string> {
  return programIdToLanguageIdToExplanation[programId]?.[languageId];
}

const defaultProgram = {
  instrumented: '',
  java: '',
};

export const programIdToLanguageIdToProgram: Record<ProgramId, Record<LanguageId, string>> = {
  straight: {
    instrumented: `
	s.set('c', new Character());
	s.get('c').forward(); // CP
	s.get('c').forward();
	`.trim(),
    java: `
	public class Main {
		public static void main(String[] args) {
			Turtle 亀 = new Turtle(); // sid
			亀.前に進む(); // sid
			亀.前に進む(); // sid
		}
}
	`.trim(),
  },
  stepBack: {
    instrumented: `
	s.set('c', new Character());
	s.get('c').forward(); // CP
	s.get('c').backward();
	`.trim(),
    java: `
	public class Main {
		public static void main(String[] args) {
			Turtle 亀 = new Turtle(); // sid
			亀.前に進む(); // sid
			亀.後に戻る(); // sid
		}
}
	`.trim(),
  },

  turnRight: {
    instrumented: `
	s.set('c', new Character());
	s.get('c').forward();
	s.get('c').turnRight(); // CP
	s.get('c').forward();
	`.trim(),
    java: `
	public class Main {
		public static void main(String[] args) {
			Turtle 亀 = new Turtle(); // sid
			亀.前に進む(); // sid
			亀.右を向く(); // sid
			亀.前に進む(); // sid
		}
}
	`.trim(),
  },
  turnRightAndTurnLeft: {
    instrumented: `
	s.set('c', new Character());
	s.get('c').turnRight();
	s.get('c').forward();
	s.get('c').turnLeft(); // CP
	s.get('c').forward();
	`.trim(),
    java: `
	public class Main {
		public static void main(String[] args) {
			Turtle 亀 = new Turtle(); // sid
			亀.右を向く(); // sid
			亀.前に進む(); // sid
			亀.左を向く(); // sid
			亀.前に進む(); // sid
		}
}
	`.trim(),
  },
  diamond: defaultProgram,
  rectangle: defaultProgram,
  square: defaultProgram,
  test1: {
    instrumented: `
s.set('c', new Character());
s.get('c').forward();
s.get('c').forward(); // CP
s.get('c').forward();
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
  stepBack: defaultExplanation,
  turnRight: defaultExplanation,
  turnRightAndTurnLeft: defaultExplanation,
  diamond: defaultExplanation,
  rectangle: defaultExplanation,
  square: defaultExplanation,
  test1: defaultExplanation,
  test2: defaultExplanation,
  test3: defaultExplanation,
  test4: defaultExplanation,
  test5: defaultExplanation,
};
