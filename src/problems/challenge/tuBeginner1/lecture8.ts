import type { ChallengeBase } from '../types';

export const lecture8: ChallengeBase[] = [
  {
    id: 'challengeI8ReverseArray',
    title: '後ろから読む配列',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[] values = {1, 2, 3};
        int x = 0;
        for (int i = values.length - 1; i >= 1; i--) {
            x = values[i] - x;
        }
        Turtle t = new Turtle(x + 2, 1);
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = values.length - 1; i >= 1; i--) {`,
        after: `        for (int i = values.length - 1; i @[>=]@ 1; i--) {`,
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2, 3};`,
        after: `        int[] values = {1, @[2]@, 3};`,
      },
      {
        id: 'Value2',
        before: `        int x = 0;`,
        after: `        int x = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = values.length - 1; i >= 1; i--) {`,
        after: `        for (int i = values.length - 1; i > 1; i--) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2, 3};`,
        after: `        int[] values = {1, 3, 3};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = 0;`,
        after: `        int x = 1;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8MutateBeforeRead',
    title: '書き換えてから読む',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[] values = {1, 2};
        values[0] = values[1] + 1;
        int total = 0;
        for (int i = 0; i < values.length; i++) {
            total += values[i];
        }
        Turtle t = new Turtle(total, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < values.length; i++) {`,
        after: `        for (int i = 0; i < @[values.length]@; i++) {`,
      },
      {
        id: 'Update2',
        before: `        values[0] = values[1] + 1;`,
        after: `        values[0] = values[1] @[+]@ 1;`,
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2};`,
        after: `        int[] values = {1, @[2]@};`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < values.length; i++) {`,
        after: `        for (int i = 0; i < values.length - 1; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Update2',
        before: `        values[0] = values[1] + 1;`,
        after: `        values[0] = values[1] - 1;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2};`,
        after: `        int[] values = {1, 1};`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8AdjacentComparison',
    title: '隣の値を比べる',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        int[] values = {1, 3, 2};
        for (int i = 0; i < values.length - 1; i++) {
            if (values[i] < values[i + 1]) {
                t.右を向く();
            }
            t.前に進む();
        }
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length - 1; i++) {`,
        after: `        for (int i = 0; i < @[values.length - 1]@; i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (values[i] < values[i + 1]) {`,
        after: `            if (values[i] @[<]@ values[i + 1]) {`,
      },
      {
        id: 'Action5',
        before: `                t.右を向く();`,
        after: `                t.@[右を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length - 1; i++) {`,
        after: `        for (int i = 0; i < values.length - 2; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (values[i] < values[i + 1]) {`,
        after: `            if (values[i] > values[i + 1]) {`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `                t.右を向く();`,
        after: `                t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8FirstMatch',
    title: '最初の一致を探す',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[] values = {2, 4, 4};
        int found = 0;
        for (int i = 0; i < values.length; i++) {
            if (values[i] == 4) {
                found = i;
                break;
            }
        }
        Turtle t = new Turtle(found, 2);
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length; i++) {`,
        after: `        for (int i = 0; i @[<]@ values.length; i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (values[i] == 4) {`,
        after: `            if (values[i] @[==]@ 4) {`,
      },
      {
        id: 'Value1',
        before: `        int[] values = {2, 4, 4};`,
        after: `        int[] values = {2, @[4]@, 4};`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length; i++) {`,
        after: `        for (int i = 0; i > values.length; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (values[i] == 4) {`,
        after: `            if (values[i] != 4) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[] values = {2, 4, 4};`,
        after: `        int[] values = {2, 5, 4};`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8CopiedElement',
    title: '要素のコピー',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[] values = {2, 3};
        int copied = values[0];
        copied++;
        int x = values[0];
        int y = copied;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[] values = {2, 3};`,
        after: `        int[] values = {@[2]@, 3};`,
      },
      {
        id: 'Value2',
        before: `        int copied = values[0];`,
        after: `        int copied = values[@[0]@];`,
      },
      {
        id: 'Value4',
        before: `        int x = values[0];`,
        after: `        int x = values[@[0]@];`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[] values = {2, 3};`,
        after: `        int[] values = {3, 3};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int copied = values[0];`,
        after: `        int copied = values[1];`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        int x = values[0];`,
        after: `        int x = values[1];`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8CharacterCount',
    title: '文字を数える',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        String text = "aba";
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == 'a') {
                count++;
            }
        }
        Turtle t = new Turtle(count, 1);
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) {`,
        after: `        for (int i = 0; i @[<]@ text.length(); i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == 'a') {`,
        after: `            if (text.charAt(i) @[==]@ 'a') {`,
      },
      {
        id: 'Value2',
        before: `        int count = 0;`,
        after: `        int count = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) {`,
        after: `        for (int i = 0; i > text.length(); i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == 'a') {`,
        after: `            if (text.charAt(i) != 'a') {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int count = 0;`,
        after: `        int count = 1;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8ReverseCharacters',
    title: '文字列を逆に読む',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        String text = "oxo";
        for (int i = text.length() - 1; i >= 0; i--) {
            if (text.charAt(i) == 'x') {
                t.左を向く();
            } else {
                t.前に進む();
            }
        }
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = text.length() - 1; i >= 0; i--) {`,
        after: `        for (int i = text.length() - 1; i @[>=]@ 0; i--) {`,
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == 'x') {`,
        after: `            if (text.charAt(i) @[==]@ 'x') {`,
      },
      {
        id: 'Action5',
        before: `                t.左を向く();`,
        after: `                t.@[左を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = text.length() - 1; i >= 0; i--) {`,
        after: `        for (int i = text.length() - 1; i > 0; i--) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == 'x') {`,
        after: `            if (text.charAt(i) != 'x') {`,
        kind: 'logical',
      },
      {
        id: 'Action5',
        before: `                t.左を向く();`,
        after: `                t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8StringEquality',
    title: '文字列の一致で選ぶ',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        String label = "east";
        int[] positions = {1, 4};
        int index = 0;
        if (label.equals("east")) {
            index = 1;
        }
        Turtle t = new Turtle(positions[index], 2);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value2',
        before: `        int[] positions = {1, 4};`,
        after: `        int[] positions = {1, @[4]@};`,
      },
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        String label = "east";
        int[] positions = {1, 4};
        int index = 0;
        if (label.equals("east")) {
            index = 1;
        }
        Turtle t = new Turtle(positions[index], 2);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        String label = "east";
        int[] positions = {1, 4};
        int index = 0;
        if (label.equals("east")) {
            index = 1;
        }
        Turtle t = new Turtle(positions[index], 2);
        t.@[前に進む]@();`,
      },
      {
        id: 'Action9',
        before: `        t.左を向く();`,
        after: `        t.@[左を向く]@();`,
      },
    ],
    bugs: [
      {
        id: 'Value2',
        before: `        int[] positions = {1, 4};`,
        after: `        int[] positions = {1, 5};`,
        kind: 'logical',
      },
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        String label = "east";
        int[] positions = {1, 4};
        int index = 0;
        if (label.equals("east")) {
            index = 1;
        }
        Turtle t = new Turtle(positions[index], 2);
        t.前に進む();`,
        after: `public class Main {
    public static void main(String[] args) {
        String label = "east";
        int[] positions = {1, 4};
        int index = 0;
        if (label.equals("east")) {
            index = 1;
        }
        Turtle t = new Turtle(positions[index], 2);
        t.後に戻る();`,
        kind: 'logical',
      },
      {
        id: 'Action9',
        before: `        t.左を向く();`,
        after: `        t.前に進む();`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8WordLengths',
    title: '単語の長さの合計',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        String[] words = {"go", "up"};
        int total = 0;
        for (int i = 0; i < words.length; i++) {
            total += words[i].length();
        }
        Turtle t = new Turtle(total, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Length',
        before: `total += words[i].length();`,
        after: `total += @[words[i].length()]@;`,
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = @[0]@;`,
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < words.length; i++) {`,
        after: `        for (int i = @[0]@; i < words.length; i++) {`,
      },
    ],
    bugs: [
      {
        id: 'Length',
        before: `total += words[i].length();`,
        after: `total += words[i].length() - 1;`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < words.length; i++) {`,
        after: `        for (int i = 1; i < words.length; i++) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeI8DelimiterStop',
    title: '区切りで止める',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        String text = "ab|c";
        int count = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '|') {
                break;
            }
            count++;
        }
        Turtle t = new Turtle(count, 2);
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) {`,
        after: `        for (int i = 0; i @[<]@ text.length(); i++) {`,
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == '|') {`,
        after: `            if (text.charAt(i) @[==]@ '|') {`,
      },
      {
        id: 'Value2',
        before: `        int count = 0;`,
        after: `        int count = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) {`,
        after: `        for (int i = 0; i > text.length(); i++) {`,
        kind: 'logical',
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == '|') {`,
        after: `            if (text.charAt(i) != '|') {`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int count = 0;`,
        after: `        int count = 1;`,
        kind: 'logical',
      },
    ],
  },
];
