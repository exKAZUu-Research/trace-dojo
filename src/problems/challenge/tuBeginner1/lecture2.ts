import type { ChallengeBase } from '../types';

export const lecture2: ChallengeBase[] = [
  {
    id: 'challengeI2SnapshotCoordinates',
    title: '写してから変える座標',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    java: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = x;
        x += 2;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = @[1]@;`,
      },
      {
        id: 'Value3',
        before: `        x += 2;`,
        after: `        x += @[2]@;`,
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = x;
        x += 2;
        Turtle t = new Turtle(x, y);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = x;
        x += 2;
        Turtle t = new Turtle(x, y);
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = 2;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        x += 2;`,
        after: `        x += 3;`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = x;
        x += 2;
        Turtle t = new Turtle(x, y);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = x;
        x += 2;
        Turtle t = new Turtle(x, y);
        t.後に戻る();`,
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
        int x = 1;
        int y = 3;
        int saved = x;
        x = y;
        y = saved;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = @[1]@;`,
      },
      {
        id: 'Value2',
        before: `        int y = 3;`,
        after: `        int y = @[3]@;`,
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = 3;
        int saved = x;
        x = y;
        y = saved;
        Turtle t = new Turtle(x, y);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = 3;
        int saved = x;
        x = y;
        y = saved;
        Turtle t = new Turtle(x, y);
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = 2;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 3;`,
        after: `        int y = 4;`,
        kind: 'logical',
      },
      {
        id: 'Action7',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = 3;
        int saved = x;
        x = y;
        y = saved;
        Turtle t = new Turtle(x, y);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        int y = 3;
        int saved = x;
        x = y;
        y = saved;
        Turtle t = new Turtle(x, y);
        t.後に戻る();`,
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
        int candidate = 2;
        int saved = candidate + 1;
        candidate *= 2;
        candidate = saved - 2;
        Turtle t = new Turtle(candidate, saved);
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Update4',
        before: `        candidate = saved - 2;`,
        after: `        candidate = saved @[-]@ 2;`,
      },
      {
        id: 'Value1',
        before: `        int candidate = 2;`,
        after: `        int candidate = @[2]@;`,
      },
      {
        id: 'Value2',
        before: `        int saved = candidate + 1;`,
        after: `        int saved = candidate + @[1]@;`,
      },
    ],
    bugs: [
      {
        id: 'Update4',
        before: `        candidate = saved - 2;`,
        after: `        candidate = saved + 2;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int candidate = 2;`,
        after: `        int candidate = 3;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int saved = candidate + 1;`,
        after: `        int saved = candidate + 2;`,
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
        int total = 11;
        int x = total / 3;
        int y = total % 3;
        total -= x;
        Turtle t = new Turtle(x, y);
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int total = 11;`,
        after: `        int total = @[11]@;`,
      },
      {
        id: 'Value2',
        before: `        int x = total / 3;`,
        after: `        int x = total / @[3]@;`,
      },
      {
        id: 'Value3',
        before: `        int y = total % 3;`,
        after: `        int y = total % @[3]@;`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int total = 11;`,
        after: `        int total = 12;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = total / 3;`,
        after: `        int x = total / 4;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int y = total % 3;`,
        after: `        int y = total % 4;`,
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
        int x = 2;
        int y = 1;
        Turtle t = new Turtle(x, y);
        x += 2;
        y = x;
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 2;`,
        after: `        int x = @[2]@;`,
      },
      {
        id: 'Value2',
        before: `        int y = 1;`,
        after: `        int y = @[1]@;`,
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 2;
        int y = 1;
        Turtle t = new Turtle(x, y);
        x += 2;
        y = x;
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 2;
        int y = 1;
        Turtle t = new Turtle(x, y);
        x += 2;
        y = x;
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 2;`,
        after: `        int x = 3;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 1;`,
        after: `        int y = 2;`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `public class Main {
    public static void main(String[] args) {
        int x = 2;
        int y = 1;
        Turtle t = new Turtle(x, y);
        x += 2;
        y = x;
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        int x = 2;
        int y = 1;
        Turtle t = new Turtle(x, y);
        x += 2;
        y = x;
        t.後に戻る();`,
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
        int base = 2;
        int left = base + 1;
        int right = base * 2;
        int x = right - left;
        int y = right / base;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Update2',
        before: `        int left = base + 1;`,
        after: `        int left = base @[+]@ 1;`,
      },
      {
        id: 'Value1',
        before: `        int base = 2;`,
        after: `        int base = @[2]@;`,
      },
      {
        id: 'Value3',
        before: `        int right = base * 2;`,
        after: `        int right = base * @[2]@;`,
      },
    ],
    bugs: [
      {
        id: 'Update2',
        before: `        int left = base + 1;`,
        after: `        int left = base - 1;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int base = 2;`,
        after: `        int base = 3;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int right = base * 2;`,
        after: `        int right = base * 3;`,
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
        int x = 1;
        int y = 3;
        x = y - 1;
        y = x + 1;
        Turtle t = new Turtle(x, y);
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.左を向く();
    }
}`,
    blanks: [
      {
        id: 'Update3',
        before: `        x = y - 1;`,
        after: `        x = y @[-]@ 1;`,
      },
      {
        id: 'Update4',
        before: `        y = x + 1;`,
        after: `        y = x @[+]@ 1;`,
      },
      {
        id: 'Value2',
        before: `        int y = 3;`,
        after: `        int y = @[3]@;`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        x = y - 1;`,
        after: `        x = y + 1;`,
        kind: 'logical',
      },
      {
        id: 'Update4',
        before: `        y = x + 1;`,
        after: `        y = x - 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 3;`,
        after: `        int y = 4;`,
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
        int n = 5;
        int x = n / 2;
        x += 1;
        int y = (n + 1) / 2;
        Turtle t = new Turtle(x, y);
        t.左を向く();
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Update3',
        before: `        x += 1;`,
        after: `        x @[+=]@ 1;`,
      },
      {
        id: 'Update4',
        before: `        int y = (n + 1) / 2;`,
        after: `        int y = (n @[+]@ 1) / 2;`,
      },
      {
        id: 'Value1',
        before: `        int n = 5;`,
        after: `        int n = @[5]@;`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        x += 1;`,
        after: `        x -= 1;`,
        kind: 'logical',
      },
      {
        id: 'Update4',
        before: `        int y = (n + 1) / 2;`,
        after: `        int y = (n - 1) / 2;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int n = 5;`,
        after: `        int n = 6;`,
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
        int x = 1;
        int y = 6;
        x += 2;
        y -= x;
        x--;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = @[1]@;`,
      },
      {
        id: 'Value2',
        before: `        int y = 6;`,
        after: `        int y = @[6]@;`,
      },
      {
        id: 'Value3',
        before: `        x += 2;`,
        after: `        x += @[2]@;`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int x = 1;`,
        after: `        int x = 2;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int y = 6;`,
        after: `        int y = 7;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        x += 2;`,
        after: `        x += 3;`,
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
        int value = 1;
        value += 3;
        int saved = value;
        value -= 3;
        Turtle t = new Turtle(value, saved);
        t.右を向く();
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int value = 1;`,
        after: `        int value = @[1]@;`,
      },
      {
        id: 'Value2',
        before: `        value += 3;`,
        after: `        value += @[3]@;`,
      },
      {
        id: 'Value4',
        before: `        value -= 3;`,
        after: `        value -= @[3]@;`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int value = 1;`,
        after: `        int value = 2;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        value += 3;`,
        after: `        value += 4;`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        value -= 3;`,
        after: `        value -= 4;`,
        kind: 'logical',
      },
    ],
  },
];
