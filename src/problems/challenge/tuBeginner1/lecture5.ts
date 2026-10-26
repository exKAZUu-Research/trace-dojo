import type { ChallengeBase } from '../types';

export const lecture5: ChallengeBase[] = [
  {
    id: 'challengeI5OverlappingRanges',
    title: '重なる条件',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int n = 1; n < 4; n++) { // step
            if (n < 3) {
                t.前に進む(); // step
            } else if (n < 4) {
                t.右を向く(); // step
            } else {
                t.後に戻る(); // step
            }
        }
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('n', 1); s.get('n') < 4; s.set('n', s.get('n') + 1)) {
 if (s.get('n') < 3) {
  t.forward();
 } else if (s.get('n') < 4) {
  t.turnRight();
 } else {
  t.backward();
 }
}
delete s.vars['n'];
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) { // step`,
        after: `        for (int n = 1; n @[<]@ 4; n++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            if (n < 3) {`,
        after: `            if (n @[<]@ 3) {`,
      },
      {
        id: 'Condition5',
        before: `            } else if (n < 4) {`,
        after: `            } else if (n @[<]@ 4) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) { // step`,
        after: `        for (int n = 1; n <= 4; n++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            if (n < 3) {`,
        after: `            if (n <= 3) {`,
        kind: 'logical',
      },
      {
        id: 'Condition5',
        before: `            } else if (n < 4) {`,
        after: `            } else if (n > 4) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5DescendingCategories',
    title: '減りながら分岐',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int n = 3; n > 0; n--) { // step
            if (n > 2) {
                t.前に進む(); // step
                t.右を向く(); // step
            } else if (n == 2) {
                t.前に進む(); // step
            } else {
                t.左を向く(); // step
                t.前に進む(); // step
            }
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('n', 3); s.get('n') > 0; s.set('n', s.get('n') - 1)) {
 if (s.get('n') > 2) {
  t.forward();
  t.turnRight();
 } else if (s.get('n') == 2) {
  t.forward();
 } else {
  t.turnLeft();
  t.forward();
 }
}
delete s.vars['n'];`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 3; n > 0; n--) { // step`,
        after: `        for (int n = 3; n @[>]@ 0; n--) { // step`,
      },
      {
        id: 'Condition3',
        before: `            if (n > 2) {`,
        after: `            if (n @[>]@ 2) {`,
      },
      {
        id: 'Condition6',
        before: `            } else if (n == 2) {`,
        after: `            } else if (n @[==]@ 2) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int n = 3; n > 0; n--) { // step`,
        after: `        for (int n = 3; n >= 0; n--) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            if (n > 2) {`,
        after: `            if (n >= 2) {`,
        kind: 'logical',
      },
      {
        id: 'Condition6',
        before: `            } else if (n == 2) {`,
        after: `            } else if (n != 2) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5ComputedSelector',
    title: '計算した番号で選ぶ',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int total = 0; // step
        for (int i = 1; i < 4; i++) { // step
            total += i; // step
            switch (total % 3) {
                case 0:
                    t.前に進む(); // step
                    break;
                default:
                    t.右を向く(); // step
                    break;
            }
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('total', 0);
for (s.set('i', 1); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
 s.set('total', s.get('total') + (s.get('i')));
 switch (s.get('total') % 3) {
  case 0:
   t.forward();
   break;
  default:
   t.turnRight();
   break;
 }
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = 1; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = @[0]@; // step`,
      },
      {
        id: 'Value5',
        before: `            switch (total % 3) {`,
        after: `            switch (total % @[3]@) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = 1; i <= 4; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value5',
        before: `            switch (total % 3) {`,
        after: `            switch (total % 4) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5GroupedState',
    title: 'まとめられた番号',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 0; // step
        for (int n = 1; n < 4; n++) { // step
            switch (n) {
                case 1:
                case 3:
                    x++; // step
                    break;
                default:
                    x += 2; // step
                    break;
            }
        }
        Turtle t = new Turtle(x, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('x', 0);
for (s.set('n', 1); s.get('n') < 4; s.set('n', s.get('n') + 1)) {
 switch (s.get('n')) {
  case 1:
  case 3:
   s.set('x', s.get('x') + 1);
   break;
  default:
   s.set('x', s.get('x') + (2));
   break;
 }
}
delete s.vars['n'];
const t = new Turtle(s.get('x'), 1); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) { // step`,
        after: `        for (int n = 1; n @[<]@ 4; n++) { // step`,
      },
      {
        id: 'Value1',
        before: `        int x = 0; // step`,
        after: `        int x = @[0]@; // step`,
      },
      {
        id: 'Value9',
        before: `                    x += 2; // step`,
        after: `                    x += @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) { // step`,
        after: `        for (int n = 1; n <= 4; n++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int x = 0; // step`,
        after: `        int x = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value9',
        before: `                    x += 2; // step`,
        after: `                    x += 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5DefaultTransition',
    title: '既定から次の状態へ',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int state = 4; // step
        for (int i = 0; i < 2; i++) { // step
            switch (state) {
                case 1:
                    t.前に進む(); // step
                    break;
                default:
                    state = 1; // step
                    t.右を向く(); // step
                    break;
            }
        }
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('state', 4);
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
 switch (s.get('state')) {
  case 1:
   t.forward();
   break;
  default:
   s.set('state', 1);
   t.turnRight();
   break;
 }
}
delete s.vars['i'];
t.forward();`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Value9',
        before: `                    state = 1; // step`,
        after: `                    state = @[1]@; // step`,
      },
      {
        id: 'Value5',
        before: `                case 1:`,
        after: `                case @[1]@:`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i <= 2; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value9',
        before: `                    state = 1; // step`,
        after: `                    state = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value5',
        before: `                case 1:`,
        after: `                case 2:`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5CaseSequence',
    title: '一つのケースの二命令',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int n = 0; n < 2; n++) { // step
            switch (n) {
                case 0:
                    t.前に進む(); // step
                    t.左を向く(); // step
                    break;
                default:
                    t.後に戻る(); // step
                    t.右を向く(); // step
                    break;
            }
        }
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('n', 0); s.get('n') < 2; s.set('n', s.get('n') + 1)) {
 switch (s.get('n')) {
  case 0:
   t.forward();
   t.turnLeft();
   break;
  default:
   t.backward();
   t.turnRight();
   break;
 }
}
delete s.vars['n'];
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 0; n < 2; n++) { // step`,
        after: `        for (int n = 0; n @[<]@ 2; n++) { // step`,
      },
      {
        id: 'Value4',
        before: `                case 0:`,
        after: `                case @[0]@:`,
      },
      {
        id: 'Action5',
        before: `                    t.前に進む(); // step`,
        after: `                    t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int n = 0; n < 2; n++) { // step`,
        after: `        for (int n = 0; n <= 2; n++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `                case 0:`,
        after: `                case 1:`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `                    t.前に進む(); // step`,
        after: `                    t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5SwitchThenCondition',
    title: '選んだ後に判定',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int state = 0; // step
        for (int i = 0; i < 2; i++) { // step
            switch (i) {
                case 0:
                    state = 1; // step
                    break;
                default:
                    state = 2; // step
                    break;
            }
            if (state == 1) {
                t.右を向く(); // step
            }
            t.前に進む(); // step
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('state', 0);
for (s.set('i', 0); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
 switch (s.get('i')) {
  case 0:
   s.set('state', 1);
   break;
  default:
   s.set('state', 2);
   break;
 }
 if (s.get('state') == 1) {
  t.turnRight();
 }
 t.forward();
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Condition12',
        before: `            if (state == 1) {`,
        after: `            if (state @[==]@ 1) {`,
      },
      {
        id: 'Value6',
        before: `                    state = 1; // step`,
        after: `                    state = @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i <= 2; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition12',
        before: `            if (state == 1) {`,
        after: `            if (state != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value6',
        before: `                    state = 1; // step`,
        after: `                    state = 2; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5AssignmentPriority',
    title: '先に成立する条件',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int n = 2; // step
        if (n <= 2) {
            x += n; // step
        } else if (n == 2) {
            x = 1; // step
        } else {
            x = 4; // step
        }
        int y = x - 1; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    instrumented: `s.set('x', 1);
s.set('n', 2);
if (s.get('n') <= 2) {
 s.set('x', s.get('x') + (s.get('n')));
} else if (s.get('n') == 2) {
 s.set('x', 1);
} else {
 s.set('x', 4);
}
s.set('y', s.get('x') - 1);
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();
t.backward();`,
    blanks: [
      {
        id: 'Condition3',
        before: `        if (n <= 2) {`,
        after: `        if (n @[<=]@ 2) {`,
      },
      {
        id: 'Update10',
        before: `        int y = x - 1; // step`,
        after: `        int y = x @[-]@ 1; // step`,
      },
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        if (n <= 2) {`,
        after: `        if (n < 2) {`,
        kind: 'logical',
      },
      {
        id: 'Update10',
        before: `        int y = x - 1; // step`,
        after: `        int y = x + 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5NestedSelection',
    title: 'ケースの中の判定',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 3; i++) { // step
            switch (i % 2) {
                case 0:
                    if (i == 0) {
                        t.右を向く(); // step
                    } else {
                        t.左を向く(); // step
                    }
                    break;
                default:
                    t.前に進む(); // step
                    break;
            }
            t.前に進む(); // step
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
 switch (s.get('i') % 2) {
  case 0:
   if (s.get('i') == 0) {
    t.turnRight();
   } else {
    t.turnLeft();
   }
   break;
  default:
   t.forward();
   break;
 }
 t.forward();
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 3; i++) { // step`,
      },
      {
        id: 'Value3',
        before: `            switch (i % 2) {`,
        after: `            switch (i % @[2]@) {`,
      },
      {
        id: 'Action6',
        before: `                        t.右を向く(); // step`,
        after: `                        t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i <= 3; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            switch (i % 2) {`,
        after: `            switch (i % 1) {`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `                        t.右を向く(); // step`,
        after: `                        t.前に進む(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI5StateCycle',
    title: '巡る状態',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int state = 0; // step
        for (int i = 0; i < 3; i++) { // step
            switch (state) {
                case 0:
                    t.前に進む(); // step
                    state = 2; // step
                    break;
                case 2:
                    t.右を向く(); // step
                    state = 1; // step
                    break;
                default:
                    t.前に進む(); // step
                    state = 0; // step
                    break;
            }
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('state', 0);
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
 switch (s.get('state')) {
  case 0:
   t.forward();
   s.set('state', 2);
   break;
  case 2:
   t.turnRight();
   s.set('state', 1);
   break;
  default:
   t.forward();
   s.set('state', 0);
   break;
 }
}
delete s.vars['i'];`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 3; i++) { // step`,
      },
      {
        id: 'Value2',
        before: `        int state = 0; // step`,
        after: `        int state = @[0]@; // step`,
      },
      {
        id: 'Value7',
        before: `                    state = 2; // step`,
        after: `                    state = @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i <= 3; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int state = 0; // step`,
        after: `        int state = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value7',
        before: `                    state = 2; // step`,
        after: `                    state = 3; // step`,
        kind: 'logical',
      },
    ],
  },
];
