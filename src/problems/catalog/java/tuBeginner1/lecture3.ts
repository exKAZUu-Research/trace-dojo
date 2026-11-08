import type { CorrectProblem } from '../types';

export const lecture3: CorrectProblem[] = [
  {
    id: 'challengeI3CountdownRetreat',
    title: '数えながら戻る',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        t.前に進む();\n        t.前に進む();\n        t.前に進む();\n        for (int i = 2; i > 0; i--) {\n            t.後に戻る();\n        }\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI3StrideCounter',
    title: '二つずつ数える',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 5; i += 2) {\n            t.前に進む();\n            t.右を向く();\n        }\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI3ConsumedBudget',
    title: '二つずつ使う残り',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(1, 1);\n        int budget = 5;\n        while (budget > 0) {\n            t.前に進む();\n            budget -= 2;\n        }\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI3AccumulatedOrigin',
    title: '計算してから出発',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int sum = 0;\n        for (int i = 1; i < 3; i++) {\n            sum += i;\n        }\n        int y = sum - 2;\n        Turtle t = new Turtle(sum, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI3MultiplicativeStop',
    title: '倍になるカウンター',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int n = 1;\n        while (n < 8) {\n            t.前に進む();\n            n *= 2;\n        }\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI3ChainedLoops',
    title: '続けて使うカウンター',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int n = 3;\n        while (n > 1) {\n            t.前に進む();\n            n--;\n        }\n        t.右を向く();\n        while (n < 3) {\n            t.前に進む();\n            n++;\n        }\n    }\n}',
  },
  {
    id: 'challengeI3ShrinkingLimit',
    title: '近づく二つの値',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int i = 0;\n        int limit = 4;\n        while (i < limit) {\n            t.前に進む();\n            i++;\n            limit--;\n        }\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI3PreupdatedBudget',
    title: '先に減らして進む',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int remaining = 2;\n        while (remaining > 0) {\n            remaining--;\n            t.後に戻る();\n            t.左を向く();\n        }\n        t.前に進む();\n        t.右を向く();\n    }\n}',
  },
  {
    id: 'challengeI3RemainderOrigin',
    title: '合計の余りから出発',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int sum = 1;\n        for (int i = 1; i <= 2; i++) {\n            sum += i * 2;\n        }\n        int x = sum % 3;\n        int y = sum / 3;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI3ZeroPassSection',
    title: '実行されない区間',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        t.前に進む();\n        for (int i = 3; i < 2; i++) {\n            t.後に戻る();\n        }\n        t.右を向く();\n        for (int j = 0; j < 2; j++) {\n            t.前に進む();\n        }\n        t.左を向く();\n    }\n}',
  },
];
