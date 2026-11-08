import type { ChallengeBase } from '../types';

export const lecture7: ChallengeBase[] = [
  {
    id: 'challengeII7ValidateBeforeMove',
    title: '進む前の例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            advance(t, -1);
            t.左を向く();
        } catch (RuntimeException e) {
            t.右を向く();
            t.前に進む();
        }
        advance(t, 2);
        t.左を向く();
        t.前に進む();
    }
    static void advance(Turtle t, int count) {
        if (count < 0) {
            throw new RuntimeException();
        }
        for (int i = 0; i < count; i++) {
            t.前に進む();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition5Helper',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i @[<]@ count; i++) {`,
      },
      {
        id: 'Update3',
        before: `            advance(t, -1);`,
        after: `            advance(t, @[-]@1);`,
      },
      {
        id: 'Action6',
        before: `            t.右を向く();`,
        after: `            t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition5Helper',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i <= count; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Update3',
        before: `            advance(t, -1);`,
        after: `            advance(t, +1);`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `            t.右を向く();`,
        after: `            t.前に進む();`,
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
        Turtle t = new Turtle(2, 2);
        try {
            risky(t, 0);
            t.後に戻る();
        } catch (RuntimeException e) {
            t.右を向く();
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
        t.後に戻る();
        t.右を向く();
    }
    static void risky(Turtle t, int count) {
        t.前に進む();
        if (count == 0) {
            throw new RuntimeException();
        }
        t.左を向く();
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
        before: `            risky(t, 0);`,
        after: `            risky(t, @[0]@);`,
      },
      {
        id: 'Action6',
        before: `            t.右を向く();`,
        after: `            t.@[右を向く]@();`,
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
        before: `            risky(t, 0);`,
        after: `            risky(t, 1);`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `            t.右を向く();`,
        after: `            t.前に進む();`,
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
        Turtle t = new Turtle(2, 2);
        int remaining = 1;
        try {
            t.前に進む();
            remaining--;
            reject(remaining);
            t.左を向く();
            t.前に進む();
        } catch (RuntimeException e) {
            t.右を向く();
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
        t.後に戻る();
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
        before: `        int remaining = 1;`,
        after: `        int remaining = @[1]@;`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int remaining = 1;
        try {
            t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int remaining = 1;
        try {
            t.@[前に進む]@();`,
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
        before: `        int remaining = 1;`,
        after: `        int remaining = 2;`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int remaining = 1;
        try {
            t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int remaining = 1;
        try {
            t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        visit(t, 0);
        t.前に進む();
        visit(t, 1);
        t.右を向く();
        t.前に進む();
    }
    static void visit(Turtle t, int value) {
        try {
            t.前に進む();
            if (value == 0) {
                throw new RuntimeException();
            }
            t.右を向く();
        } catch (RuntimeException e) {
            t.左を向く();
            t.後に戻る();
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
        before: `        visit(t, 0);`,
        after: `        visit(t, @[0]@);`,
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        visit(t, 0);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        visit(t, 0);
        t.@[前に進む]@();`,
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
        before: `        visit(t, 0);`,
        after: `        visit(t, 1);`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        visit(t, 0);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        visit(t, 0);
        t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        try {
            inner(t, 1);
            t.左を向く();
        } catch (RuntimeException e) {
            t.前に進む();
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
        t.後に戻る();
        t.右を向く();
    }
    static void inner(Turtle t, int n) {
        try {
            t.前に進む();
            if (n == 1) {
                throw new RuntimeException();
            }
        } catch (RuntimeException e) {
            t.右を向く();
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
        before: `            inner(t, 1);`,
        after: `            inner(t, @[1]@);`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            inner(t, 1);
            t.左を向く();
        } catch (RuntimeException e) {
            t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            inner(t, 1);
            t.左を向く();
        } catch (RuntimeException e) {
            t.@[前に進む]@();`,
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
        before: `            inner(t, 1);`,
        after: `            inner(t, 2);`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            inner(t, 1);
            t.左を向く();
        } catch (RuntimeException e) {
            t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            inner(t, 1);
            t.左を向く();
        } catch (RuntimeException e) {
            t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        try {
            request(t, 1);
            request(t, 0);
            t.後に戻る();
        } catch (EmptyRequest e) {
            t.右を向く();
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
    static void request(Turtle t, int amount) {
        if (amount == 0) {
            throw new EmptyRequest();
        }
        t.前に進む();
        t.前に進む();
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
        before: `            request(t, 1);`,
        after: `            request(t, @[1]@);`,
      },
      {
        id: 'Value4',
        before: `            request(t, 0);`,
        after: `            request(t, @[0]@);`,
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
        before: `            request(t, 1);`,
        after: `            request(t, 0);`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `            request(t, 0);`,
        after: `            request(t, 1);`,
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
        Turtle t = new Turtle(2, 2);
        int remaining = 1;
        try {
            for (int i = 0; i < 3; i++) {
                check(remaining);
                t.前に進む();
                remaining--;
            }
        } catch (NoBudget e) {
            t.右を向く();
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
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
        before: `            for (int i = 0; i < 3; i++) {`,
        after: `            for (int i = 0; i @[<]@ 3; i++) {`,
      },
      {
        id: 'Condition2Helper',
        before: `        if (remaining <= 0) {`,
        after: `        if (remaining @[<=]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = 1;`,
        after: `        int remaining = @[1]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `            for (int i = 0; i < 3; i++) {`,
        after: `            for (int i = 0; i > 3; i++) {`,
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
        before: `        int remaining = 1;`,
        after: `        int remaining = 2;`,
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
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 3; i++) {
            try {
                check(i);
                t.前に進む();
            } catch (SkippedVisit e) {
                t.右を向く();
            }
        }
        t.前に進む();
        t.左を向く();
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
        before: `        for (int i = 0; i < 3; i++) {`,
        after: `        for (int i = 0; i @[<]@ 3; i++) {`,
      },
      {
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n @[==]@ 1) {`,
      },
      {
        id: 'Action5',
        before: `                t.前に進む();`,
        after: `                t.@[前に進む]@();`,
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
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `                t.前に進む();`,
        after: `                t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        try {
            for (int i = 0; i < 4; i++) {
                t.前に進む();
                check(i);
            }
        } catch (RouteFinished e) {
            t.右を向く();
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
        t.後に戻る();
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
        before: `            for (int i = 0; i < 4; i++) {`,
        after: `            for (int i = 0; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Condition2Helper',
        before: `        if (n == 1) {`,
        after: `        if (n @[==]@ 1) {`,
      },
      {
        id: 'Action4',
        before: `                t.前に進む();`,
        after: `                t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `            for (int i = 0; i < 4; i++) {`,
        after: `            for (int i = 0; i > 4; i++) {`,
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
        before: `                t.前に進む();`,
        after: `                t.後に戻る();`,
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
        Turtle t = new Turtle(2, 2);
        try {
            convert(t, 0);
            t.後に戻る();
        } catch (RouteAlert e) {
            t.前に進む();
            t.左を向く();
            t.前に進む();
        }
        t.後に戻る();
        t.右を向く();
        t.前に進む();
    }
    static void convert(Turtle t, int n) {
        try {
            t.前に進む();
            if (n == 0) {
                throw new RuntimeException();
            }
        } catch (RuntimeException e) {
            t.右を向く();
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
        before: `            convert(t, 0);`,
        after: `            convert(t, @[0]@);`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            convert(t, 0);
            t.後に戻る();
        } catch (RouteAlert e) {
            t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            convert(t, 0);
            t.後に戻る();
        } catch (RouteAlert e) {
            t.@[前に進む]@();`,
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
        before: `            convert(t, 0);`,
        after: `            convert(t, 1);`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            convert(t, 0);
            t.後に戻る();
        } catch (RouteAlert e) {
            t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        try {
            convert(t, 0);
            t.後に戻る();
        } catch (RouteAlert e) {
            t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
];
