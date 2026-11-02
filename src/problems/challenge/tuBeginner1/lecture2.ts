import type { ChallengeBase } from '../types';

export const lecture2: ChallengeBase[] = [
  {
    id: 'challengeI2SnapshotCoordinates',
    title: '写してから変える座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('x', 1);
s.set('y', s.get('x'));
s.set('x', s.get('x') + (2));
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();
t.backward();
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += @[2]@; // step`,
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2CoordinateExchange',
    title: '座標を入れ替える',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('x', 1);
s.set('y', 3);
s.set('saved', s.get('x'));
s.set('x', s.get('y'));
s.set('y', s.get('saved'));
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();
t.forward();`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = @[3]@; // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2OverwrittenCandidate',
    title: '残された候補',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int candidate = 2; // step
        int saved = candidate + 1; // step
        candidate *= 2; // step
        candidate = saved - 2; // step
        Turtle t = new Turtle(candidate, saved); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    instrumented: `s.set('candidate', 2);
s.set('saved', s.get('candidate') + 1);
s.set('candidate', s.get('candidate') * (2));
s.set('candidate', s.get('saved') - 2);
const t = new Turtle(s.get('candidate'), s.get('saved')); registerDisplayRef('t', () => t); // step
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.backward();`,
    blanks: [
      {
        id: 'Update4',
        before: `        candidate = saved - 2; // step`,
        after: `        candidate = saved @[-]@ 2; // step`,
      },
      {
        id: 'Value1',
        before: `        int candidate = 2; // step`,
        after: `        int candidate = @[2]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int saved = candidate + 1; // step`,
        after: `        int saved = candidate + @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update4',
        before: `        candidate = saved - 2; // step`,
        after: `        candidate = saved + 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int candidate = 2; // step`,
        after: `        int candidate = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int saved = candidate + 1; // step`,
        after: `        int saved = candidate + 2; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2RemainderSplit',
    title: '商と余りの座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int total = 11; // step
        int x = total / 3; // step
        int y = total % 3; // step
        total -= x; // step
        Turtle t = new Turtle(x, y); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('total', 11);
s.set('x', Math.trunc(s.get('total') / 3));
s.set('y', s.get('total') % 3);
s.set('total', s.get('total') - (s.get('x')));
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.turnLeft();
t.forward();
t.turnRight();
t.forward();
t.forward();`,
    blanks: [
      {
        id: 'Value1',
        before: `        int total = 11; // step`,
        after: `        int total = @[11]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int x = total / 3; // step`,
        after: `        int x = total / @[3]@; // step`,
      },
      {
        id: 'Value3',
        before: `        int y = total % 3; // step`,
        after: `        int y = total % @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int total = 11; // step`,
        after: `        int total = 12; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = total / 3; // step`,
        after: `        int x = total / 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int y = total % 3; // step`,
        after: `        int y = total % 4; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2ConstructionSnapshot',
    title: '作った後の座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('x', 2);
s.set('y', 1);
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
s.set('x', s.get('x') + (2));
s.set('y', s.get('x'));
t.forward();
t.turnRight();
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 2; // step`,
        after: `        int x = @[2]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 1; // step`,
        after: `        int y = @[1]@; // step`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 2; // step`,
        after: `        int x = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 1; // step`,
        after: `        int y = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2DependencyDiamond',
    title: '合流する計算',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int base = 2; // step
        int left = base + 1; // step
        int right = base * 2; // step
        int x = right - left; // step
        int y = right / base; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    instrumented: `s.set('base', 2);
s.set('left', s.get('base') + 1);
s.set('right', s.get('base') * 2);
s.set('x', s.get('right') - s.get('left'));
s.set('y', Math.trunc(s.get('right') / s.get('base')));
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.forward();
t.backward();`,
    blanks: [
      {
        id: 'Update2',
        before: `        int left = base + 1; // step`,
        after: `        int left = base @[+]@ 1; // step`,
      },
      {
        id: 'Value1',
        before: `        int base = 2; // step`,
        after: `        int base = @[2]@; // step`,
      },
      {
        id: 'Value3',
        before: `        int right = base * 2; // step`,
        after: `        int right = base * @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update2',
        before: `        int left = base + 1; // step`,
        after: `        int left = base - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int base = 2; // step`,
        after: `        int base = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int right = base * 2; // step`,
        after: `        int right = base * 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2SequentialAssignment',
    title: '順に代入する座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        x = y - 1; // step
        y = x + 1; // step
        Turtle t = new Turtle(x, y); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
    }
}`,
    instrumented: `s.set('x', 1);
s.set('y', 3);
s.set('x', s.get('y') - 1);
s.set('y', s.get('x') + 1);
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.turnLeft();`,
    blanks: [
      {
        id: 'Update3',
        before: `        x = y - 1; // step`,
        after: `        x = y @[-]@ 1; // step`,
      },
      {
        id: 'Update4',
        before: `        y = x + 1; // step`,
        after: `        y = x @[+]@ 1; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        x = y - 1; // step`,
        after: `        x = y + 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Update4',
        before: `        y = x + 1; // step`,
        after: `        y = x - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = 4; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2DivisionTiming',
    title: '割る順番',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int n = 5; // step
        int x = n / 2; // step
        x += 1; // step
        int y = (n + 1) / 2; // step
        Turtle t = new Turtle(x, y); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    instrumented: `s.set('n', 5);
s.set('x', Math.trunc(s.get('n') / 2));
s.set('x', s.get('x') + (1));
s.set('y', Math.trunc((s.get('n') + 1) / 2));
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.turnLeft();
t.forward();
t.turnRight();
t.forward();
t.backward();`,
    blanks: [
      {
        id: 'Update3',
        before: `        x += 1; // step`,
        after: `        x @[+=]@ 1; // step`,
      },
      {
        id: 'Update4',
        before: `        int y = (n + 1) / 2; // step`,
        after: `        int y = (n @[+]@ 1) / 2; // step`,
      },
      {
        id: 'Value1',
        before: `        int n = 5; // step`,
        after: `        int n = @[5]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        x += 1; // step`,
        after: `        x -= 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Update4',
        before: `        int y = (n + 1) / 2; // step`,
        after: `        int y = (n - 1) / 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int n = 5; // step`,
        after: `        int n = 6; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2CompoundDependency',
    title: '更新した値を使う',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 6; // step
        x += 2; // step
        y -= x; // step
        x--; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('x', 1);
s.set('y', 6);
s.set('x', s.get('x') + (2));
s.set('y', s.get('y') - (s.get('x')));
s.set('x', s.get('x') - 1);
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.forward();
t.forward();`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 6; // step`,
        after: `        int y = @[6]@; // step`,
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 6; // step`,
        after: `        int y = 7; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2RetainedHistory',
    title: '戻した値と保存した値',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int value = 1; // step
        value += 3; // step
        int saved = value; // step
        value -= 3; // step
        Turtle t = new Turtle(value, saved); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('value', 1);
s.set('value', s.get('value') + (3));
s.set('saved', s.get('value'));
s.set('value', s.get('value') - (3));
const t = new Turtle(s.get('value'), s.get('saved')); registerDisplayRef('t', () => t); // step
t.turnRight();
t.forward();
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Value1',
        before: `        int value = 1; // step`,
        after: `        int value = @[1]@; // step`,
      },
      {
        id: 'Value2',
        before: `        value += 3; // step`,
        after: `        value += @[3]@; // step`,
      },
      {
        id: 'Value4',
        before: `        value -= 3; // step`,
        after: `        value -= @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int value = 1; // step`,
        after: `        int value = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        value += 3; // step`,
        after: `        value += 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        value -= 3; // step`,
        after: `        value -= 4; // step`,
        kind: 'logical',
      },
    ],
  },
];
