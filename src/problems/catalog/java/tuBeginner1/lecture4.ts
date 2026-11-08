import type { CorrectProblem } from '../types';

export const lecture4: CorrectProblem[] = [
  {
    id: 'challengeI4InnerCountdown',
    title: '内側で数え直す',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        for (int i = 0; i < 2; i++) {\n            for (int j = 1; j > 0; j--) {\n                t.後に戻る();\n            }\n            t.右を向く();\n        }\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI4EmptyInnerPass',
    title: '空の内側ループ',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 2; i++) {\n            for (int j = 0; j < i; j++) {\n                t.前に進む();\n            }\n            t.右を向く();\n        }\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI4GridAccumulator',
    title: '二重ループの合計',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int sum = 0;\n        for (int i = 0; i < 2; i++) {\n            for (int j = 0; j < 2; j++) {\n                sum += i + j;\n            }\n        }\n        Turtle t = new Turtle(sum, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI4InnerAlternation',
    title: '内側の番号で分ける',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        for (int i = 0; i < 2; i++) {\n            for (int j = 0; j < 2; j++) {\n                if (j == 0) {\n                    t.前に進む();\n                } else {\n                    t.後に戻る();\n                }\n            }\n            t.右を向く();\n        }\n    }\n}',
  },
  {
    id: 'challengeI4DependentStart',
    title: '外側から始まる番号',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 2; i++) {\n            for (int j = i; j < 2; j++) {\n                t.前に進む();\n            }\n            t.右を向く();\n        }\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI4UpdatedCondition',
    title: '更新してから判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 2);\n        int n = 0;\n        for (int i = 0; i < 3; i++) {\n            n++;\n            if (n < 2) {\n                t.右を向く();\n            } else {\n                t.前に進む();\n            }\n        }\n    }\n}',
  },
  {
    id: 'challengeI4IndependentConditions',
    title: '二つの判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int state = 0;\n        for (int i = 0; i < 2; i++) {\n            if (state == 0) {\n                state = 1;\n                t.右を向く();\n            }\n            if (state == 1) {\n                t.前に進む();\n            }\n        }\n    }\n}',
  },
  {
    id: 'challengeI4NestedConditions',
    title: '内側まで進む判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 3; i++) {\n            if (i > 0) {\n                if (i == 1) {\n                    t.右を向く();\n                } else {\n                    t.前に進む();\n                }\n            }\n            t.前に進む();\n        }\n    }\n}',
  },
  {
    id: 'challengeI4BranchAssignment',
    title: '分岐で変わる値',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 1;\n        for (int i = 0; i < 2; i++) {\n            if (i == 0) {\n                x += 2;\n            } else {\n                x--;\n            }\n        }\n        Turtle t = new Turtle(x, 2);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI4LaggedState',
    title: '一つ前の値で判定',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int previous = 0;\n        for (int i = 1; i < 4; i++) {\n            if (previous == 1) {\n                t.右を向く();\n            } else {\n                t.前に進む();\n            }\n            previous = i;\n        }\n    }\n}',
  },
];
