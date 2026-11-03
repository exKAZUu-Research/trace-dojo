import type { ChallengeBase } from '../types';

export const lecture7: ChallengeBase[] = [
  {
    id: 'challengeII7ValidateBeforeMove',
    title: '進む前の例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            advance(t, -1); // caller
            t.左を向く(); // step
        } catch (RuntimeException e) {
            t.右を向く(); // step
            t.前に進む(); // step
        }
        advance(t, 2); // caller
        t.左を向く(); // step
        t.前に進む(); // step
    }
    static void advance(Turtle t, int count) {
        if (count < 0) {
            throw new RuntimeException();
        }
        for (int i = 0; i < count; i++) { // step
            t.前に進む(); // step
        }
    }
}`,
    blanks: [
      {
        id: 'Condition5Helper',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ count; i++) { // step`,
      },
      {
        id: 'Update3',
        before: `            advance(t, -1); // caller`,
        after: `            advance(t, @[-]@1); // caller`,
      },
      {
        id: 'Action6',
        before: `            t.右を向く(); // step`,
        after: `            t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition5Helper',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i <= count; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Update3',
        before: `            advance(t, -1); // caller`,
        after: `            advance(t, +1); // caller`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `            t.右を向く(); // step`,
        after: `            t.前に進む(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7PartialProgress',
    title: '途中まで進んだ後の例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            risky(t, 0); // caller
            t.後に戻る(); // step
        } catch (RuntimeException e) {
            t.右を向く(); // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
    }
    static void risky(Turtle t, int count) {
        t.前に進む(); // step
        if (count == 0) {
            throw new RuntimeException();
        }
        t.左を向く(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3Helper',
        before: `        if (count == 0) {`,
        after: `        if (count @[==]@ 0) {`,
      },
      {
        id: 'Value3',
        before: `            risky(t, 0); // caller`,
        after: `            risky(t, @[0]@); // caller`,
      },
      {
        id: 'Action6',
        before: `            t.右を向く(); // step`,
        after: `            t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3Helper',
        before: `        if (count == 0) {`,
        after: `        if (count != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            risky(t, 0); // caller`,
        after: `            risky(t, 1); // caller`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `            t.右を向く(); // step`,
        after: `            t.前に進む(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7SkippedTrySuffix',
    title: '実行されないtryの続き',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int remaining = 1; // step
        try {
            t.前に進む(); // step
            remaining--; // step
            reject(remaining); // caller
            t.左を向く(); // step
            t.前に進む(); // step
        } catch (RuntimeException e) {
            t.右を向く(); // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
    static void reject(int value) {
        if (value == 0) {
            throw new RuntimeException();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition2Helper',
        before: `        if (value == 0) {`,
        after: `        if (value @[==]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = 1; // step`,
        after: `        int remaining = @[1]@; // step`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int remaining = 1; // step
        try {
            t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int remaining = 1; // step
        try {
            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2Helper',
        before: `        if (value == 0) {`,
        after: `        if (value != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int remaining = 1; // step`,
        after: `        int remaining = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int remaining = 1; // step
        try {
            t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int remaining = 1; // step
        try {
            t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7LocalRecovery',
    title: 'メソッド内で回復する',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        visit(t, 0); // caller
        t.前に進む(); // step
        visit(t, 1); // caller
        t.右を向く(); // step
        t.前に進む(); // step
    }
    static void visit(Turtle t, int value) {
        try {
            t.前に進む(); // step
            if (value == 0) {
                throw new RuntimeException();
            }
            t.右を向く(); // step
        } catch (RuntimeException e) {
            t.左を向く(); // step
            t.後に戻る(); // step
        }
    }
}`,
    blanks: [
      {
        id: 'Condition4Helper',
        before: `            if (value == 0) {`,
        after: `            if (value @[==]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        visit(t, 0); // caller`,
        after: `        visit(t, @[0]@); // caller`,
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        visit(t, 0); // caller
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        visit(t, 0); // caller
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4Helper',
        before: `            if (value == 0) {`,
        after: `            if (value != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        visit(t, 0); // caller`,
        after: `        visit(t, 1); // caller`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        visit(t, 0); // caller
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        visit(t, 0); // caller
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7RethrowHeading',
    title: '向きを変えて投げ直す',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            inner(t, 1); // caller
            t.左を向く(); // step
        } catch (RuntimeException e) {
            t.前に進む(); // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
    }
    static void inner(Turtle t, int n) {
        try {
            t.前に進む(); // step
            if (n == 1) {
                throw new RuntimeException();
            }
        } catch (RuntimeException e) {
            t.右を向く(); // step
            throw e;
        }
    }
}`,
    blanks: [
      {
        id: 'Condition4Helper',
        before: `            if (n == 1) {`,
        after: `            if (n @[==]@ 1) {`,
      },
      {
        id: 'Value3',
        before: `            inner(t, 1); // caller`,
        after: `            inner(t, @[1]@); // caller`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            inner(t, 1); // caller
            t.左を向く(); // step
        } catch (RuntimeException e) {
            t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            inner(t, 1); // caller
            t.左を向く(); // step
        } catch (RuntimeException e) {
            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4Helper',
        before: `            if (n == 1) {`,
        after: `            if (n != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            inner(t, 1); // caller`,
        after: `            inner(t, 2); // caller`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            inner(t, 1); // caller
            t.左を向く(); // step
        } catch (RuntimeException e) {
            t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            inner(t, 1); // caller
            t.左を向く(); // step
        } catch (RuntimeException e) {
            t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7SecondRequestRejected',
    title: '二度目の依頼で例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            request(t, 1); // caller
            request(t, 0); // caller
            t.後に戻る(); // step
        } catch (EmptyRequest e) {
            t.右を向く(); // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
    static void request(Turtle t, int amount) {
        if (amount == 0) {
            throw new EmptyRequest();
        }
        t.前に進む(); // step
        t.前に進む(); // step
    }
}
class EmptyRequest extends RuntimeException {}`,
    blanks: [
      {
        id: 'Condition2Helper',
        before: `        if (amount == 0) {`,
        after: `        if (amount @[==]@ 0) {`,
      },
      {
        id: 'Value3',
        before: `            request(t, 1); // caller`,
        after: `            request(t, @[1]@); // caller`,
      },
      {
        id: 'Value4',
        before: `            request(t, 0); // caller`,
        after: `            request(t, @[0]@); // caller`,
      },
    ],
    bugs: [
      {
        id: 'Condition2Helper',
        before: `        if (amount == 0) {`,
        after: `        if (amount != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            request(t, 1); // caller`,
        after: `            request(t, 0); // caller`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `            request(t, 0); // caller`,
        after: `            request(t, 1); // caller`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7BudgetException',
    title: '残りがなくなった例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int remaining = 1; // step
        try {
            for (int i = 0; i < 3; i++) { // step
                check(remaining); // caller
                t.前に進む(); // step
                remaining--; // step
            }
        } catch (NoBudget e) {
            t.右を向く(); // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
    }
    static void check(int remaining) {
        if (remaining <= 0) {
            throw new NoBudget();
        }
    }
}
class NoBudget extends RuntimeException {}`,
    blanks: [
      {
        id: 'Condition4',
        before: `            for (int i = 0; i < 3; i++) { // step`,
        after: `            for (int i = 0; i @[<]@ 3; i++) { // step`,
      },
      {
        id: 'Condition2Helper',
        before: `        if (remaining <= 0) {`,
        after: `        if (remaining @[<=]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = 1; // step`,
        after: `        int remaining = @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `            for (int i = 0; i < 3; i++) { // step`,
        after: `            for (int i = 0; i > 3; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition2Helper',
        before: `        if (remaining <= 0) {`,
        after: `        if (remaining < 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int remaining = 1; // step`,
        after: `        int remaining = 2; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7CatchEachIteration',
    title: '各回の例外を受け止める',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        for (int i = 0; i < 3; i++) { // step
            try {
                check(i); // caller
                t.前に進む(); // step
            } catch (SkippedVisit e) {
                t.右を向く(); // step
            }
        }
        t.前に進む(); // step
        t.左を向く(); // step
    }
    static void check(int n) {
        if (n == 1) {
            throw new SkippedVisit();
        }
    }
}
class SkippedVisit extends RuntimeException {}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ 3; i++) { // step`,
      },
      {
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n @[==]@ 1) {`,
      },
      {
        id: 'Action5',
        before: `                t.前に進む(); // step`,
        after: `                t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 3; i++) { // step`,
        after: `        for (int i = 0; i <= 3; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `                t.前に進む(); // step`,
        after: `                t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII7CatchWholeLoop',
    title: 'ループ全体から抜ける例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            for (int i = 0; i < 4; i++) { // step
                t.前に進む(); // step
                check(i); // caller
            }
        } catch (RouteFinished e) {
            t.右を向く(); // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
    static void check(int n) {
        if (n == 1) {
            throw new RouteFinished();
        }
    }
}
class RouteFinished extends RuntimeException {}`,
    blanks: [
      {
        id: 'Condition3',
        before: `            for (int i = 0; i < 4; i++) { // step`,
        after: `            for (int i = 0; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n @[==]@ 1) {`,
      },
      {
        id: 'Action4',
        before: `                t.前に進む(); // step`,
        after: `                t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `            for (int i = 0; i < 4; i++) { // step`,
        after: `            for (int i = 0; i > 4; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n != 1) {`,
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
    id: 'challengeII7TranslatedException',
    title: '例外を別の種類に変える',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            convert(t, 0); // caller
            t.後に戻る(); // step
        } catch (RouteAlert e) {
            t.前に進む(); // step
            t.左を向く(); // step
            t.前に進む(); // step
        }
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
    static void convert(Turtle t, int n) {
        try {
            t.前に進む(); // step
            if (n == 0) {
                throw new RuntimeException();
            }
        } catch (RuntimeException e) {
            t.右を向く(); // step
            throw new RouteAlert();
        }
    }
}
class RouteAlert extends RuntimeException {}`,
    blanks: [
      {
        id: 'Condition4Helper',
        before: `            if (n == 0) {`,
        after: `            if (n @[==]@ 0) {`,
      },
      {
        id: 'Value3',
        before: `            convert(t, 0); // caller`,
        after: `            convert(t, @[0]@); // caller`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            convert(t, 0); // caller
            t.後に戻る(); // step
        } catch (RouteAlert e) {
            t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            convert(t, 0); // caller
            t.後に戻る(); // step
        } catch (RouteAlert e) {
            t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4Helper',
        before: `            if (n == 0) {`,
        after: `            if (n != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            convert(t, 0); // caller`,
        after: `            convert(t, 1); // caller`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            convert(t, 0); // caller
            t.後に戻る(); // step
        } catch (RouteAlert e) {
            t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        try {
            convert(t, 0); // caller
            t.後に戻る(); // step
        } catch (RouteAlert e) {
            t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
];
