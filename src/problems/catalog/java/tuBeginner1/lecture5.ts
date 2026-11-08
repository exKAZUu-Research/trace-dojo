import type { CorrectProblem } from '../types';

export const lecture5: CorrectProblem[] = [
  {
    id: 'challengeI5OverlappingRanges',
    title: '重なる条件',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int n = 1; n < 4; n++) {\n            if (n < 3) {\n                t.前に進む();\n            } else if (n < 4) {\n                t.右を向く();\n            } else {\n                t.後に戻る();\n            }\n        }\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI5DescendingCategories',
    title: '減りながら分岐',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int n = 3; n > 0; n--) {\n            if (n > 2) {\n                t.前に進む();\n                t.右を向く();\n            } else if (n == 2) {\n                t.前に進む();\n            } else {\n                t.左を向く();\n                t.前に進む();\n            }\n        }\n    }\n}',
  },
  {
    id: 'challengeI5ComputedSelector',
    title: '計算した番号で選ぶ',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int total = 0;\n        for (int i = 1; i < 4; i++) {\n            total += i;\n            switch (total % 3) {\n                case 0:\n                    t.前に進む();\n                    break;\n                default:\n                    t.右を向く();\n                    break;\n            }\n        }\n    }\n}',
  },
  {
    id: 'challengeI5GroupedState',
    title: 'まとめられた番号',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 0;\n        for (int n = 1; n < 4; n++) {\n            switch (n) {\n                case 1:\n                case 3:\n                    x++;\n                    break;\n                default:\n                    x += 2;\n                    break;\n            }\n        }\n        Turtle t = new Turtle(x, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI5DefaultTransition',
    title: '既定から次の状態へ',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int state = 4;\n        for (int i = 0; i < 2; i++) {\n            switch (state) {\n                case 1:\n                    t.前に進む();\n                    break;\n                default:\n                    state = 1;\n                    t.右を向く();\n                    break;\n            }\n        }\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI5CaseSequence',
    title: '一つのケースの二命令',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int n = 0; n < 2; n++) {\n            switch (n) {\n                case 0:\n                    t.前に進む();\n                    t.左を向く();\n                    break;\n                default:\n                    t.後に戻る();\n                    t.右を向く();\n                    break;\n            }\n        }\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI5SwitchThenCondition',
    title: '選んだ後に判定',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int state = 0;\n        for (int i = 0; i < 2; i++) {\n            switch (i) {\n                case 0:\n                    state = 1;\n                    break;\n                default:\n                    state = 2;\n                    break;\n            }\n            if (state == 1) {\n                t.右を向く();\n            }\n            t.前に進む();\n        }\n    }\n}',
  },
  {
    id: 'challengeI5AssignmentPriority',
    title: '先に成立する条件',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 1;\n        int n = 2;\n        if (n <= 2) {\n            x += n;\n        } else if (n == 2) {\n            x = 1;\n        } else {\n            x = 4;\n        }\n        int y = x - 1;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI5NestedSelection',
    title: 'ケースの中の判定',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 3; i++) {\n            switch (i % 2) {\n                case 0:\n                    if (i == 0) {\n                        t.右を向く();\n                    } else {\n                        t.左を向く();\n                    }\n                    break;\n                default:\n                    t.前に進む();\n                    break;\n            }\n            t.前に進む();\n        }\n    }\n}',
  },
  {
    id: 'challengeI5StateCycle',
    title: '巡る状態',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int state = 0;\n        for (int i = 0; i < 3; i++) {\n            switch (state) {\n                case 0:\n                    t.前に進む();\n                    state = 2;\n                    break;\n                case 2:\n                    t.右を向く();\n                    state = 1;\n                    break;\n                default:\n                    t.前に進む();\n                    state = 0;\n                    break;\n            }\n        }\n    }\n}',
  },
];
