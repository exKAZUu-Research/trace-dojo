export const courseIds = ['tuBeginner1', 'tuBeginner2'] as const;
export type CourseId = (typeof courseIds)[number];

export const programIds = [
  'straight',
  'stepBack',
  'turnRight',
  'turnRightAndTurnLeft',
  'square1',
  'square2',
  'variable',
  'variable2',
  'variable3',
  'while1',
  'while2',
  'for1',
  'for2',
  'for3',
  'doubleLoop1',
  'doubleLoop2',
  'if1',
  'if2',
  'elseIf1',
  'elseIf2',
  'switch1',
  'switch2',
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
  square1: '図形を描こう(1)',
  square2: '図形を描こう(2)',
  variable: '変数を使おう(1)',
  variable2: '変数を使おう(2)',
  variable3: '変数を使おう(3)',
  while1: 'while文を使おう(1)',
  while2: 'while文を使おう(2)',
  for1: 'for文を使おう(1)',
  for2: 'for文を使おう(2)',
  for3: 'for文を使おう(3)',
  doubleLoop1: '二重ループ(1)',
  doubleLoop2: '二重ループ(2)',
  if1: 'if文を使おう(1)',
  if2: 'if文を使おう(2)',
  elseIf1: 'else if文を使おう(1)',
  elseIf2: 'else if文を使おう(2)',
  switch1: 'switch文を使おう(1)',
  switch2: 'switch文を使おう(2)',
  test1: 'ステップ実行のテスト用問題(1)',
  test2: 'ステップ実行のテスト用問題(2)',
  test3: 'ステップ実行のテスト用問題(3)',
  test4: 'ステップ実行のテスト用問題(4)',
  test5: 'チェックポイント取得のテスト用問題',
};

export const courseIdToProgramIdLists: Record<CourseId, ProgramId[][]> = {
  tuBeginner1: [
    ['straight', 'stepBack', 'turnRight', 'turnRightAndTurnLeft'],
    ['square1', 'square2', 'variable', 'variable2', 'variable3'],
    ['while1', 'while2', 'for1', 'for2', 'for3'],
    ['doubleLoop1', 'doubleLoop2', 'if1', 'if2'],
    ['elseIf1', 'elseIf2', 'switch1', 'switch2'],
  ],
  tuBeginner2: [['test1', 'test2', 'test3', 'test4', 'test5']],
};

export function getExplanation(programId: ProgramId, languageId: VisibleLanguageId): Record<'title' | 'body', string> {
  return programIdToLanguageIdToExplanation[programId]?.[languageId];
}

// const defaultProgram = {
//   instrumented: '',
//   java: '',
// };

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
  square1: {
    instrumented: `
	s.set('c', new Character());
	s.get('c').forward();
	s.get('c').turnRight();
	s.get('c').forward(); // CP
	s.get('c').turnRight();
	s.get('c').forward();
`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle 亀 = new Turtle(); // sid
		亀.前に進む(); // sid
		亀.右を向く(); // sid
		亀.前に進む(); // sid
		亀.右を向く(); // sid
		亀.前に進む(); // sid
	}
}
	`.trim(),
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
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle 亀 = new Turtle(<1-5>, <1-4>); // sid
		亀.前に進む(); // sid
		亀.右を向く(); // sid
		亀.前に進む(); // sid
		亀.右を向く(); // sid
		亀.前に進む(); // sid
	}
}
	`.trim(),
  },
  variable: {
    instrumented: `
	s.set('x', <1-5>);
	s.set('c', new Character(s.get('x'), <1-5>)); // CP
	s.get('c').forward();
 `.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		int x = <1-5>; // sid
		Turtle 亀 = new Turtle(x, <1-5>); // sid
		亀.前に進む(); // sid
	}
}
	`.trim(),
  },
  variable2: {
    instrumented: `
	s.set('x', <1-5>);
	s.set('x', s.get('x') + 1);
	s.set('y', s.get('x') + 1);
	s.set('c', new Character(s.get('x'), s.get('y'))); // CP
	s.get('c').forward();
