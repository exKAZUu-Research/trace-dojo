import type { CorrectProblem } from '../types';

export const lecture8: CorrectProblem[] = [
  {
    id: 'challengeI8ReverseArray',
    title: '後ろから読む配列',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[] values = {1, 2, 3};\n        int x = 0;\n        for (int i = values.length - 1; i >= 1; i--) {\n            x = values[i] - x;\n        }\n        Turtle t = new Turtle(x + 2, 1);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8MutateBeforeRead',
    title: '書き換えてから読む',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[] values = {1, 2};\n        values[0] = values[1] + 1;\n        int total = 0;\n        for (int i = 0; i < values.length; i++) {\n            total += values[i];\n        }\n        Turtle t = new Turtle(total, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8AdjacentComparison',
    title: '隣の値を比べる',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        int[] values = {1, 3, 2};\n        for (int i = 0; i < values.length - 1; i++) {\n            if (values[i] < values[i + 1]) {\n                t.右を向く();\n            }\n            t.前に進む();\n        }\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8FirstMatch',
    title: '最初の一致を探す',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[] values = {2, 4, 4};\n        int found = 0;\n        for (int i = 0; i < values.length; i++) {\n            if (values[i] == 4) {\n                found = i;\n                break;\n            }\n        }\n        Turtle t = new Turtle(found, 2);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8CopiedElement',
    title: '要素のコピー',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[] values = {2, 3};\n        int copied = values[0];\n        copied++;\n        int x = values[0];\n        int y = copied;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI8CharacterCount',
    title: '文字を数える',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        String text = "aba";\n        int count = 0;\n        for (int i = 0; i < text.length(); i++) {\n            if (text.charAt(i) == \'a\') {\n                count++;\n            }\n        }\n        Turtle t = new Turtle(count, 1);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8ReverseCharacters',
    title: '文字列を逆に読む',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(2, 2);\n        String text = "oxo";\n        for (int i = text.length() - 1; i >= 0; i--) {\n            if (text.charAt(i) == \'x\') {\n                t.左を向く();\n            } else {\n                t.前に進む();\n            }\n        }\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI8StringEquality',
    title: '文字列の一致で選ぶ',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        String label = "east";\n        int[] positions = {1, 4};\n        int index = 0;\n        if (label.equals("east")) {\n            index = 1;\n        }\n        Turtle t = new Turtle(positions[index], 2);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8WordLengths',
    title: '単語の長さの合計',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        String[] words = {"go", "up"};\n        int total = 0;\n        for (int i = 0; i < words.length; i++) {\n            total += words[i].length();\n        }\n        Turtle t = new Turtle(total, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI8DelimiterStop',
    title: '区切りで止める',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        String text = "ab|c";\n        int count = 0;\n        for (int i = 0; i < text.length(); i++) {\n            if (text.charAt(i) == \'|\') {\n                break;\n            }\n            count++;\n        }\n        Turtle t = new Turtle(count, 2);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
];
