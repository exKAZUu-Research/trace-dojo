import type { ChallengeBase } from '../types';

export const lecture7: ChallengeBase[] = [
  {
    id: 'challengeI7ValueSnapshot',
    title: '引数に渡した値',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int n = 1;
        advance(t, n);
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
        t.右を向く();
        t.前に進む();
    }
    static void advance(Turtle t, int n) {
        n++;
        for (int j = 0; j < n; j++) {
            t.前に進む();
        }
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < n; i++) {`,
        after: `        for (int i = 0; i @[<]@ n; i++) {`,
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < n; j++) {`,
        after: `        for (int j = 0; j @[<]@ n; j++) {`,
      },
      {
        id: 'Value2',
        before: `        int n = 1;`,
        after: `        int n = @[1]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < n; i++) {`,
        after: `        for (int i = 0; i <= n; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < n; j++) {`,
        after: `        for (int j = 0; j <= n; j++) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 1;`,
        after: `        int n = 2;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7ObjectMutation',
    title: '渡した亀の向き',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();
    }
    static void corner(Turtle t) {
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.@[前に進む]@();`,
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.@[後に戻る]@();`,
      },
      {
        id: 'Action2Helper',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();
    }
    static void corner(Turtle t) {
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();
    }
    static void corner(Turtle t) {
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Action2Helper',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();
    }
    static void corner(Turtle t) {
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        corner(t);
        t.前に進む();
        corner(t);
        t.後に戻る();
    }
    static void corner(Turtle t) {
        t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7ReturnedBudget',
    title: '返された残り',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int remaining = consume(t, 3);
        t.右を向く();
        for (int i = 0; i < remaining; i++) {
            t.前に進む();
        }
    }
    static int consume(Turtle t, int budget) {
        t.前に進む();
        budget--;
        return budget;
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < remaining; i++) {`,
        after: `        for (int i = 0; i @[<]@ remaining; i++) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = consume(t, 3);`,
        after: `        int remaining = consume(t, @[3]@);`,
      },
      {
        id: 'Action3',
        before: `        t.右を向く();`,
        after: `        t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < remaining; i++) {`,
        after: `        for (int i = 0; i <= remaining; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int remaining = consume(t, 3);`,
        after: `        int remaining = consume(t, 4);`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `        t.右を向く();`,
        after: `        t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7EarlyReturnGuard',
    title: 'すぐ戻る呼び出し',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        guarded(t, 0);
        t.右を向く();
        guarded(t, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
    static void guarded(Turtle t, int enabled) {
        if (enabled == 0) {
            return;
        }
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2Helper',
        before: `        if (enabled == 0) {`,
        after: `        if (enabled @[==]@ 0) {`,
      },
      {
        id: 'Action3',
        before: `        t.右を向く();`,
        after: `        t.@[右を向く]@();`,
      },
      {
        id: 'Value4',
        before: `        guarded(t, 1);`,
        after: `        guarded(t, @[1]@);`,
      },
    ],
    bugs: [
      {
        id: 'Condition2Helper',
        before: `        if (enabled == 0) {`,
        after: `        if (enabled != 0) {`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `        t.右を向く();`,
        after: `        t.前に進む();`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        guarded(t, 1);`,
        after: `        guarded(t, 0);`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7ArgumentOrder',
    title: '二つの引数の順番',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2);
        int y = difference(x, 1);
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
    static int difference(int left, int right) {
        int result = left - right;
        return result;
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = difference(5, 2);`,
        after: `        int x = difference(@[5]@, 2);`,
      },
      {
        id: 'Value2',
        before: `        int y = difference(x, 1);`,
        after: `        int y = difference(x, @[1]@);`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2);
        int y = difference(x, 1);
        Turtle t = new Turtle(x, y);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2);
        int y = difference(x, 1);
        Turtle t = new Turtle(x, y);
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = difference(5, 2);`,
        after: `        int x = difference(6, 2);`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = difference(x, 1);`,
        after: `        int y = difference(x, 2);`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2);
        int y = difference(x, 1);
        Turtle t = new Turtle(x, y);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2);
        int y = difference(x, 1);
        Turtle t = new Turtle(x, y);
        t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7NestedComposition',
    title: '戻り値を次の呼び出しへ',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        travel(t, 3);
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
    static void travel(Turtle t, int request) {
        int count = reduce(request);
        for (int i = 0; i < count; i++) {
            t.前に進む();
        }
    }
    static int reduce(int n) {
        return n - 1;
    }
}`,
    blanks: [
      {
        id: 'Condition3Helper',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i @[<]@ count; i++) {`,
      },
      {
        id: 'Update8Helper',
        before: `        return n - 1;`,
        after: `        return n @[-]@ 1;`,
      },
      {
        id: 'Value2',
        before: `        travel(t, 3);`,
        after: `        travel(t, @[3]@);`,
      },
    ],
    bugs: [
      {
        id: 'Condition3Helper',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i <= count; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Update8Helper',
        before: `        return n - 1;`,
        after: `        return n + 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        travel(t, 3);`,
        after: `        travel(t, 4);`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7ReturnSkipsSuffix',
    title: '途中で戻るメソッド',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        visit(t, 1);
        t.右を向く();
        visit(t, 2);
        t.前に進む();
        t.左を向く();
    }
    static void visit(Turtle t, int n) {
        t.前に進む();
        if (n == 1) {
            return;
        }
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Condition3Helper',
        before: `        if (n == 1) {`,
        after: `        if (n @[==]@ 1) {`,
      },
      {
        id: 'Value2',
        before: `        visit(t, 1);`,
        after: `        visit(t, @[1]@);`,
      },
      {
        id: 'Action3',
        before: `        t.右を向く();`,
        after: `        t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition3Helper',
        before: `        if (n == 1) {`,
        after: `        if (n != 1) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        visit(t, 1);`,
        after: `        visit(t, 2);`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `        t.右を向く();`,
        after: `        t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7LocalShadow',
    title: '同じ名前の別の変数',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int count = 1;
        localWalk(t);
        t.右を向く();
        for (int i = 0; i < count; i++) {
            t.前に進む();
        }
    }
    static void localWalk(Turtle t) {
        int count = 2;
        for (int j = 0; j < count; j++) {
            t.前に進む();
        }
        count = 0;
    }
}`,
    blanks: [
      {
        id: 'Condition5',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i @[<]@ count; i++) {`,
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < count; j++) {`,
        after: `        for (int j = 0; j @[<]@ count; j++) {`,
      },
      {
        id: 'Value2',
        before: `        int count = 1;`,
        after: `        int count = @[1]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition5',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i <= count; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < count; j++) {`,
        after: `        for (int j = 0; j <= count; j++) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int count = 1;`,
        after: `        int count = 2;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7PredicateAction',
    title: '判定を返すメソッド',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 1; i < 4; i++) {
            boolean turn = reaches(i, 2);
            if (turn) {
                t.右を向く();
            } else {
                t.前に進む();
            }
        }
        t.後に戻る();
    }
    static boolean reaches(int value, int target) {
        return value == target;
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = 1; i @[<]@ 4; i++) {`,
      },
      {
        id: 'Condition2Helper',
        before: `        return value == target;`,
        after: `        return value @[==]@ target;`,
      },
      {
        id: 'Value3',
        before: `            boolean turn = reaches(i, 2);`,
        after: `            boolean turn = reaches(i, @[2]@);`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 4; i++) {`,
        after: `        for (int i = 1; i <= 4; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition2Helper',
        before: `        return value == target;`,
        after: `        return value != target;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            boolean turn = reaches(i, 2);`,
        after: `            boolean turn = reaches(i, 3);`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI7CarriedReturn',
    title: '戻り値をもう一度渡す',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int count = next(1);
        count = next(count);
        for (int i = 0; i < count; i++) {
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
    }
    static int next(int n) {
        int result = n + 1;
        return result;
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i @[<]@ count; i++) {`,
      },
      {
        id: 'Update2Helper',
        before: `        int result = n + 1;`,
        after: `        int result = n @[+]@ 1;`,
      },
      {
        id: 'Value2',
        before: `        int count = next(1);`,
        after: `        int count = next(@[1]@);`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < count; i++) {`,
        after: `        for (int i = 0; i <= count; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Update2Helper',
        before: `        int result = n + 1;`,
        after: `        int result = n - 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int count = next(1);`,
        after: `        int count = next(2);`,
        kind: 'logical',
      },
    ],
  },
];
