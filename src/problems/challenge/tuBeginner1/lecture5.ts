import type { ChallengeBase } from '../types';

export const lecture5: ChallengeBase[] = [
  {
    id: 'challengeI5OverlappingRanges',
    title: '重なる条件',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int n = 1; n < 4; n++) {
            if (n < 3) {
                t.前に進む();
            } else if (n < 4) {
                t.右を向く();
            } else {
                t.後に戻る();
            }
        }
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) {`,
        after: `        for (int n = 1; n @[<]@ 4; n++) {`,
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
        before: `        for (int n = 1; n < 4; n++) {`,
        after: `        for (int n = 1; n <= 4; n++) {`,
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
        Turtle t = new Turtle(2, 2);
        for (int n = 3; n > 0; n--) {
            if (n > 2) {
                t.前に進む();
                t.右を向く();
            } else if (n == 2) {
                t.前に進む();
            } else {
                t.左を向く();
                t.前に進む();
            }
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 3; n > 0; n--) {`,
        after: `        for (int n = 3; n @[>]@ 0; n--) {`,
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
        before: `        for (int n = 3; n > 0; n--) {`,
        after: `        for (int n = 3; n >= 0; n--) {`,
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
        Turtle t = new Turtle(2, 2);
        int total = 0;
        for (int i = 1; i < 4; i++) {
            total += i;
            switch (total % 3) {
                case 0:
                    t.前に進む();
                    break;
                default:
                    t.右を向く();
                    break;
            }
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
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = @[0]@;`,
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
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = 1; i <= 4; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = 1;`,
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
        int x = 0;
        for (int n = 1; n < 4; n++) {
            switch (n) {
                case 1:
                case 3:
                    x++;
                    break;
                default:
                    x += 2;
                    break;
            }
        }
        Turtle t = new Turtle(x, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) {`,
        after: `        for (int n = 1; n @[<]@ 4; n++) {`,
      },
      {
        id: 'Value1',
        before: `        int x = 0;`,
        after: `        int x = @[0]@;`,
      },
      {
        id: 'Value9',
        before: `                    x += 2;`,
        after: `                    x += @[2]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int n = 1; n < 4; n++) {`,
        after: `        for (int n = 1; n <= 4; n++) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int x = 0;`,
        after: `        int x = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value9',
        before: `                    x += 2;`,
        after: `                    x += 3;`,
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
        Turtle t = new Turtle(2, 2);
        int state = 4;
        for (int i = 0; i < 2; i++) {
            switch (state) {
                case 1:
                    t.前に進む();
                    break;
                default:
                    state = 1;
                    t.右を向く();
                    break;
            }
        }
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i @[<]@ 2; i++) {`,
      },
      {
        id: 'Value9',
        before: `                    state = 1;`,
        after: `                    state = @[1]@;`,
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
        before: `        for (int i = 0; i < 2; i++) {`,
        after: `        for (int i = 0; i <= 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Value9',
        before: `                    state = 1;`,
        after: `                    state = 2;`,
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
        Turtle t = new Turtle(2, 2);
        for (int n = 0; n < 2; n++) {
            switch (n) {
                case 0:
                    t.前に進む();
                    t.左を向く();
                    break;
                default:
                    t.後に戻る();
                    t.右を向く();
                    break;
            }
        }
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int n = 0; n < 2; n++) {`,
        after: `        for (int n = 0; n @[<]@ 2; n++) {`,
      },
      {
        id: 'Value4',
        before: `                case 0:`,
        after: `                case @[0]@:`,
      },
      {
        id: 'Action5',
        before: `                    t.前に進む();`,
        after: `                    t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int n = 0; n < 2; n++) {`,
        after: `        for (int n = 0; n <= 2; n++) {`,
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
        before: `                    t.前に進む();`,
        after: `                    t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        int state = 0;
        for (int i = 0; i < 2; i++) {
            switch (i) {
                case 0:
                    state = 1;
                    break;
                default:
                    state = 2;
                    break;
            }
            if (state == 1) {
                t.右を向く();
            }
            t.前に進む();
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
        id: 'Condition12',
        before: `            if (state == 1) {`,
        after: `            if (state @[==]@ 1) {`,
      },
      {
        id: 'Value6',
        before: `                    state = 1;`,
        after: `                    state = @[1]@;`,
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
        id: 'Condition12',
        before: `            if (state == 1) {`,
        after: `            if (state != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value6',
        before: `                    state = 1;`,
        after: `                    state = 2;`,
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
        int x = 1;
        int n = 2;
        if (n <= 2) {
            x += n;
        } else if (n == 2) {
            x = 1;
        } else {
            x = 4;
        }
        int y = x - 1;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        if (n <= 2) {`,
        after: `        if (n @[<=]@ 2) {`,
      },
      {
        id: 'Update10',
        before: `        int y = x - 1;`,
        after: `        int y = x @[-]@ 1;`,
      },
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = @[1]@;`,
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
        before: `        int y = x - 1;`,
        after: `        int y = x + 1;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = 2;`,
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
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 3; i++) {
            switch (i % 2) {
                case 0:
                    if (i == 0) {
                        t.右を向く();
                    } else {
                        t.左を向く();
                    }
                    break;
                default:
                    t.前に進む();
                    break;
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
        id: 'Value3',
        before: `            switch (i % 2) {`,
        after: `            switch (i % @[2]@) {`,
      },
      {
        id: 'Action6',
        before: `                        t.右を向く();`,
        after: `                        t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) {`,
        after: `        for (int i = 0; i <= 3; i++) {`,
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
        before: `                        t.右を向く();`,
        after: `                        t.前に進む();`,
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
        Turtle t = new Turtle(2, 2);
        int state = 0;
        for (int i = 0; i < 3; i++) {
            switch (state) {
                case 0:
                    t.前に進む();
                    state = 2;
                    break;
                case 2:
                    t.右を向く();
                    state = 1;
                    break;
                default:
                    t.前に進む();
                    state = 0;
                    break;
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
        id: 'Value2',
        before: `        int state = 0;`,
        after: `        int state = @[0]@;`,
      },
      {
        id: 'Value7',
        before: `                    state = 2;`,
        after: `                    state = @[2]@;`,
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
        id: 'Value2',
        before: `        int state = 0;`,
        after: `        int state = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value7',
        before: `                    state = 2;`,
        after: `                    state = 3;`,
        kind: 'logical',
      },
    ],
  },
];
