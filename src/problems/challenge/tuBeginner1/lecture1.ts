import type { ChallengeBase } from '../types';

export const lecture1: ChallengeBase[] = [
  {
    id: 'challengeI1ForkReturn',
    title: '枝から戻る道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.backward();
t.backward();
t.turnLeft();
t.forward();
t.forward();`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.@[後に戻る]@(); // step`,
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1BackwardEast',
    title: '後ろ向きの横道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.turnLeft();
t.backward();
t.backward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.@[右を向く]@(); // step`,
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1OpenArch',
    title: 'アーチを横切る道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.turnLeft();
t.backward();
t.backward();
t.backward();`,
    blanks: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.@[後に戻る]@(); // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1OffsetNotch',
    title: 'くぼみのある道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.@[右を向く]@(); // step`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1CrossbarRetreat',
    title: '横棒と帰り道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.backward();
t.backward();
t.backward();
t.turnLeft();
t.forward();
t.forward();`,
    blanks: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action15',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action15',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1ReverseHook',
    title: '逆向きに出るフック',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.forward();
t.backward();
t.turnLeft();
t.forward();`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1StairRollback',
    title: '階段を一歩戻る',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.forward();
t.turnLeft();
t.forward();
t.turnRight();
t.forward();
t.backward();
t.turnLeft();
t.forward();
t.forward();`,
    blanks: [
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.@[右を向く]@(); // step`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.右を向く(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1BracketBranch',
    title: '折り返して分かれる道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.turnRight();
t.backward();
t.turnLeft();
t.backward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();
t.turnRight();
t.forward();`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action9',
        before: `        t.左を向く(); // step`,
        after: `        t.@[左を向く]@(); // step`,
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action9',
        before: `        t.左を向く(); // step`,
        after: `        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1OpposedArms',
    title: '反対向きの枝',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.前に進む(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.forward();
t.turnRight();
t.forward();
t.forward();
t.backward();
t.backward();
t.turnRight();
t.turnRight();
t.backward();
t.forward();`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.@[後に戻る]@(); // step`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI1BackwardCorner',
    title: '後ろ歩きの角',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
    }
}`,
    instrumented: `const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.turnRight();
t.forward();
t.forward();
t.turnLeft();
t.forward();
t.forward();
t.turnLeft();
t.backward();
t.turnRight();
t.forward();
t.turnLeft();
t.backward();`,
    blanks: [
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.@[左を向く]@(); // step`,
      },
      {
        id: 'Action13',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.@[後に戻る]@(); // step`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action13',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
];
