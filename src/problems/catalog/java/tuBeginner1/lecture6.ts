import type { CorrectProblem } from '../types';

export const lecture6: CorrectProblem[] = [
  {
    id: 'challengeI6ThresholdBreak',
    title: '合計が届いたら終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int sum = 0;\n        for (int i = 1; i < 5; i++) {\n            sum += i;\n            if (sum >= 3) {\n                break;\n            }\n        }\n        Turtle t = new Turtle(sum, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI6BreakBeforeAction',
    title: '進む前に終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        for (int i = 0; i < 4; i++) {\n            if (i == 2) {\n                break;\n            }\n            t.前に進む();\n        }\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n    }\n}',
  },
  {
    id: 'challengeI6BreakAfterAction',
    title: '進んだ後に終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        for (int i = 0; i < 4; i++) {\n            t.前に進む();\n            if (i == 1) {\n                break;\n            }\n        }\n        t.後に戻る();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI6InnerBreak',
    title: '内側だけを抜ける',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 2; i++) {\n            for (int j = 0; j < 3; j++) {\n                t.前に進む();\n                if (j == i) {\n                    break;\n                }\n            }\n            t.右を向く();\n        }\n    }\n}',
  },
  {
    id: 'challengeI6SkippedSum',
    title: '加えない回',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int sum = 0;\n        for (int i = 1; i < 4; i++) {\n            if (i == 2) {\n                continue;\n            }\n            sum += i;\n        }\n        Turtle t = new Turtle(sum, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI6ProgressBeforeContinue',
    title: '先に減らして次へ',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int remaining = 3;\n        while (remaining > 0) {\n            remaining--;\n            if (remaining == 1) {\n                continue;\n            }\n            t.前に進む();\n        }\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI6SkipThenStop',
    title: '飛ばしてから止める',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        for (int i = 0; i < 5; i++) {\n            if (i == 1) {\n                continue;\n            }\n            if (i == 3) {\n                break;\n            }\n            t.前に進む();\n        }\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI6GuardedExit',
    title: '壁で向きを変えて終了',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 4);\n        for (int i = 0; i < 4; i++) {\n            if (!t.前に進めるか()) {\n                t.右を向く();\n                break;\n            }\n            t.前に進む();\n        }\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI6InnerContinue',
    title: '内側の一回を飛ばす',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 2; i++) {\n            for (int j = 0; j < 2; j++) {\n                if (j == i) {\n                    continue;\n                }\n                t.前に進む();\n            }\n            t.右を向く();\n        }\n    }\n}',
  },
  {
    id: 'challengeI6SwitchAndLoopExit',
    title: '二つのbreak',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 4; i++) {\n            switch (i) {\n                case 0:\n                    t.右を向く();\n                    break;\n                default:\n                    t.前に進む();\n                    break;\n            }\n            if (i == 2) {\n                break;\n            }\n            t.左を向く();\n        }\n    }\n}',
  },
];
