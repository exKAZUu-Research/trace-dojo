import type { ChallengeBase } from '../types';

export const lecture4: ChallengeBase[] = [
  {
    id: 'challengeI4InnerCountdown',
    title: '内側で数え直す',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 2; i++) {
            for (int j = 1; j > 0; j--) {
                t.後に戻る();
            }
            t.右を向く();
        }
        t.前に進む();
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
        before: `            for (int j = 1; j > 0; j--) {`,
        after: `            for (int j = 1; j @[>]@ 0; j--) {`,
      },
      {
        id: 'Action4',
        before: `                t.後に戻る();`,
        after: `                t.@[後に戻る]@();`,
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
        before: `            for (int j = 1; j > 0; j--) {`,
        after: `            for (int j = 1; j >= 0; j--) {`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.後に戻る();`,
        after: `                t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4EmptyInnerPass',
    title: '空の内側ループ',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < i; j++) {
                t.前に進む();
            }
            t.右を向く();
        }
        t.後に戻る();
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
        before: `            for (int j = 0; j < i; j++) {`,
        after: `            for (int j = 0; j @[<]@ i; j++) {`,
      },
      {
        id: 'Action4',
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
        before: `            for (int j = 0; j < i; j++) {`,
        after: `            for (int j = 0; j <= i; j++) {`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.前に進む();`,
        after: `                t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4GridAccumulator',
    title: '二重ループの合計',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 0;
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                sum += i + j;
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
        id: 'Value1',
        before: `        int sum = 0;`,
        after: `        int sum = @[0]@;`,
      },
      {
        id: 'Value2',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = @[0]@; i < 2; i++) {`,
      },
      {
        id: 'Value3',
        before: `            for (int j = 0; j < 2; j++) {`,
        after: `            for (int j = @[0]@; j < 2; j++) {`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int sum = 0;`,
        after: `        int sum = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 1; i < 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            for (int j = 0; j < 2; j++) {`,
        after: `            for (int j = 1; j < 2; j++) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4InnerAlternation',
    title: '内側の番号で分ける',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                if (j == 0) {
                    t.前に進む();
                } else {
                    t.後に戻る();
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
        before: `            for (int j = 0; j < 2; j++) {`,
        after: `            for (int j = 0; j @[<]@ 2; j++) {`,
      },
      {
        id: 'Condition4',
        before: `                if (j == 0) {`,
        after: `                if (j @[==]@ 0) {`,
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
        id: 'Condition4',
        before: `                if (j == 0) {`,
        after: `                if (j != 0) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4DependentStart',
    title: '外側から始まる番号',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 2; i++) {
            for (int j = i; j < 2; j++) {
                t.前に進む();
            }
            t.右を向く();
        }
        t.後に戻る();
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
        before: `            for (int j = i; j < 2; j++) {`,
        after: `            for (int j = i; j @[<]@ 2; j++) {`,
      },
      {
        id: 'Action4',
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
        before: `            for (int j = i; j < 2; j++) {`,
        after: `            for (int j = i; j <= 2; j++) {`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.前に進む();`,
        after: `                t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4UpdatedCondition',
    title: '更新してから判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 2);
        int n = 0;
        for (int i = 0; i < 3; i++) {
            n++;
            if (n < 2) {
                t.右を向く();
            } else {
                t.前に進む();
            }
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 3; i++) {`,
        after: `        for (int i = 0; i @[<]@ 3; i++) {`,
      },
      {
        id: 'Condition5',
        before: `            if (n < 2) {`,
        after: `            if (n @[<]@ 2) {`,
      },
      {
        id: 'Value2',
        before: `        int n = 0;`,
        after: `        int n = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 3; i++) {`,
        after: `        for (int i = 0; i <= 3; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition5',
        before: `            if (n < 2) {`,
        after: `            if (n <= 2) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 0;`,
        after: `        int n = 1;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4IndependentConditions',
    title: '二つの判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int state = 0;
        for (int i = 0; i < 2; i++) {
            if (state == 0) {
                state = 1;
                t.右を向く();
            }
            if (state == 1) {
                t.前に進む();
            }
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i @[<]@ 2; i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (state == 0) {`,
        after: `            if (state @[==]@ 0) {`,
      },
      {
        id: 'Condition8',
        before: `            if (state == 1) {`,
        after: `            if (state @[==]@ 1) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i <= 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (state == 0) {`,
        after: `            if (state != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Condition8',
        before: `            if (state == 1) {`,
        after: `            if (state != 1) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4NestedConditions',
    title: '内側まで進む判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 3; i++) {
            if (i > 0) {
                if (i == 1) {
                    t.右を向く();
                } else {
                    t.前に進む();
                }
            }
            t.前に進む();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) {`,
        after: `        for (int i = 0; i @[<]@ 3; i++) {`,
      },
      {
        id: 'Condition3',
        before: `            if (i > 0) {`,
        after: `            if (i @[>]@ 0) {`,
      },
      {
        id: 'Condition4',
        before: `                if (i == 1) {`,
        after: `                if (i @[==]@ 1) {`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) {`,
        after: `        for (int i = 0; i > 3; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition3',
        before: `            if (i > 0) {`,
        after: `            if (i >= 0) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `                if (i == 1) {`,
        after: `                if (i != 1) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4BranchAssignment',
    title: '分岐で変わる値',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        for (int i = 0; i < 2; i++) {
            if (i == 0) {
                x += 2;
            } else {
                x--;
            }
        }
        Turtle t = new Turtle(x, 2);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i @[<]@ 2; i++) {`,
      },
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = @[1]@;`,
      },
      {
        id: 'Value4',
        before: `                x += 2;`,
        after: `                x += @[2]@;`,
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
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = 2;`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `                x += 2;`,
        after: `                x += 3;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI4LaggedState',
    title: '一つ前の値で判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int previous = 0;
        for (int i = 1; i < 4; i++) {
            if (previous == 1) {
                t.右を向く();
            } else {
                t.前に進む();
            }
            previous = i;
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = 1; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (previous == 1) {`,
        after: `            if (previous @[==]@ 1) {`,
      },
      {
        id: 'Value2',
        before: `        int previous = 0;`,
        after: `        int previous = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = 1; i <= 4; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (previous == 1) {`,
        after: `            if (previous != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int previous = 0;`,
        after: `        int previous = 1;`,
        kind: 'logical',
      },
    ],
  },
];
