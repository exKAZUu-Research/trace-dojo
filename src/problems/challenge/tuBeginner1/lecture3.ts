import type { ChallengeBase } from '../types';

export const lecture3: ChallengeBase[] = [
  {
    id: 'challengeI3CountdownRetreat',
    title: '数えながら戻る',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();
        t.前に進む();
        t.前に進む();
        for (int i = 2; i > 0; i--) {
            t.後に戻る();
        }
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition5',
        before: `        for (int i = 2; i > 0; i--) {`,
        after: `        for (int i = 2; i @[>]@ 0; i--) {`,
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.@[前に進む]@();`,
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();
        t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition5',
        before: `        for (int i = 2; i > 0; i--) {`,
        after: `        for (int i = 2; i >= 0; i--) {`,
        kind: 'logical',
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        t.前に進む();
        t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3StrideCounter',
    title: '二つずつ数える',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 5; i += 2) {
            t.前に進む();
            t.右を向く();
        }
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i += 2) {`,
        after: `        for (int i = 0; i @[<]@ 5; i += 2) {`,
      },
      {
        id: 'Action3',
        before: `            t.前に進む();`,
        after: `            t.@[前に進む]@();`,
      },
      {
        id: 'Action4',
        before: `            t.右を向く();`,
        after: `            t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 0; i < 5; i += 2) {`,
        after: `        for (int i = 0; i > 5; i += 2) {`,
        kind: 'logical',
      },
      {
        id: 'Action3',
        before: `            t.前に進む();`,
        after: `            t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action4',
        before: `            t.右を向く();`,
        after: `            t.後に戻る();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ConsumedBudget',
    title: '二つずつ使う残り',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1);
        int budget = 5;
        while (budget > 0) {
            t.前に進む();
            budget -= 2;
        }
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (budget > 0) {`,
        after: `        while (budget @[>]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int budget = 5;`,
        after: `        int budget = @[5]@;`,
      },
      {
        id: 'Value5',
        before: `            budget -= 2;`,
        after: `            budget -= @[2]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (budget > 0) {`,
        after: `        while (budget < 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int budget = 5;`,
        after: `        int budget = 4;`,
        kind: 'logical',
      },
      {
        id: 'Value5',
        before: `            budget -= 2;`,
        after: `            budget -= 3;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3AccumulatedOrigin',
    title: '計算してから出発',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 0;
        for (int i = 1; i < 3; i++) {
            sum += i;
        }
        int y = sum - 2;
        Turtle t = new Turtle(sum, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 3; i++) {`,
        after: `        for (int i = 1; i @[<]@ 3; i++) {`,
      },
      {
        id: 'Update5',
        before: `        int y = sum - 2;`,
        after: `        int y = sum @[-]@ 2;`,
      },
      {
        id: 'Value1',
        before: `        int sum = 0;`,
        after: `        int sum = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i < 3; i++) {`,
        after: `        for (int i = 1; i <= 3; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Update5',
        before: `        int y = sum - 2;`,
        after: `        int y = sum + 2;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int sum = 0;`,
        after: `        int sum = 1;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3MultiplicativeStop',
    title: '倍になるカウンター',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int n = 1;
        while (n < 8) {
            t.前に進む();
            n *= 2;
        }
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (n < 8) {`,
        after: `        while (n @[<]@ 8) {`,
      },
      {
        id: 'Update5',
        before: `            n *= 2;`,
        after: `            n @[*=]@ 2;`,
      },
      {
        id: 'Value2',
        before: `        int n = 1;`,
        after: `        int n = @[1]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (n < 8) {`,
        after: `        while (n <= 8) {`,
        kind: 'logical',
      },
      {
        id: 'Update5',
        before: `            n *= 2;`,
        after: `            n += 2;`,
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
    id: 'challengeI3ChainedLoops',
    title: '続けて使うカウンター',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int n = 3;
        while (n > 1) {
            t.前に進む();
            n--;
        }
        t.右を向く();
        while (n < 3) {
            t.前に進む();
            n++;
        }
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (n > 1) {`,
        after: `        while (n @[>]@ 1) {`,
      },
      {
        id: 'Condition8',
        before: `        while (n < 3) {`,
        after: `        while (n @[<]@ 3) {`,
      },
      {
        id: 'Value2',
        before: `        int n = 3;`,
        after: `        int n = @[3]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (n > 1) {`,
        after: `        while (n >= 1) {`,
        kind: 'logical',
      },
      {
        id: 'Condition8',
        before: `        while (n < 3) {`,
        after: `        while (n <= 3) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int n = 3;`,
        after: `        int n = 4;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ShrinkingLimit',
    title: '近づく二つの値',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1);
        int i = 0;
        int limit = 4;
        while (i < limit) {
            t.前に進む();
            i++;
            limit--;
        }
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        while (i < limit) {`,
        after: `        while (i @[<]@ limit) {`,
      },
      {
        id: 'Value3',
        before: `        int limit = 4;`,
        after: `        int limit = @[4]@;`,
      },
      {
        id: 'Action5',
        before: `            t.前に進む();`,
        after: `            t.@[前に進む]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        while (i < limit) {`,
        after: `        while (i <= limit) {`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        int limit = 4;`,
        after: `        int limit = 5;`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `            t.前に進む();`,
        after: `            t.右を向く();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3PreupdatedBudget',
    title: '先に減らして進む',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int remaining = 2;
        while (remaining > 0) {
            remaining--;
            t.後に戻る();
            t.左を向く();
        }
        t.前に進む();
        t.右を向く();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        while (remaining > 0) {`,
        after: `        while (remaining @[>]@ 0) {`,
      },
      {
        id: 'Value2',
        before: `        int remaining = 2;`,
        after: `        int remaining = @[2]@;`,
      },
      {
        id: 'Action5',
        before: `            t.後に戻る();`,
        after: `            t.@[後に戻る]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        while (remaining > 0) {`,
        after: `        while (remaining >= 0) {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int remaining = 2;`,
        after: `        int remaining = 3;`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `            t.後に戻る();`,
        after: `            t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3RemainderOrigin',
    title: '合計の余りから出発',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        int sum = 1;
        for (int i = 1; i <= 2; i++) {
            sum += i * 2;
        }
        int x = sum % 3;
        int y = sum / 3;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i <= 2; i++) {`,
        after: `        for (int i = 1; i @[<=]@ 2; i++) {`,
      },
      {
        id: 'Value1',
        before: `        int sum = 1;`,
        after: `        int sum = @[1]@;`,
      },
      {
        id: 'Value3',
        before: `            sum += i * 2;`,
        after: `            sum += i * @[2]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition2',
        before: `        for (int i = 1; i <= 2; i++) {`,
        after: `        for (int i = 1; i < 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int sum = 1;`,
        after: `        int sum = 2;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `            sum += i * 2;`,
        after: `            sum += i * 3;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI3ZeroPassSection',
    title: '実行されない区間',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        t.前に進む();
        for (int i = 3; i < 2; i++) {
            t.後に戻る();
        }
        t.右を向く();
        for (int j = 0; j < 2; j++) {
            t.前に進む();
        }
        t.左を向く();
    }
}`,
    blanks: [
      {
        id: 'Condition7',
        before: `        for (int j = 0; j < 2; j++) {`,
        after: `        for (int j = 0; j @[<]@ 2; j++) {`,
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        t.@[前に進む]@();`,
      },
      {
        id: 'Action6',
        before: `        t.右を向く();`,
        after: `        t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition7',
        before: `        for (int j = 0; j < 2; j++) {`,
        after: `        for (int j = 0; j <= 2; j++) {`,
        kind: 'logical',
      },
      {
        id: 'Action2',
        before: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action6',
        before: `        t.右を向く();`,
        after: `        t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
];
