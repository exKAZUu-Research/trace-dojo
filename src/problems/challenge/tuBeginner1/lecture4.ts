import type { ChallengeBase } from '../types';

export const lecture4: ChallengeBase[] = [
  {
    id: 'challengeI4InnerCountdown',
    title: '内側で数え直す',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = 1; j > 0; j--) { // step
                t.後に戻る(); // step
            }
            t.右を向く(); // step
        }
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = 1; j > 0; j--) { // step`,
        after: `            for (int j = 1; j @[>]@ 0; j--) { // step`,
      },
      {
        id: 'Action4',
        before: `                t.後に戻る(); // step`,
        after: `                t.@[後に戻る]@(); // step`,
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
        before: `            for (int j = 1; j > 0; j--) { // step`,
        after: `            for (int j = 1; j >= 0; j--) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.後に戻る(); // step`,
        after: `                t.前に進む(); // step`,
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
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = 0; j < i; j++) { // step
                t.前に進む(); // step
            }
            t.右を向く(); // step
        }
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = 0; j < i; j++) { // step`,
        after: `            for (int j = 0; j @[<]@ i; j++) { // step`,
      },
      {
        id: 'Action4',
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
        before: `            for (int j = 0; j < i; j++) { // step`,
        after: `            for (int j = 0; j <= i; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.前に進む(); // step`,
        after: `                t.後に戻る(); // step`,
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
        int sum = 0; // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = 0; j < 2; j++) { // step
                sum += i + j; // step
            }
        }
        Turtle t = new Turtle(sum, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = @[0]@; // step`,
      },
      {
        id: 'Value2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = @[0]@; i < 2; i++) { // step`,
      },
      {
        id: 'Value3',
        before: `            for (int j = 0; j < 2; j++) { // step`,
        after: `            for (int j = @[0]@; j < 2; j++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int sum = 0; // step`,
        after: `        int sum = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 1; i < 2; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            for (int j = 0; j < 2; j++) { // step`,
        after: `            for (int j = 1; j < 2; j++) { // step`,
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
        Turtle t = new Turtle(3, 3); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = 0; j < 2; j++) { // step
                if (j == 0) {
                    t.前に進む(); // step
                } else {
                    t.後に戻る(); // step
                }
            }
            t.右を向く(); // step
        }
    }
}`,
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
        id: 'Condition4',
        before: `                if (j == 0) {`,
        after: `                if (j @[==]@ 0) {`,
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
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 2; i++) { // step
            for (int j = i; j < 2; j++) { // step
                t.前に進む(); // step
            }
            t.右を向く(); // step
        }
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Condition3',
        before: `            for (int j = i; j < 2; j++) { // step`,
        after: `            for (int j = i; j @[<]@ 2; j++) { // step`,
      },
      {
        id: 'Action4',
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
        before: `            for (int j = i; j < 2; j++) { // step`,
        after: `            for (int j = i; j <= 2; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `                t.前に進む(); // step`,
        after: `                t.後に戻る(); // step`,
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
        Turtle t = new Turtle(3, 2); // step
        int n = 0; // step
        for (int i = 0; i < 3; i++) { // step
            n++; // step
            if (n < 2) {
                t.右を向く(); // step
            } else {
                t.前に進む(); // step
            }
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 3; i++) { // step`,
      },
      {
        id: 'Condition5',
        before: `            if (n < 2) {`,
        after: `            if (n @[<]@ 2) {`,
      },
      {
        id: 'Value2',
        before: `        int n = 0; // step`,
        after: `        int n = @[0]@; // step`,
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
        id: 'Condition5',
        before: `            if (n < 2) {`,
        after: `            if (n <= 2) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 0; // step`,
        after: `        int n = 1; // step`,
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
        Turtle t = new Turtle(2, 2); // step
        int state = 0; // step
        for (int i = 0; i < 2; i++) { // step
            if (state == 0) {
                state = 1; // step
                t.右を向く(); // step
            }
            if (state == 1) {
                t.前に進む(); // step
            }
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
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
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i <= 2; i++) { // step`,
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
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 3; i++) { // step
            if (i > 0) {
                if (i == 1) {
                    t.右を向く(); // step
                } else {
                    t.前に進む(); // step
                }
            }
            t.前に進む(); // step
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 3; i++) { // step`,
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
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i > 3; i++) { // step`,
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
        int x = 1; // step
        for (int i = 0; i < 2; i++) { // step
            if (i == 0) {
                x += 2; // step
            } else {
                x--; // step
            }
        }
        Turtle t = new Turtle(x, 2); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 2; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 2; i++) { // step`,
      },
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value4',
        before: `                x += 2; // step`,
        after: `                x += @[2]@; // step`,
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
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `                x += 2; // step`,
        after: `                x += 3; // step`,
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
        Turtle t = new Turtle(2, 2); // step
        int previous = 0; // step
        for (int i = 1; i < 4; i++) { // step
            if (previous == 1) {
                t.右を向く(); // step
            } else {
                t.前に進む(); // step
            }
            previous = i; // step
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = 1; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (previous == 1) {`,
        after: `            if (previous @[==]@ 1) {`,
      },
      {
        id: 'Value2',
        before: `        int previous = 0; // step`,
        after: `        int previous = @[0]@; // step`,
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
        id: 'Condition4',
        before: `            if (previous == 1) {`,
        after: `            if (previous != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int previous = 0; // step`,
        after: `        int previous = 1; // step`,
        kind: 'logical',
      },
    ],
  },
];