`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		int x = <1-5>; // sid
		x = x + 1; // sid
		int y = x + 1; // sid
		Turtle 亀 = new Turtle(x, y); // sid
		亀.前に進む(); // sid
	}
}
	`.trim(),
  },
  variable3: {
    instrumented: `
	s.set('x', <1-5>);
	s.set('x', s.get('x') - 1);
	s.set('y', s.get('x') * 2);
	s.set('y', Math.floor(s.get('y') / 3));
	s.set('c', new Character(s.get('x'), s.get('y'))); // CP
	s.get('c').forward();
`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		int x = <1-5>; // sid
		x--; // sid
		int y = x * 2; // sid
		y /= 3; // sid
		Turtle 亀 = new Turtle(x, y); // sid
		亀.前に進む(); // sid
	}
}
	`.trim(),
  },
  while1: {
    instrumented: `
	s.set('c', new Character());
	s.set('i', 0);
	while (s.get('i') < <3-5>) {
	  s.get('c').forward(); // CP
	  s.set('i', s.get('i') + 1);
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle 亀 = new Turtle(); // sid
		int i = 0; // sid
		while (i < <3-5>) {
			亀.前に進む(); // sid
			i++; // sid
		}
	}
}
	`.trim(),
  },
  while2: {
    instrumented: `
	s.set('c', new Character());
	s.set('i', 0);
	while (s.get('i') < <2-3>) {
	  s.set('i', s.get('i') + 1);
	  s.get('c').forward(); // CP
	  s.get('c').turnRight(); 
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle 亀 = new Turtle(); // sid
		int i = 0; // sid
		while (i < 2) {
			i++; // sid
			亀.前に進む(); // sid
			亀.右を向く(); // sid
		}
	}
}
	`.trim(),
  },
  for1: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <3-5>; s.set('i', s.get('i') + 1)) {
	  s.get('c').forward(); // CP
   	}
   	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle 亀 = new Turtle(); // sid
		for (int i = 0; i < <3-5>; i++) { // sid
			亀.前に進む(); // sid
		}
	}
}
	`.trim(),
  },
  for2: {
    instrumented: `
	s.set('c', new Character());
	s.set('i', 0);
	for (s.set('i', s.get('i')) ; s.get('i') < <2-3>; s.set('i', s.get('i'))) {
	  s.get('c').forward(); // CP
	  s.get('c').turnRight();
	  s.set('i', s.get('i') + 1);
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle 亀 = new Turtle(); // sid
		int i = 0; // sid
		for (; i < <2-3>;) { // sid
			亀.前に進む(); // sid
			亀.右を向く(); // sid
		i++; // sid
		}
	}
}
	`.trim(),
  },
  for3: {
    instrumented: `
	s.set('x', 0);
	for (s.set('i', 2); s.get('i') <= <4-5>; s.set('i', s.get('i') + 1)) {
	  s.set('x', s.get('x') + s.get('i'));
	}
	s.set('x', Math.floor(s.get('x') / 3));
	s.set('c', new Character(s.get('x'), 0)); // CP
	s.get('c').forward();
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		int x = 0; // sid
		for (int i = 2; i <= <4-5>; i++) { // sid
			x += i; // sid
		}
		x /= 3; // sid
		Turtle 亀 = new Turtle(x, 0); // sid
		亀.前に進む(); // sid
	}
}
	`.trim(),
  },
  doubleLoop1: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {
	  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {
	  	s.get('c').forward(); // CP
	  }
	  s.get('c').turnRight();
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < <2-3>; i++) { // sid
			for (int j = 0; j < <2-3>; j++) { // sid
				t.前に進む(); // sid
			}
			t.右を向く(); // sid
		}
	}
}
	`.trim(),
  },
  doubleLoop2: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', <3-4>); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
	  for (s.set('j', 0); s.get('j') < s.get('i'); s.set('j', s.get('j') + 1)) {
	  	s.get('c').forward(); // CP
	  }
	  s.get('c').turnRight();
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = <3-4>; i > 0; i--) { // sid
			for (int j = 0; j < i; j++) { // sid
				t.前に進む(); // sid
			}
			t.右を向く(); // sid
		}
	}
}
	`.trim(),
  },
  if1: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <7-9>; s.set('i', s.get('i') + 1)) {
		s.get('c').forward();
		if (s.get('i') % 3 === 2) {
			s.get('c').turnRight(); // CP
		}
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < <7-9>; i++) { // sid
			t.前に進む(); // sid
			if (i % 3 == 2) {
				t.右を向く(); // sid
			}
		}
	}
}
	`.trim(),
  },
  if2: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
		s.get('c').forward();
		if (s.get('i') % 2 === 0) {
			s.get('c').turnRight(); // CP
		} else {
			s.get('c').turnLeft(); // CP
		}
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < 4; i++) { // sid
			t.前に進む(); // sid
			if (i % 2 == 0) {
				t.右を向く(); // sid
			} else {
				t.左を向く(); // sid
			}
		}
	}
}
	`.trim(),
  },
  elseIf1: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <4-6>; s.set('i', s.get('i') + 1)) {
		if (s.get('i') < <2-3>) {
			s.get('c').forward();
		} else if (s.get('i') === <2-3>) {
			s.get('c').turnLeft(); // CP
		} else {
			s.get('c').backward(); // CP
		}
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < <4-6>, i++) { // sid
			if (i < <2-3>)			t.前に進む(); // sid
			else if (i == <2-3>)	t.左を向く(); // sid
			else 					t.後に戻る(); // sid
		}
	}
}
	`.trim(),
  },
  elseIf2: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
		if (s.get('i') % 4 === 0) {
			s.get('c').forward();
		} else if (s.get('i') % 4 === 1) {
			s.get('c').turnRight(); // CP
		} else if (s.get('i') % 4 === 2) {
			s.get('c').forward(); // CP
		} else {
			s.get('c').turnLeft(); // CP
		}
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < <5-7>, i++) { // sid
			if (i % 4 == 0)			t.前に進む(); // sid
			else if (i % 4 == 1)	t.右を向く(); // sid
			else if (i % 4 == 2)	t.前に進む(); // sid
			else						t.左を向く(); // sid
		}
	}
}
	`.trim(),
  },
  switch1: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
		switch (s.get('i')) {
			case 0: case 1:
				s.get('c').forward(); break;
			case 2:		s.get('c').turnLeft(); break; // CP
			default:	s.get('c').backward(); break; // CP
		}
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < <5-7>; i++) { // sid
			switch (i) {
				case 0: case 1:
					t.前に進む(); break; // sid
				case 2:		t.左を向く(); break; // sid
				default:	t.後に戻る(); break; // sid
			}
		}
	}
	`.trim(),
  },
  switch2: {
    instrumented: `
	s.set('c', new Character());
	for (s.set('i', 0); s.get('i') < <5-7>; s.set('i', s.get('i') + 1)) {
		switch (s.get('i') % 4) {
			case 1:	s.get('c').turnRight(); break; // CP
			case 3:		s.get('c').turnLeft(); break; // CP
			default:	s.get('c').forward(); break; // CP
		}
	}
	`.trim(),
    java: `
public class Main {
	public static void main(String[] args) {
		Turtle t = new Turtle(); // sid
		for (int i = 0; i < <5-7>; i++) { // sid
			switch (i % 4) {
				case 1:		t.右を向く(); break; // sid
				case 3:		t.左を向く(); break; // sid
				default:		t.前に進む(); break; // sid
			}
		}
	}
}
	`.trim(),
  },
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
  square1: defaultExplanation,
  square2: defaultExplanation,
  variable: defaultExplanation,
  variable2: defaultExplanation,
  variable3: defaultExplanation,
  while1: defaultExplanation,
  while2: defaultExplanation,
  for1: defaultExplanation,
  for2: defaultExplanation,
  for3: defaultExplanation,
  doubleLoop1: defaultExplanation,
  doubleLoop2: defaultExplanation,
  if1: defaultExplanation,
  if2: defaultExplanation,
  elseIf1: defaultExplanation,
  elseIf2: defaultExplanation,
  switch1: defaultExplanation,
  switch2: defaultExplanation,
  test1: defaultExplanation,
  test2: defaultExplanation,
  test3: defaultExplanation,
  test4: defaultExplanation,
  test5: defaultExplanation,
};
