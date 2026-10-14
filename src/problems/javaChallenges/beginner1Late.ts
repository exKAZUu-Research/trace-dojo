import type { JavaChallengeDefinition } from './types';

export const beginner1Late: Record<string, JavaChallengeDefinition> = {
  javaI5SwitchCascadeBug2: {
    lectureIndex: 4,
    title: '連続して描く道（修正2）',
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int level = 2;\n        switch (level) {\n            case 3: t.前に進む();\n            case 2: t.右を向く();\n            case 1: t.前に進む(); break;\n            default: t.左を向く();\n        }\n    }\n}',
    finalBoard: '.......\n.......\n.......\n...##..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
    courseId: 'tuBeginner1',
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int level = 2;\n        switch (level) {\n            case 3: t.前に進む();\n            case level: t.右を向く();\n            case 1: t.前に進む(); break;\n            default: t.左を向く();\n        }\n    }\n}',
    bugKind: 'syntax',
  },
  javaI6ContinueSkipBug1: {
    lectureIndex: 5,
    title: '休みながら進む線（修正1）',
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        for (int i = 0; i < 3; i++) {\n            if (i == 1) continue;\n            t.前に進む();\n        }\n    }\n}',
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 5,
        color: '#',
        dir: 'N',
      },
    ],
    courseId: 'tuBeginner1',
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        for (int i = 0; i < 3; i++) {\n            if (i == 1) break;\n            t.前に進む();\n        }\n    }\n}',
    bugKind: 'logical',
  },
  javaI7ReturnChoiceBug1: {
    lectureIndex: 6,
    title: '長さを選ぶ道（修正1）',
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int steps = smaller(2, 3);\n        for (int i = 0; i < steps; i++) t.前に進む();\n    }\n    static int smaller(int a, int b) {\n        if (a < b) return a;\n        return b;\n    }\n}',
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 5,
        color: '#',
        dir: 'N',
      },
    ],
    courseId: 'tuBeginner1',
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int steps = smaller(2, 3);\n        for (int i = 0; i < steps; i++) t.前に進む();\n    }\n    static int smaller(int a, int b) {\n        if (a > b) return a;\n        return b;\n    }\n}',
    bugKind: 'logical',
  },
  javaI8ArrayRouteBug1: {
    lectureIndex: 7,
    title: '配列で決める道（修正1）',
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int[] lengths = {1, 2};\n        for (int i = 0; i < lengths.length; i++) {\n            for (int j = 0; j < lengths[i]; j++) t.前に進む();\n            t.右を向く();\n        }\n    }\n}',
    finalBoard: '.......\n.......\n.......\n...#...\n...###.\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 4,
        color: '#',
        dir: 'S',
      },
    ],
    courseId: 'tuBeginner1',
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(3, 3);\n        int[] lengths = {1, 2};\n        for (int i = 0; i < lengths.length; i++) {\n            for (int j = 0; j < lengths[0]; j++) t.前に進む();\n            t.右を向く();\n        }\n    }\n}',
    bugKind: 'logical',
  },
};
