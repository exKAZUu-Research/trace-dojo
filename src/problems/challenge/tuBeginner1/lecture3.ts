import type { ChallengeBase } from '../types';

export const lecture3: ChallengeBase[] = [
  {
    id: 'challengeI3CountdownRetreat',
    title: '数えながら戻る',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        for (int i = 2; i > 0; i--) { // step
            t.後に戻る(); // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.forward();
for (s.set('i', 2); s.get('i') > 0; s.set('i', s.get('i') - 1)) {
 t.backward();
}
delete s.vars['i'];
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition5',
        before: `        for (int i = 2; i > 0; i--) { // step`,
        after: `        for (int i = 2; i @[>]@ 0; i--) { // step`,
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition5',
        before: `        for (int i = 2; i > 0; i--) { // step`,
        after: `        for (int i = 2; i >= 0; i--) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3StrideCounter',
    title: '二つずつ数える',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 5; i += 2) { // step
            t.前に進む(); // step
            t.右を向く(); // step
        }
        t.後に戻る(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 5; s.set('i', s.get('i') + (2))) {
 t.forward();
 t.turnRight();
}
delete s.vars['i'];
t.backward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i += 2) { // step`,
        after: `        for (int i = 0; i @[<]@ 5; i += 2) { // step`,
      },
      {
        id: 'Action3',
        before: `            t.前に進む(); // step`,
        after: `            t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action4',
        before: `            t.右を向く(); // step`,
        after: `            t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i += 2) { // step`,
        after: `        for (int i = 0; i > 5; i += 2) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `            t.前に進む(); // step`,
        after: `            t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `            t.右を向く(); // step`,
        after: `            t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ConsumedBudget',
    title: '二つずつ使う残り',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int budget = 5; // step
        while (budget > 0) {
            t.前に進む(); // step
            budget -= 2; // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('budget', 5);
while (s.get('budget') > 0) {
 t.forward();
 s.set('budget', s.get('budget') - (2));
}
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (budget > 0) {`,
        after: `        while (budget @[>]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int budget = 5; // step`,
        after: `        int budget = @[5]@; // step`,
      },
      {
        id: 'Value5',
        before: `            budget -= 2; // step`,
        after: `            budget -= @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (budget > 0) {`,
        after: `        while (budget < 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int budget = 5; // step`,
        after: `        int budget = 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Value5',
        before: `            budget -= 2; // step`,
        after: `            budget -= 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3AccumulatedOrigin',
    title: '計算してから出発',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 0; // step
        for (int i = 1; i < 3; i++) { // step
            sum += i; // step
        }
        int y = sum - 2; // step
        Turtle t = new Turtle(sum, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('sum', 0);
for (s.set('i', 1); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
 s.set('sum', s.get('sum') + (s.get('i')));
}
delete s.vars['i'];
s.set('y', s.get('sum') - 2);
const t = new Turtle(s.get('sum'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 3; i++) { // step`,
        after: `        for (int i = 1; i @[<]@ 3; i++) { // step`,
      },
      {
        id: 'Update5',
        before: `        int y = sum - 2; // step`,
        after: `        int y = sum @[-]@ 2; // step`,
      },
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = @[0]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 3; i++) { // step`,
        after: `        for (int i = 1; i <= 3; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Update5',
        before: `        int y = sum - 2; // step`,
        after: `        int y = sum + 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = 1; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3MultiplicativeStop',
    title: '倍になるカウンター',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        int n = 1; // step
        while (n < 8) {
            t.前に進む(); // step
            n *= 2; // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
s.set('n', 1);
while (s.get('n') < 8) {
 t.forward();
 s.set('n', s.get('n') * (2));
}
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (n < 8) {`,
        after: `        while (n @[<]@ 8) {`,
      },
      {
        id: 'Update5',
        before: `            n *= 2; // step`,
        after: `            n @[*=]@ 2; // step`,
      },
      {
        id: 'Value2',
        before: `        int n = 1; // step`,
        after: `        int n = @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (n < 8) {`,
        after: `        while (n <= 8) {`,
        kind: 'logical',
      },
      {
        id: 'Update5',
        before: `            n *= 2; // step`,
        after: `            n += 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 1; // step`,
        after: `        int n = 2; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ChainedLoops',
    title: '続けて使うカウンター',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        int n = 3; // step
        while (n > 1) {
            t.前に進む(); // step
            n--; // step
        }
        t.右を向く(); // step
        while (n < 3) {
            t.前に進む(); // step
            n++; // step
        }
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
s.set('n', 3);
while (s.get('n') > 1) {
 t.forward();
 s.set('n', s.get('n') - 1);
}
t.turnRight();
while (s.get('n') < 3) {
 t.forward();
 s.set('n', s.get('n') + 1);
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (n > 1) {`,
        after: `        while (n @[>]@ 1) {`,
      },
      {
        id: 'Condition8',
        before: `        while (n < 3) {`,
        after: `        while (n @[<]@ 3) {`,
      },
      {
        id: 'Value2',
        before: `        int n = 3; // step`,
        after: `        int n = @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (n > 1) {`,
        after: `        while (n >= 1) {`,
        kind: 'logical',
      },
      {
        id: 'Condition8',
        before: `        while (n < 3) {`,
        after: `        while (n <= 3) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 3; // step`,
        after: `        int n = 4; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ShrinkingLimit',
    title: '近づく二つの値',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        int i = 0; // step
        int limit = 4; // step
        while (i < limit) {
            t.前に進む(); // step
            i++; // step
            limit--; // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
s.set('i', 0);
s.set('limit', 4);
while (s.get('i') < s.get('limit')) {
 t.forward();
 s.set('i', s.get('i') + 1);
 s.set('limit', s.get('limit') - 1);
}
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Condition4',
        before: `        while (i < limit) {`,
        after: `        while (i @[<]@ limit) {`,
      },
      {
        id: 'Value3',
        before: `        int limit = 4; // step`,
        after: `        int limit = @[4]@; // step`,
      },
      {
        id: 'Action5',
        before: `            t.前に進む(); // step`,
        after: `            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        while (i < limit) {`,
        after: `        while (i <= limit) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int limit = 4; // step`,
        after: `        int limit = 5; // step`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `            t.前に進む(); // step`,
        after: `            t.右を向く(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3PreupdatedBudget',
    title: '先に減らして進む',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3); // step
        int remaining = 2; // step
        while (remaining > 0) {
            remaining--; // step
            t.後に戻る(); // step
            t.左を向く(); // step
        }
        t.前に進む(); // step
        t.右を向く(); // step
    }
}`,
    instrumented: `const t = new Turtle(3, 3); registerDisplayRef('t', () => t); // step
s.set('remaining', 2);
while (s.get('remaining') > 0) {
 s.set('remaining', s.get('remaining') - 1);
 t.backward();
 t.turnLeft();
}
t.forward();
t.turnRight();`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (remaining > 0) {`,
        after: `        while (remaining @[>]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = 2; // step`,
        after: `        int remaining = @[2]@; // step`,
      },
      {
        id: 'Action5',
        before: `            t.後に戻る(); // step`,
        after: `            t.@[後に戻る]@(); // step`,
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
        id: 'Value2',
        before: `        int remaining = 2; // step`,
        after: `        int remaining = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `            t.後に戻る(); // step`,
        after: `            t.前に進む(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3RemainderOrigin',
    title: '合計の余りから出発',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 1; // step
        for (int i = 1; i <= 2; i++) { // step
            sum += i * 2; // step
        }
        int x = sum % 3; // step
        int y = sum / 3; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `s.set('sum', 1);
for (s.set('i', 1); s.get('i') <= 2; s.set('i', s.get('i') + 1)) {
 s.set('sum', s.get('sum') + (s.get('i') * 2));
}
delete s.vars['i'];
s.set('x', s.get('sum') % 3);
s.set('y', Math.trunc(s.get('sum') / 3));
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i <= 2; i++) { // step`,
        after: `        for (int i = 1; i @[<=]@ 2; i++) { // step`,
      },
      {
        id: 'Value1',
        before: `        int sum = 1; // step`,
        after: `        int sum = @[1]@; // step`,
      },
      {
        id: 'Value3',
        before: `            sum += i * 2; // step`,
        after: `            sum += i * @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i <= 2; i++) { // step`,
        after: `        for (int i = 1; i < 2; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int sum = 1; // step`,
        after: `        int sum = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            sum += i * 2; // step`,
        after: `            sum += i * 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ZeroPassSection',
    title: '実行されない区間',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        t.前に進む(); // step
        for (int i = 3; i < 2; i++) { // step
            t.後に戻る(); // step
        }
        t.右を向く(); // step
        for (int j = 0; j < 2; j++) { // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
    }
}`,
    instrumented: `const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
t.forward();
for (s.set('i', 3); s.get('i') < 2; s.set('i', s.get('i') + 1)) {
 t.backward();
}
delete s.vars['i'];
t.turnRight();
for (s.set('j', 0); s.get('j') < 2; s.set('j', s.get('j') + 1)) {
 t.forward();
}
delete s.vars['j'];
t.turnLeft();`,
    blanks: [
      {
        id: 'Condition7',
        before: `        for (int j = 0; j < 2; j++) { // step`,
        after: `        for (int j = 0; j @[<]@ 2; j++) { // step`,
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action6',
        before: `        t.右を向く(); // step`,
        after: `        t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition7',
        before: `        for (int j = 0; j < 2; j++) { // step`,
        after: `        for (int j = 0; j <= 2; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `        t.右を向く(); // step`,
        after: `        t.前に進む(); // step`,
        kind: 'logical',
      },
    ],
  },
];
