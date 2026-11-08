import type { CorrectProblem } from '../types';

export const lecture7: CorrectProblem[] = [
  {
    id: 'challengeII7ValidateBeforeMove',
    title: '進む前の例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        try {\n            advance(t, -1);\n            t.左を向く();\n        } catch (RuntimeException e) {\n            t.右を向く();\n            t.前に進む();\n        }\n        advance(t, 2);\n        t.左を向く();\n        t.前に進む();\n    }\n    static void advance(Turtle t, int count) {\n        if (count < 0) {\n            throw new RuntimeException();\n        }\n        for (int i = 0; i < count; i++) {\n            t.前に進む();\n        }\n    }\n}',
  },
  {
    id: 'challengeII7PartialProgress',
    title: '途中まで進んだ後の例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        try {\n            risky(t, 0);\n            t.後に戻る();\n        } catch (RuntimeException e) {\n            t.右を向く();\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n        t.右を向く();\n    }\n    static void risky(Turtle t, int count) {\n        t.前に進む();\n        if (count == 0) {\n            throw new RuntimeException();\n        }\n        t.左を向く();\n    }\n}',
  },
  {
    id: 'challengeII7SkippedTrySuffix',
    title: '実行されないtryの続き',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int remaining = 1;\n        try {\n            t.前に進む();\n            remaining--;\n            reject(remaining);\n            t.左を向く();\n            t.前に進む();\n        } catch (RuntimeException e) {\n            t.右を向く();\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n    static void reject(int value) {\n        if (value == 0) {\n            throw new RuntimeException();\n        }\n    }\n}',
  },
  {
    id: 'challengeII7LocalRecovery',
    title: 'メソッド内で回復する',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        visit(t, 0);\n        t.前に進む();\n        visit(t, 1);\n        t.右を向く();\n        t.前に進む();\n    }\n    static void visit(Turtle t, int value) {\n        try {\n            t.前に進む();\n            if (value == 0) {\n                throw new RuntimeException();\n            }\n            t.右を向く();\n        } catch (RuntimeException e) {\n            t.左を向く();\n            t.後に戻る();\n        }\n    }\n}',
  },
  {
    id: 'challengeII7RethrowHeading',
    title: '向きを変えて投げ直す',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        try {\n            inner(t, 1);\n            t.左を向く();\n        } catch (RuntimeException e) {\n            t.前に進む();\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n        t.右を向く();\n    }\n    static void inner(Turtle t, int n) {\n        try {\n            t.前に進む();\n            if (n == 1) {\n                throw new RuntimeException();\n            }\n        } catch (RuntimeException e) {\n            t.右を向く();\n            throw e;\n        }\n    }\n}',
  },
  {
    id: 'challengeII7SecondRequestRejected',
    title: '二度目の依頼で例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        try {\n            request(t, 1);\n            request(t, 0);\n            t.後に戻る();\n        } catch (EmptyRequest e) {\n            t.右を向く();\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n    static void request(Turtle t, int amount) {\n        if (amount == 0) {\n            throw new EmptyRequest();\n        }\n        t.前に進む();\n        t.前に進む();\n    }\n}\nclass EmptyRequest extends RuntimeException {}',
  },
  {
    id: 'challengeII7BudgetException',
    title: '残りがなくなった例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int remaining = 1;\n        try {\n            for (int i = 0; i < 3; i++) {\n                check(remaining);\n                t.前に進む();\n                remaining--;\n            }\n        } catch (NoBudget e) {\n            t.右を向く();\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n    }\n    static void check(int remaining) {\n        if (remaining <= 0) {\n            throw new NoBudget();\n        }\n    }\n}\nclass NoBudget extends RuntimeException {}',
  },
  {
    id: 'challengeII7CatchEachIteration',
    title: '各回の例外を受け止める',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        for (int i = 0; i < 3; i++) {\n            try {\n                check(i);\n                t.前に進む();\n            } catch (SkippedVisit e) {\n                t.右を向く();\n            }\n        }\n        t.前に進む();\n        t.左を向く();\n    }\n    static void check(int n) {\n        if (n == 1) {\n            throw new SkippedVisit();\n        }\n    }\n}\nclass SkippedVisit extends RuntimeException {}',
  },
  {
    id: 'challengeII7CatchWholeLoop',
    title: 'ループ全体から抜ける例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        try {\n            for (int i = 0; i < 4; i++) {\n                t.前に進む();\n                check(i);\n            }\n        } catch (RouteFinished e) {\n            t.右を向く();\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n    static void check(int n) {\n        if (n == 1) {\n            throw new RouteFinished();\n        }\n    }\n}\nclass RouteFinished extends RuntimeException {}',
  },
  {
    id: 'challengeII7TranslatedException',
    title: '例外を別の種類に変える',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        try {\n            convert(t, 0);\n            t.後に戻る();\n        } catch (RouteAlert e) {\n            t.前に進む();\n            t.左を向く();\n            t.前に進む();\n        }\n        t.後に戻る();\n        t.右を向く();\n        t.前に進む();\n    }\n    static void convert(Turtle t, int n) {\n        try {\n            t.前に進む();\n            if (n == 0) {\n                throw new RuntimeException();\n            }\n        } catch (RuntimeException e) {\n            t.右を向く();\n            throw new RouteAlert();\n        }\n    }\n}\nclass RouteAlert extends RuntimeException {}',
  },
];
