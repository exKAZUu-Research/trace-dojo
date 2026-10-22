import type { ChallengeBase } from '../types';

export const lecture6: ChallengeBase[] = [
  {
    id: 'challengeI6ThresholdBreak',
    title: '合計が届いたら終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 0; // step
        for (int i = 1; i < 5; i++) { // step
            sum += i; // step
            if (sum >= 3) {
                break;
            }
        }
        Turtle t = new Turtle(sum, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('sum', 0);
for (s.set('i', 1); s.get('i') < 5; s.set('i', s.get('i') + 1)) {
 s.set('sum', s.get('sum') + (s.get('i')));
 if (s.get('sum') >= 3) {
  break;
 }
}
delete s.vars['i'];
const t = new Turtle(s.get('sum'), 1); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Condition4',
        before: `            if (sum >= 3) {`,
        after: `            if (sum @[>=]@ 3) {`,
      },
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = @[0]@; // step`,
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 5; i++) { // step`,
        after: `        for (int i = @[1]@; i < 5; i++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `            if (sum >= 3) {`,
        after: `            if (sum > 3) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 5; i++) { // step`,
        after: `        for (int i = 2; i < 5; i++) { // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6BreakBeforeAction',
    title: '進む前に終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        for (int i = 0; i < 4; i++) { // step
            if (i == 2) {
                break;
            }
            t.前に進む(); // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
 if (s.get('i') == 2) {
  break;
 }
 t.forward();
}
delete s.vars['i'];
t.turnRight();
t.forward();
t.turnLeft();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            if (i == 2) {`,
        after: `            if (i @[==]@ 2) {`,
      },
      {
        id: 'Action6',
        before: `            t.前に進む(); // step`,
        after: `            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i > 4; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            if (i == 2) {`,
        after: `            if (i != 2) {`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `            t.前に進む(); // step`,
        after: `            t.右を向く(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6BreakAfterAction',
    title: '進んだ後に終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        for (int i = 0; i < 4; i++) { // step
            t.前に進む(); // step
            if (i == 1) {
                break;
            }
        }
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
 t.forward();
 if (s.get('i') == 1) {
  break;
 }
}
delete s.vars['i'];
t.backward();
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (i == 1) {`,
        after: `            if (i @[==]@ 1) {`,
      },
      {
        id: 'Action3',
        before: `            t.前に進む(); // step`,
        after: `            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i > 4; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (i == 1) {`,
        after: `            if (i != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `            t.前に進む(); // step`,
        after: `            t.右を向く(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6InnerBreak',
    title: '内側だけを抜ける',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = 0; j < 3; j++) { // step
                t.前に進む(); // step
                if (j == i) {
                    break;
                }
            }
            t.右を向く(); // step
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
 for (s.set('j', 0); s.get('j') < 3; s.set('j', s.get('j') + 1)) {
  t.forward();
  if (s.get('j') == s.get('i')) {
   break;
  }
 }
delete s.vars['j'];
 t.turnRight();
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 3; j++) { // step`,
        after: `            for (int j = 0; j @[<]@ 3; j++) { // step`,
      },
      {
        id: 'Condition5',
        before: `                if (j == i) {`,
        after: `                if (j @[==]@ i) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i <= 2; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 3; j++) { // step`,
        after: `            for (int j = 0; j > 3; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition5',
        before: `                if (j == i) {`,
        after: `                if (j != i) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6SkippedSum',
    title: '加えない回',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 0; // step
        for (int i = 1; i < 4; i++) { // step
            if (i == 2) {
                continue;
            }
            sum += i; // step
        }
        Turtle t = new Turtle(sum, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('sum', 0);
for (s.set('i', 1); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
 if (s.get('i') == 2) {
  continue;
 }
 s.set('sum', s.get('sum') + (s.get('i')));
}
delete s.vars['i'];
const t = new Turtle(s.get('sum'), 1); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Condition3',
        before: `            if (i == 2) {`,
        after: `            if (i @[==]@ 2) {`,
      },
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = @[0]@; // step`,
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = @[1]@; i < 4; i++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `            if (i == 2) {`,
        after: `            if (i != 2) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = 2; i < 4; i++) { // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6ProgressBeforeContinue',
    title: '先に減らして次へ',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        int remaining = 3; // step
        while (remaining > 0) {
            remaining--; // step
            if (remaining == 1) {
                continue;
            }
            t.前に進む(); // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
s.set('remaining', 3);
while (s.get('remaining') > 0) {
 s.set('remaining', s.get('remaining') - 1);
 if (s.get('remaining') == 1) {
  continue;
 }
 t.forward();
}
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (remaining > 0) {`,
        after: `        while (remaining @[>]@ 0) {`,
      },
      {
        id: 'Condition5',
        before: `            if (remaining == 1) {`,
        after: `            if (remaining @[==]@ 1) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = 3; // step`,
        after: `        int remaining = @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (remaining > 0) {`,
        after: `        while (remaining >= 0) {`,
        kind: 'logical',
      },
      {
        id: 'Condition5',
        before: `            if (remaining == 1) {`,
        after: `            if (remaining != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int remaining = 3; // step`,
        after: `        int remaining = 4; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6SkipThenStop',
    title: '飛ばしてから止める',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        for (int i = 0; i < 5; i++) { // step
            if (i == 1) {
                continue;
            }
            if (i == 3) {
                break;
            }
            t.前に進む(); // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 5; s.set('i', s.get('i') + 1)) {
 if (s.get('i') == 1) {
  continue;
 }
 if (s.get('i') == 3) {
  break;
 }
 t.forward();
}
delete s.vars['i'];
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 5; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            if (i == 1) {`,
        after: `            if (i @[==]@ 1) {`,
      },
      {
        id: 'Condition6',
        before: `            if (i == 3) {`,
        after: `            if (i @[==]@ 3) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i++) { // step`,
        after: `        for (int i = 0; i > 5; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            if (i == 1) {`,
        after: `            if (i != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Condition6',
        before: `            if (i == 3) {`,
        after: `            if (i != 3) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6GuardedExit',
    title: '壁で向きを変えて終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 4); // step
        for (int i = 0; i < 4; i++) { // step
            if (!t.前に進めるか()) {
                t.右を向く(); // step
                break;
            }
            t.前に進む(); // step
        }
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 4); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
 if (!t.canMoveForward()) {
  t.turnRight();
  break;
 }
 t.forward();
}
delete s.vars['i'];
t.forward();
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Action4',
        before: `                t.右を向く(); // step`,
        after: `                t.@[右を向く]@(); // step`,
      },
      {
        id: 'Action7',
        before: `            t.前に進む(); // step`,
        after: `            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i > 4; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.右を向く(); // step`,
        after: `                t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `            t.前に進む(); // step`,
        after: `            t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6InnerContinue',
    title: '内側の一回を飛ばす',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = 0; j < 2; j++) { // step
                if (j == i) {
                    continue;
                }
                t.前に進む(); // step
            }
            t.右を向く(); // step
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
 for (s.set('j', 0); s.get('j') < 2; s.set('j', s.get('j') + 1)) {
  if (s.get('j') == s.get('i')) {
   continue;
  }
  t.forward();
 }
delete s.vars['j'];
 t.turnRight();
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 2; j++) { // step`,
        after: `            for (int j = 0; j @[<]@ 2; j++) { // step`,
      },
      {
        id: 'Action7',
        before: `                t.前に進む(); // step`,
        after: `                t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i <= 2; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 2; j++) { // step`,
        after: `            for (int j = 0; j <= 2; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `                t.前に進む(); // step`,
        after: `                t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI6SwitchAndLoopExit',
    title: '二つのbreak',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 4; i++) { // step
            switch (i) {
                case 0:
                    t.右を向く(); // step
                    break;
                default:
                    t.前に進む(); // step
                    break;
            }
            if (i == 2) {
                break;
            }
            t.左を向く(); // step
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
 switch (s.get('i')) {
  case 0:
   t.turnRight();
   break;
  default:
   t.forward();
   break;
 }
 if (s.get('i') == 2) {
  break;
 }
 t.turnLeft();
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Condition11',
        before: `            if (i == 2) {`,
        after: `            if (i @[==]@ 2) {`,
      },
      {
        id: 'Action5',
        before: `                    t.右を向く(); // step`,
        after: `                    t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) { // step`,
        after: `        for (int i = 0; i > 4; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition11',
        before: `            if (i == 2) {`,
        after: `            if (i != 2) {`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `                    t.右を向く(); // step`,
        after: `                    t.前に進む(); // step`,
        kind: 'logical',
      },
    ],
  },
];
