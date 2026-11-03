import type { ChallengeBase } from '../types';

export const lecture2: ChallengeBase[] = [
  {
    id: 'challengeI2SnapshotCoordinates',
    title: '写してから変える座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += @[2]@; // step`,
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = x; // step
        x += 2; // step
        Turtle t = new Turtle(x, y); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2CoordinateExchange',
    title: '座標を入れ替える',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = @[3]@; // step`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        Turtle t = new Turtle(x, y); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2OverwrittenCandidate',
    title: '残された候補',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int candidate = 2; // step
        int saved = candidate + 1; // step
        candidate *= 2; // step
        candidate = saved - 2; // step
        Turtle t = new Turtle(candidate, saved); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Update4',
        before: `        candidate = saved - 2; // step`,
        after: `        candidate = saved @[-]@ 2; // step`,
      },
      {
        id: 'Value1',
        before: `        int candidate = 2; // step`,
        after: `        int candidate = @[2]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int saved = candidate + 1; // step`,
        after: `        int saved = candidate + @[1]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update4',
        before: `        candidate = saved - 2; // step`,
        after: `        candidate = saved + 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int candidate = 2; // step`,
        after: `        int candidate = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int saved = candidate + 1; // step`,
        after: `        int saved = candidate + 2; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2RemainderSplit',
    title: '商と余りの座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int total = 11; // step
        int x = total / 3; // step
        int y = total % 3; // step
        total -= x; // step
        Turtle t = new Turtle(x, y); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int total = 11; // step`,
        after: `        int total = @[11]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int x = total / 3; // step`,
        after: `        int x = total / @[3]@; // step`,
      },
      {
        id: 'Value3',
        before: `        int y = total % 3; // step`,
        after: `        int y = total % @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int total = 11; // step`,
        after: `        int total = 12; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = total / 3; // step`,
        after: `        int x = total / 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int y = total % 3; // step`,
        after: `        int y = total % 4; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2ConstructionSnapshot',
    title: '作った後の座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 2; // step`,
        after: `        int x = @[2]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 1; // step`,
        after: `        int y = @[1]@; // step`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.@[前に進む]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 2; // step`,
        after: `        int x = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 1; // step`,
        after: `        int y = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 2; // step
        int y = 1; // step
        Turtle t = new Turtle(x, y); // step
        x += 2; // step
        y = x; // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2DependencyDiamond',
    title: '合流する計算',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int base = 2; // step
        int left = base + 1; // step
        int right = base * 2; // step
        int x = right - left; // step
        int y = right / base; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Update2',
        before: `        int left = base + 1; // step`,
        after: `        int left = base @[+]@ 1; // step`,
      },
      {
        id: 'Value1',
        before: `        int base = 2; // step`,
        after: `        int base = @[2]@; // step`,
      },
      {
        id: 'Value3',
        before: `        int right = base * 2; // step`,
        after: `        int right = base * @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update2',
        before: `        int left = base + 1; // step`,
        after: `        int left = base - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int base = 2; // step`,
        after: `        int base = 3; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int right = base * 2; // step`,
        after: `        int right = base * 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2SequentialAssignment',
    title: '順に代入する座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        x = y - 1; // step
        y = x + 1; // step
        Turtle t = new Turtle(x, y); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
    }
}`,
    blanks: [
      {
        id: 'Update3',
        before: `        x = y - 1; // step`,
        after: `        x = y @[-]@ 1; // step`,
      },
      {
        id: 'Update4',
        before: `        y = x + 1; // step`,
        after: `        y = x @[+]@ 1; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        x = y - 1; // step`,
        after: `        x = y + 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Update4',
        before: `        y = x + 1; // step`,
        after: `        y = x - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 3; // step`,
        after: `        int y = 4; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2DivisionTiming',
    title: '割る順番',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int n = 5; // step
        int x = n / 2; // step
        x += 1; // step
        int y = (n + 1) / 2; // step
        Turtle t = new Turtle(x, y); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Update3',
        before: `        x += 1; // step`,
        after: `        x @[+=]@ 1; // step`,
      },
      {
        id: 'Update4',
        before: `        int y = (n + 1) / 2; // step`,
        after: `        int y = (n @[+]@ 1) / 2; // step`,
      },
      {
        id: 'Value1',
        before: `        int n = 5; // step`,
        after: `        int n = @[5]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        x += 1; // step`,
        after: `        x -= 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Update4',
        before: `        int y = (n + 1) / 2; // step`,
        after: `        int y = (n - 1) / 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int n = 5; // step`,
        after: `        int n = 6; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2CompoundDependency',
    title: '更新した値を使う',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 6; // step
        x += 2; // step
        y -= x; // step
        x--; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = @[1]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int y = 6; // step`,
        after: `        int y = @[6]@; // step`,
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += @[2]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1; // step`,
        after: `        int x = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 6; // step`,
        after: `        int y = 7; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        x += 2; // step`,
        after: `        x += 3; // step`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI2RetainedHistory',
    title: '戻した値と保存した値',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int value = 1; // step
        value += 3; // step
        int saved = value; // step
        value -= 3; // step
        Turtle t = new Turtle(value, saved); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int value = 1; // step`,
        after: `        int value = @[1]@; // step`,
      },
      {
        id: 'Value2',
        before: `        value += 3; // step`,
        after: `        value += @[3]@; // step`,
      },
      {
        id: 'Value4',
        before: `        value -= 3; // step`,
        after: `        value -= @[3]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int value = 1; // step`,
        after: `        int value = 2; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        value += 3; // step`,
        after: `        value += 4; // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        value -= 3; // step`,
        after: `        value -= 4; // step`,
        kind: 'logical',
      },
    ],
  },
];
