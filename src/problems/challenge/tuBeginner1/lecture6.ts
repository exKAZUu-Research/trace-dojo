import type { ChallengeBase } from '../types';

export const lecture6: ChallengeBase[] = [
  {
    id: 'challengeI6ThresholdBreak',
    title: '合計が届いたら終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 0;
        for (int i = 1; i < 5; i++) {
            sum += i;
            if (sum >= 3) {
                break;
            }
        }
        Turtle t = new Turtle(sum, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `            if (sum >= 3) {`,
        after: `            if (sum @[>=]@ 3) {`,
      },
      {
        id: 'Value1',
        before: `        int sum = 0;`,
        after: `        int sum = @[0]@;`,
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 5; i++) {`,
        after: `        for (int i = @[1]@; i < 5; i++) {`,
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
        before: `        int sum = 0;`,
        after: `        int sum = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 5; i++) {`,
        after: `        for (int i = 2; i < 5; i++) {`,
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
        Turtle t = new Turtle(2, 1);
        for (int i = 0; i < 4; i++) {
            if (i == 2) {
                break;
            }
            t.前に進む();
        }
        t.右を向く();
        t.前に進む();
        t.左を向く();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Condition3',
        before: `            if (i == 2) {`,
        after: `            if (i @[==]@ 2) {`,
      },
      {
        id: 'Action6',
        before: `            t.前に進む();`,
        after: `            t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i > 4; i++) {`,
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
        before: `            t.前に進む();`,
        after: `            t.右を向く();`,
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
        Turtle t = new Turtle(2, 1);
        for (int i = 0; i < 4; i++) {
            t.前に進む();
            if (i == 1) {
                break;
            }
        }
        t.後に戻る();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (i == 1) {`,
        after: `            if (i @[==]@ 1) {`,
      },
      {
        id: 'Action3',
        before: `            t.前に進む();`,
        after: `            t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i > 4; i++) {`,
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
        before: `            t.前に進む();`,
        after: `            t.右を向く();`,
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
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 3; j++) {
                t.前に進む();
                if (j == i) {
                    break;
                }
            }
            t.右を向く();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i @[<]@ 2; i++) {`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 3; j++) {`,
        after: `            for (int j = 0; j @[<]@ 3; j++) {`,
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
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i <= 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 3; j++) {`,
        after: `            for (int j = 0; j > 3; j++) {`,
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
        int sum = 0;
        for (int i = 1; i < 4; i++) {
            if (i == 2) {
                continue;
            }
            sum += i;
        }
        Turtle t = new Turtle(sum, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `            if (i == 2) {`,
        after: `            if (i @[==]@ 2) {`,
      },
      {
        id: 'Value1',
        before: `        int sum = 0;`,
        after: `        int sum = @[0]@;`,
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = @[1]@; i < 4; i++) {`,
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
        before: `        int sum = 0;`,
        after: `        int sum = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = 2; i < 4; i++) {`,
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
        Turtle t = new Turtle(2, 1);
        int remaining = 3;
        while (remaining > 0) {
            remaining--;
            if (remaining == 1) {
                continue;
            }
            t.前に進む();
        }
        t.右を向く();
        t.前に進む();
    }
}`,
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
        before: `        int remaining = 3;`,
        after: `        int remaining = @[3]@;`,
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
        before: `        int remaining = 3;`,
        after: `        int remaining = 4;`,
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
        Turtle t = new Turtle(2, 1);
        for (int i = 0; i < 5; i++) {
            if (i == 1) {
                continue;
            }
            if (i == 3) {
                break;
            }
            t.前に進む();
        }
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i++) {`,
        after: `        for (int i = 0; i @[<]@ 5; i++) {`,
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
        before: `        for (int i = 0; i < 5; i++) {`,
        after: `        for (int i = 0; i > 5; i++) {`,
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
        Turtle t = new Turtle(2, 4);
        for (int i = 0; i < 4; i++) {
            if (!t.前に進めるか()) {
                t.右を向く();
                break;
            }
            t.前に進む();
        }
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Action4',
        before: `                t.右を向く();`,
        after: `                t.@[右を向く]@();`,
      },
      {
        id: 'Action7',
        before: `            t.前に進む();`,
        after: `            t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i > 4; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.右を向く();`,
        after: `                t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `            t.前に進む();`,
        after: `            t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                if (j == i) {
                    continue;
                }
                t.前に進む();
            }
            t.右を向く();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i @[<]@ 2; i++) {`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 2; j++) {`,
        after: `            for (int j = 0; j @[<]@ 2; j++) {`,
      },
      {
        id: 'Action7',
        before: `                t.前に進む();`,
        after: `                t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i <= 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < 2; j++) {`,
        after: `            for (int j = 0; j <= 2; j++) {`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `                t.前に進む();`,
        after: `                t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 4; i++) {
            switch (i) {
                case 0:
                    t.右を向く();
                    break;
                default:
                    t.前に進む();
                    break;
            }
            if (i == 2) {
                break;
            }
            t.左を向く();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Condition11',
        before: `            if (i == 2) {`,
        after: `            if (i @[==]@ 2) {`,
      },
      {
        id: 'Action5',
        before: `                    t.右を向く();`,
        after: `                    t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 4; i++) {`,
        after: `        for (int i = 0; i > 4; i++) {`,
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
        before: `                    t.右を向く();`,
        after: `                    t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
];
