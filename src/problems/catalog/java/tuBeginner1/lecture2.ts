import type { CorrectProblem } from '../types';

export const lecture2: CorrectProblem[] = [
  {
    id: 'challengeI2SnapshotCoordinates',
    title: '写してから変える座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 1;\n        int y = x;\n        x += 2;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI2CoordinateExchange',
    title: '座標を入れ替える',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 1;\n        int y = 3;\n        int saved = x;\n        x = y;\n        y = saved;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI2OverwrittenCandidate',
    title: '残された候補',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int candidate = 2;\n        int saved = candidate + 1;\n        candidate *= 2;\n        candidate = saved - 2;\n        Turtle t = new Turtle(candidate, saved);\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI2RemainderSplit',
    title: '商と余りの座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int total = 11;\n        int x = total / 3;\n        int y = total % 3;\n        total -= x;\n        Turtle t = new Turtle(x, y);\n        t.左を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI2ConstructionSnapshot',
    title: '作った後の座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 2;\n        int y = 1;\n        Turtle t = new Turtle(x, y);\n        x += 2;\n        y = x;\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI2DependencyDiamond',
    title: '合流する計算',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int base = 2;\n        int left = base + 1;\n        int right = base * 2;\n        int x = right - left;\n        int y = right / base;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI2SequentialAssignment',
    title: '順に代入する座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 1;\n        int y = 3;\n        x = y - 1;\n        y = x + 1;\n        Turtle t = new Turtle(x, y);\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.左を向く();\n    }\n}',
  },
  {
    id: 'challengeI2DivisionTiming',
    title: '割る順番',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int n = 5;\n        int x = n / 2;\n        x += 1;\n        int y = (n + 1) / 2;\n        Turtle t = new Turtle(x, y);\n        t.左を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI2CompoundDependency',
    title: '更新した値を使う',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int x = 1;\n        int y = 6;\n        x += 2;\n        y -= x;\n        x--;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI2RetainedHistory',
    title: '戻した値と保存した値',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int value = 1;\n        value += 3;\n        int saved = value;\n        value -= 3;\n        Turtle t = new Turtle(value, saved);\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
];
