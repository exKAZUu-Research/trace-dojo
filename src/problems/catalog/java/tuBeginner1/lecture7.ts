import type { CorrectProblem } from '../types';

export const lecture7: CorrectProblem[] = [
  {
    id: 'challengeI7ValueSnapshot',
    title: '引数に渡した値',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int n = 1;\n        advance(t, n);\n        for (int i = 0; i < n; i++) {\n            t.前に進む();\n        }\n        t.右を向く();\n        t.前に進む();\n    }\n    static void advance(Turtle t, int n) {\n        n++;\n        for (int j = 0; j < n; j++) {\n            t.前に進む();\n        }\n    }\n}',
  },
  {
    id: 'challengeI7ObjectMutation',
    title: '渡した亀の向き',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        corner(t);\n        t.前に進む();\n        corner(t);\n        t.後に戻る();\n    }\n    static void corner(Turtle t) {\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI7ReturnedBudget',
    title: '返された残り',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int remaining = consume(t, 3);\n        t.右を向く();\n        for (int i = 0; i < remaining; i++) {\n            t.前に進む();\n        }\n    }\n    static int consume(Turtle t, int budget) {\n        t.前に進む();\n        budget--;\n        return budget;\n    }\n}',
  },
  {
    id: 'challengeI7EarlyReturnGuard',
    title: 'すぐ戻る呼び出し',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        guarded(t, 0);\n        t.右を向く();\n        guarded(t, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n    static void guarded(Turtle t, int enabled) {\n        if (enabled == 0) {\n            return;\n        }\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI7ArgumentOrder',
    title: '二つの引数の順番',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = difference(5, 2);\n        int y = difference(x, 1);\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n    static int difference(int left, int right) {\n        int result = left - right;\n        return result;\n    }\n}',
  },
  {
    id: 'challengeI7NestedComposition',
    title: '戻り値を次の呼び出しへ',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        travel(t, 3);\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n    static void travel(Turtle t, int request) {\n        int count = reduce(request);\n        for (int i = 0; i < count; i++) {\n            t.前に進む();\n        }\n    }\n    static int reduce(int n) {\n        return n - 1;\n    }\n}',
  },
  {
    id: 'challengeI7ReturnSkipsSuffix',
    title: '途中で戻るメソッド',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        visit(t, 1);\n        t.右を向く();\n        visit(t, 2);\n        t.前に進む();\n        t.左を向く();\n    }\n    static void visit(Turtle t, int n) {\n        t.前に進む();\n        if (n == 1) {\n            return;\n        }\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI7LocalShadow',
    title: '同じ名前の別の変数',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int count = 1;\n        localWalk(t);\n        t.右を向く();\n        for (int i = 0; i < count; i++) {\n            t.前に進む();\n        }\n    }\n    static void localWalk(Turtle t) {\n        int count = 2;\n        for (int j = 0; j < count; j++) {\n            t.前に進む();\n        }\n        count = 0;\n    }\n}',
  },
  {
    id: 'challengeI7PredicateAction',
    title: '判定を返すメソッド',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 1; i < 4; i++) {\n            boolean turn = reaches(i, 2);\n            if (turn) {\n                t.右を向く();\n            } else {\n                t.前に進む();\n            }\n        }\n        t.後に戻る();\n    }\n    static boolean reaches(int value, int target) {\n        return value == target;\n    }\n}',
  },
  {
    id: 'challengeI7CarriedReturn',
    title: '戻り値をもう一度渡す',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 1);\n        int count = next(1);\n        count = next(count);\n        for (int i = 0; i < count; i++) {\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n    }\n    static int next(int n) {\n        int result = n + 1;\n        return result;\n    }\n}',
  },
];
