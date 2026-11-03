import type { ChallengeBase } from '../types';

export const lecture7: ChallengeBase[] = [
  {
    id: 'challengeI7ValueSnapshot',
    title: '引数に渡した値',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        int n = 1; // step
        advance(t, n); // caller
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
    static void advance(Turtle t, int n) {
        n++; // step
        for (int j = 0; j < n; j++) { // step
            t.前に進む(); // step
        }
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < n; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ n; i++) { // step`,
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < n; j++) { // step`,
        after: `        for (int j = 0; j @[<]@ n; j++) { // step`,
      },
      {
        id: 'Value2',
        before: `        int n = 1; // step`,
        after: `        int n = @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < n; i++) { // step`,
        after: `        for (int i = 0; i <= n; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < n; j++) { // step`,
        after: `        for (int j = 0; j <= n; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 1; // step`,
        after: `        int n = 2; // step`,
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
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step
    }
    static void corner(Turtle t) {
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.@[後に戻る]@(); // step`,
      },
      {
        id: 'Action2Helper',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step
    }
    static void corner(Turtle t) {
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step
    }
    static void corner(Turtle t) {
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action2Helper',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step
    }
    static void corner(Turtle t) {
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        corner(t); // caller
        t.前に進む(); // step
        corner(t); // caller
        t.後に戻る(); // step
    }
    static void corner(Turtle t) {
        t.後に戻る(); // step`,
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
        Turtle t = new Turtle(2, 1); // step
        int remaining = consume(t, 3); // step // caller
        t.右を向く(); // step
        for (int i = 0; i < remaining; i++) { // step
            t.前に進む(); // step
        }
    }
    static int consume(Turtle t, int budget) {
        t.前に進む(); // step
        budget--; // step
        return budget;
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < remaining; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ remaining; i++) { // step`,
      },
      {
        id: 'Value2',
        before: `        int remaining = consume(t, 3); // step // caller`,
        after: `        int remaining = consume(t, @[3]@); // step // caller`,
      },
      {
        id: 'Action3',
        before: `        t.右を向く(); // step`,
        after: `        t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < remaining; i++) { // step`,
        after: `        for (int i = 0; i <= remaining; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int remaining = consume(t, 3); // step // caller`,
        after: `        int remaining = consume(t, 4); // step // caller`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `        t.右を向く(); // step`,
        after: `        t.前に進む(); // step`,
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
        Turtle t = new Turtle(2, 2); // step
        guarded(t, 0); // caller
        t.右を向く(); // step
        guarded(t, 1); // caller
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
    static void guarded(Turtle t, int enabled) {
        if (enabled == 0) {
            return;
        }
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
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
        before: `        t.右を向く(); // step`,
        after: `        t.@[右を向く]@(); // step`,
      },
      {
        id: 'Value4',
        before: `        guarded(t, 1); // caller`,
        after: `        guarded(t, @[1]@); // caller`,
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
        before: `        t.右を向く(); // step`,
        after: `        t.前に進む(); // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        guarded(t, 1); // caller`,
        after: `        guarded(t, 0); // caller`,
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
        int x = difference(5, 2); // step // caller
        int y = difference(x, 1); // step // caller
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
    static int difference(int left, int right) {
        int result = left - right; // step
        return result;
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = difference(5, 2); // step // caller`,
        after: `        int x = difference(@[5]@, 2); // step // caller`,
      },
      {
        id: 'Value2',
        before: `        int y = difference(x, 1); // step // caller`,
        after: `        int y = difference(x, @[1]@); // step // caller`,
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2); // step // caller
        int y = difference(x, 1); // step // caller
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2); // step // caller
        int y = difference(x, 1); // step // caller
        Turtle t = new Turtle(x, y); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = difference(5, 2); // step // caller`,
        after: `        int x = difference(6, 2); // step // caller`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = difference(x, 1); // step // caller`,
        after: `        int y = difference(x, 2); // step // caller`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2); // step // caller
        int y = difference(x, 1); // step // caller
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = difference(5, 2); // step // caller
        int y = difference(x, 1); // step // caller
        Turtle t = new Turtle(x, y); // step
        t.後に戻る(); // step`,
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
        Turtle t = new Turtle(2, 1); // step
        travel(t, 3); // caller
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
    static void travel(Turtle t, int request) {
        int count = reduce(request); // step // caller
        for (int i = 0; i < count; i++) { // step
            t.前に進む(); // step
        }
    }
    static int reduce(int n) {
        return n - 1;
    }
}`,
    blanks: [
      {
        id: 'Condition3Helper',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ count; i++) { // step`,
      },
      {
        id: 'Update8Helper',
        before: `        return n - 1;`,
        after: `        return n @[-]@ 1;`,
      },
      {
        id: 'Value2',
        before: `        travel(t, 3); // caller`,
        after: `        travel(t, @[3]@); // caller`,
      },
    ],
    bugs: [
      {
        id: 'Condition3Helper',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i <= count; i++) { // step`,
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
        before: `        travel(t, 3); // caller`,
        after: `        travel(t, 4); // caller`,
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
        Turtle t = new Turtle(2, 2); // step
        visit(t, 1); // caller
        t.右を向く(); // step
        visit(t, 2); // caller
        t.前に進む(); // step
        t.左を向く(); // step
    }
    static void visit(Turtle t, int n) {
        t.前に進む(); // step
        if (n == 1) {
            return;
        }
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
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
        before: `        visit(t, 1); // caller`,
        after: `        visit(t, @[1]@); // caller`,
      },
      {
        id: 'Action3',
        before: `        t.右を向く(); // step`,
        after: `        t.@[右を向く]@(); // step`,
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
        before: `        visit(t, 1); // caller`,
        after: `        visit(t, 2); // caller`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `        t.右を向く(); // step`,
        after: `        t.前に進む(); // step`,
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
        Turtle t = new Turtle(2, 1); // step
        int count = 1; // step
        localWalk(t); // caller
        t.右を向く(); // step
        for (int i = 0; i < count; i++) { // step
            t.前に進む(); // step
        }
    }
    static void localWalk(Turtle t) {
        int count = 2; // step
        for (int j = 0; j < count; j++) { // step
            t.前に進む(); // step
        }
        count = 0; // step
    }
}`,
    blanks: [
      {
        id: 'Condition5',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ count; i++) { // step`,
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < count; j++) { // step`,
        after: `        for (int j = 0; j @[<]@ count; j++) { // step`,
      },
      {
        id: 'Value2',
        before: `        int count = 1; // step`,
        after: `        int count = @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition5',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i <= count; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Condition3Helper',
        before: `        for (int j = 0; j < count; j++) { // step`,
        after: `        for (int j = 0; j <= count; j++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int count = 1; // step`,
        after: `        int count = 2; // step`,
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
        Turtle t = new Turtle(2, 2); // step
        for (int i = 1; i < 4; i++) { // step
            boolean turn = reaches(i, 2); // step // caller
            if (turn) {
                t.右を向く(); // step
            } else {
                t.前に進む(); // step
            }
        }
        t.後に戻る(); // step
    }
    static boolean reaches(int value, int target) {
        return value == target;
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = 1; i @[<]@ 4; i++) { // step`,
      },
      {
        id: 'Condition2Helper',
        before: `        return value == target;`,
        after: `        return value @[==]@ target;`,
      },
      {
        id: 'Value3',
        before: `            boolean turn = reaches(i, 2); // step // caller`,
        after: `            boolean turn = reaches(i, @[2]@); // step // caller`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 4; i++) { // step`,
        after: `        for (int i = 1; i <= 4; i++) { // step`,
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
        before: `            boolean turn = reaches(i, 2); // step // caller`,
        after: `            boolean turn = reaches(i, 3); // step // caller`,
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
        Turtle t = new Turtle(2, 1); // step
        int count = next(1); // step // caller
        count = next(count); // step // caller
        for (int i = 0; i < count; i++) { // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
    }
    static int next(int n) {
        int result = n + 1; // step
        return result;
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ count; i++) { // step`,
      },
      {
        id: 'Update2Helper',
        before: `        int result = n + 1; // step`,
        after: `        int result = n @[+]@ 1; // step`,
      },
      {
        id: 'Value2',
        before: `        int count = next(1); // step // caller`,
        after: `        int count = next(@[1]@); // step // caller`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < count; i++) { // step`,
        after: `        for (int i = 0; i <= count; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Update2Helper',
        before: `        int result = n + 1; // step`,
        after: `        int result = n - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int count = next(1); // step // caller`,
        after: `        int count = next(2); // step // caller`,
        kind: 'logical',
      },
    ],
  },
];
