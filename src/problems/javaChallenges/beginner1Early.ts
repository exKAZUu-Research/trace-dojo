import type { JavaChallengeDefinition } from './types';

export const beginner1Early: Record<string, JavaChallengeDefinition> = {
  javaI1CornerApproachBlank: {
    title: '角のある道（1）',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(3, 3);\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n    }\n}',
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
    problemFormat: 'fillInBlank',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(3, 3);\n        @[亀.前に進む();]@\n        亀.右を向く();\n        亀.前に進む();\n    }\n}',
  },
  javaI1CornerTurnBug: {
    title: '角のある道（2）',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(3, 3);\n        亀.前に進む();\n        亀.右を向く();\n        亀.前に進む();\n    }\n}',
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(3, 3);\n        亀.前に進む();\n        亀.左を向く();\n        亀.前に進む();\n    }\n}',
    bugKind: 'logical',
  },
  javaI2CoordinateUpdateUpdateBug: {
    title: '変数で決める出発点（1）',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        int x = 2;\n        x = x + 1;\n        int y = x - 1;\n        Turtle 亀 = new Turtle(x, y);\n        亀.前に進む();\n    }\n}',
    finalBoard: '.......\n.......\n...#...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        int x = 2;\n        x = x - 1;\n        int y = x - 1;\n        Turtle 亀 = new Turtle(x, y);\n        亀.前に進む();\n    }\n}',
    bugKind: 'logical',
  },
  javaI3CountedLineConditionTypeBug: {
    title: '繰り返して描く直線（3）',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(2, 1);\n        for (int i = 0; i < 3; i++) {\n            亀.前に進む();\n        }\n    }\n}',
    finalBoard: '.......\n..#....\n..#....\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(2, 1);\n        for (int i = 0; i + 3; i++) {\n            亀.前に進む();\n        }\n    }\n}',
    bugKind: 'syntax',
  },
  javaI4BranchStairComparisonBug: {
    title: '条件に合わせて曲がる道（2）',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    correctProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(2, 1);\n        for (int i = 0; i < 4; i++) {\n            亀.前に進む();\n            if (i == 1) {\n                亀.右を向く();\n            }\n        }\n    }\n}',
    finalBoard: '.......\n..#....\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
    problemFormat: 'bugFix',
    starterProgram:
      'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(2, 1);\n        for (int i = 0; i < 4; i++) {\n            亀.前に進む();\n            if (i = 1) {\n                亀.右を向く();\n            }\n        }\n    }\n}',
    bugKind: 'syntax',
  },
};
