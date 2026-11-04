import type { ChallengeBase } from '../types';

export const lecture1: ChallengeBase[] = [
  {
    id: 'challengeI1ForkReturn',
    title: '枝から戻る道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.@[後に戻る]@();`,
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.@[右を向く]@();`,
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action11',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.@[後に戻る]@();`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.後に戻る();
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.@[右を向く]@();`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action15',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action9',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();`,
        kind: 'logical',
      },
      {
        id: 'Action15',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.@[右を向く]@();`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
        t.左を向く();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.右を向く();
        t.右を向く();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action9',
        before: `        t.左を向く();`,
        after: `        t.@[左を向く]@();`,
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action9',
        before: `        t.左を向く();`,
        after: `        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action16',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.後に戻る();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.右を向く();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.@[前に進む]@();`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.@[後に戻る]@();`,
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action12',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.前に進む();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.後に戻る();
        t.後に戻る();
        t.右を向く();
        t.右を向く();
        t.後に戻る();
        t.後に戻る();`,
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
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.@[左を向く]@();`,
      },
      {
        id: 'Action13',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.@[後に戻る]@();`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action13',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
];
