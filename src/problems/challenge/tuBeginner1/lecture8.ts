import type { ChallengeBase } from '../types';

export const lecture8: ChallengeBase[] = [
  {
    id: 'challengeI8ReverseArray',
    title: '後ろから読む配列',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[] values = {1, 2, 3}; // step
        int x = 0; // step
        for (int i = values.length - 1; i >= 1; i--) { // step
            x = values[i] - x; // step
        }
        Turtle t = new Turtle(x + 2, 1); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = values.length - 1; i >= 1; i--) { // step`,
        after: `        for (int i = values.length - 1; i @[>=]@ 1; i--) { // step`,
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2, 3}; // step`,
        after: `        int[] values = {1, @[2]@, 3}; // step`,
      },
      {
        id: 'Value2',
        before: `        int x = 0; // step`,
        after: `        int x = @[0]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = values.length - 1; i >= 1; i--) { // step`,
        after: `        for (int i = values.length - 1; i > 1; i--) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2, 3}; // step`,
        after: `        int[] values = {1, 3, 3}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = 0; // step`,
        after: `        int x = 1; // step`,
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
        int[] values = {1, 2}; // step
        values[0] = values[1] + 1; // step
        int total = 0; // step
        for (int i = 0; i < values.length; i++) { // step
            total += values[i]; // step
        }
        Turtle t = new Turtle(total, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < values.length; i++) { // step`,
        after: `        for (int i = 0; i < @[values.length]@; i++) { // step`,
      },
      {
        id: 'Update2',
        before: `        values[0] = values[1] + 1; // step`,
        after: `        values[0] = values[1] @[+]@ 1; // step`,
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2}; // step`,
        after: `        int[] values = {1, @[2]@}; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition4',
        before: `        for (int i = 0; i < values.length; i++) { // step`,
        after: `        for (int i = 0; i < values.length - 1; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Update2',
        before: `        values[0] = values[1] + 1; // step`,
        after: `        values[0] = values[1] - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[] values = {1, 2}; // step`,
        after: `        int[] values = {1, 1}; // step`,
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
        Turtle t = new Turtle(2, 2); // step
        int[] values = {1, 3, 2}; // step
        for (int i = 0; i < values.length - 1; i++) { // step
            if (values[i] < values[i + 1]) {
                t.右を向く(); // step
            }
            t.前に進む(); // step
        }
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length - 1; i++) { // step`,
        after: `        for (int i = 0; i < @[values.length - 1]@; i++) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (values[i] < values[i + 1]) {`,
        after: `            if (values[i] @[<]@ values[i + 1]) {`,
      },
      {
        id: 'Action5',
        before: `                t.右を向く(); // step`,
        after: `                t.@[右を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length - 1; i++) { // step`,
        after: `        for (int i = 0; i < values.length - 2; i++) { // step`,
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
        before: `                t.右を向く(); // step`,
        after: `                t.前に進む(); // step`,
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
        int[] values = {2, 4, 4}; // step
        int found = 0; // step
        for (int i = 0; i < values.length; i++) { // step
            if (values[i] == 4) {
                found = i; // step
                break;
            }
        }
        Turtle t = new Turtle(found, 2); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ values.length; i++) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (values[i] == 4) {`,
        after: `            if (values[i] @[==]@ 4) {`,
      },
      {
        id: 'Value1',
        before: `        int[] values = {2, 4, 4}; // step`,
        after: `        int[] values = {2, @[4]@, 4}; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < values.length; i++) { // step`,
        after: `        for (int i = 0; i > values.length; i++) { // step`,
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
        before: `        int[] values = {2, 4, 4}; // step`,
        after: `        int[] values = {2, 5, 4}; // step`,
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
        int[] values = {2, 3}; // step
        int copied = values[0]; // step
        copied++; // step
        int x = values[0]; // step
        int y = copied; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[] values = {2, 3}; // step`,
        after: `        int[] values = {@[2]@, 3}; // step`,
      },
      {
        id: 'Value2',
        before: `        int copied = values[0]; // step`,
        after: `        int copied = values[@[0]@]; // step`,
      },
      {
        id: 'Value4',
        before: `        int x = values[0]; // step`,
        after: `        int x = values[@[0]@]; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[] values = {2, 3}; // step`,
        after: `        int[] values = {3, 3}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int copied = values[0]; // step`,
        after: `        int copied = values[1]; // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        int x = values[0]; // step`,
        after: `        int x = values[1]; // step`,
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
        String text = "aba"; // step
        int count = 0; // step
        for (int i = 0; i < text.length(); i++) { // step
            if (text.charAt(i) == 'a') {
                count++; // step
            }
        }
        Turtle t = new Turtle(count, 1); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) { // step`,
        after: `        for (int i = 0; i @[<]@ text.length(); i++) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == 'a') {`,
        after: `            if (text.charAt(i) @[==]@ 'a') {`,
      },
      {
        id: 'Value2',
        before: `        int count = 0; // step`,
        after: `        int count = @[0]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) { // step`,
        after: `        for (int i = 0; i > text.length(); i++) { // step`,
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
        before: `        int count = 0; // step`,
        after: `        int count = 1; // step`,
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
        Turtle t = new Turtle(2, 2); // step
        String text = "oxo"; // step
        for (int i = text.length() - 1; i >= 0; i--) { // step
            if (text.charAt(i) == 'x') {
                t.左を向く(); // step
            } else {
                t.前に進む(); // step
            }
        }
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = text.length() - 1; i >= 0; i--) { // step`,
        after: `        for (int i = text.length() - 1; i @[>=]@ 0; i--) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == 'x') {`,
        after: `            if (text.charAt(i) @[==]@ 'x') {`,
      },
      {
        id: 'Action5',
        before: `                t.左を向く(); // step`,
        after: `                t.@[左を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = text.length() - 1; i >= 0; i--) { // step`,
        after: `        for (int i = text.length() - 1; i > 0; i--) { // step`,
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
        before: `                t.左を向く(); // step`,
        after: `                t.前に進む(); // step`,
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
        String label = "east"; // step
        int[] positions = {1, 4}; // step
        int index = 0; // step
        if (label.equals("east")) {
            index = 1; // step
        }
        Turtle t = new Turtle(positions[index], 2); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value2',
        before: `        int[] positions = {1, 4}; // step`,
        after: `        int[] positions = {1, @[4]@}; // step`,
      },
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        String label = "east"; // step
        int[] positions = {1, 4}; // step
        int index = 0; // step
        if (label.equals("east")) {
            index = 1; // step
        }
        Turtle t = new Turtle(positions[index], 2); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        String label = "east"; // step
        int[] positions = {1, 4}; // step
        int index = 0; // step
        if (label.equals("east")) {
            index = 1; // step
        }
        Turtle t = new Turtle(positions[index], 2); // step
        t.@[前に進む]@(); // step`,
      },
      {
        id: 'Action9',
        before: `        t.左を向く(); // step`,
        after: `        t.@[左を向く]@(); // step`,
      },
    ],
    bugs: [
      {
        id: 'Value2',
        before: `        int[] positions = {1, 4}; // step`,
        after: `        int[] positions = {1, 5}; // step`,
        kind: 'logical',
      },
      {
        id: 'Action8',
        before: `public class Main {
    public static void main(String[] args) {
        String label = "east"; // step
        int[] positions = {1, 4}; // step
        int index = 0; // step
        if (label.equals("east")) {
            index = 1; // step
        }
        Turtle t = new Turtle(positions[index], 2); // step
        t.前に進む(); // step`,
        after: `public class Main {
    public static void main(String[] args) {
        String label = "east"; // step
        int[] positions = {1, 4}; // step
        int index = 0; // step
        if (label.equals("east")) {
            index = 1; // step
        }
        Turtle t = new Turtle(positions[index], 2); // step
        t.後に戻る(); // step`,
        kind: 'logical',
      },
      {
        id: 'Action9',
        before: `        t.左を向く(); // step`,
        after: `        t.前に進む(); // step`,
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
        String[] words = {"go", "up"}; // step
        int total = 0; // step
        for (int i = 0; i < words.length; i++) { // step
            total += words[i].length(); // step
        }
        Turtle t = new Turtle(total, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Length',
        before: `total += words[i].length(); // step`,
        after: `total += @[words[i].length()]@; // step`,
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = @[0]@; // step`,
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < words.length; i++) { // step`,
        after: `        for (int i = @[0]@; i < words.length; i++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Length',
        before: `total += words[i].length(); // step`,
        after: `total += words[i].length() - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < words.length; i++) { // step`,
        after: `        for (int i = 1; i < words.length; i++) { // step`,
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
        String text = "ab|c"; // step
        int count = 0; // step
        for (int i = 0; i < text.length(); i++) { // step
            if (text.charAt(i) == '|') {
                break;
            }
            count++; // step
        }
        Turtle t = new Turtle(count, 2); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) { // step`,
        after: `        for (int i = 0; i @[<]@ text.length(); i++) { // step`,
      },
      {
        id: 'Condition4',
        before: `            if (text.charAt(i) == '|') {`,
        after: `            if (text.charAt(i) @[==]@ '|') {`,
      },
      {
        id: 'Value2',
        before: `        int count = 0; // step`,
        after: `        int count = @[0]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < text.length(); i++) { // step`,
        after: `        for (int i = 0; i > text.length(); i++) { // step`,
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
        before: `        int count = 0; // step`,
        after: `        int count = 1; // step`,
        kind: 'logical',
      },
    ],
  },
];
