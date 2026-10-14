import type { JavaChallengeDefinition } from './types';

export const beginner2Late: Record<string, JavaChallengeDefinition> = {
  tu2PolymorphicStrideBug1: {
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker route = new LongWalker();\n    route.walk();\n    route.t.右を向く();\n    route.walk();\n  }\n}\nclass Walker {\n  Turtle t = new Turtle();\n  void walk() { t.前に進む(); }\n}\nclass LongWalker extends Walker {\n  @Override\n  void walk() { super.walk(); super.walk(); }\n}',
    finalBoard: '#......\n#......\n###....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
    title: 'バグ修正：親の型で歩く亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker route = new Walker();\n    route.walk();\n    route.t.右を向く();\n    route.walk();\n  }\n}\nclass Walker {\n  Turtle t = new Turtle();\n  void walk() { t.前に進む(); }\n}\nclass LongWalker extends Walker {\n  @Override\n  void walk() { super.walk(); super.walk(); }\n}',
  },
  tu2OverloadDefaultBug1: {
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Pen pen = new Pen();\n    pen.draw();\n    pen.t.右を向く();\n    pen.draw(3);\n  }\n}\nclass Pen {\n  Turtle t = new Turtle();\n  void draw() { draw(2); }\n  void draw(int steps) {\n    for (int i = 0; i < steps; i++) t.前に進む();\n  }\n}',
    finalBoard: '#......\n#......\n####...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
    title: 'バグ修正：引数で選ぶ道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Pen pen = new Pen();\n    pen.draw();\n    pen.t.右を向く();\n    pen.draw();\n  }\n}\nclass Pen {\n  Turtle t = new Turtle();\n  void draw() { draw(2); }\n  void draw(int steps) {\n    for (int i = 0; i < steps; i++) t.前に進む();\n  }\n}',
  },
  tu2ExceptionPropagationBug1: {
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Turtle t = new Turtle();\n    try {\n      turnAtLimit(t);\n      t.前に進む();\n    } catch (LimitException e) {\n      t.右を向く();\n      t.前に進む();\n    }\n  }\n  static void turnAtLimit(Turtle t) throws LimitException {\n    t.前に進む();\n    throw new LimitException();\n  }\n}\nclass LimitException extends Exception {}',
    finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 1,
        color: '#',
        dir: 'E',
      },
    ],
    title: 'バグ修正：呼び出しを戻る例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Turtle t = new Turtle();\n    try {\n      turnAtLimit(t);\n      t.前に進む();\n    } catch (LimitException e) {\n      t.右を向く();\n      t.前に進む();\n    }\n  }\n  static void turnAtLimit(Turtle t) throws LimitException {\n    t.前に進む();\n    return;\n  }\n}\nclass LimitException extends Exception {}',
  },
  tu2MatrixRowsBug1: {
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    int[][] lengths = {{1, 2}, {3, 1}};\n    Turtle t = new Turtle();\n    for (int row = 0; row < lengths.length; row++) {\n      for (int col = 0; col < lengths[row].length; col++) {\n        for (int step = 0; step < lengths[row][col]; step++) t.前に進む();\n      }\n      t.右を向く();\n    }\n  }\n}\n',
    finalBoard: '#......\n#......\n#......\n#####..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
    title: 'バグ修正：行ごとの歩数',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    int[][] lengths = {{1, 2}, {3, 1}};\n    Turtle t = new Turtle();\n    for (int row = 0; row < lengths.length; row++) {\n      for (int col = 0; col < lengths[row].length; col++) {\n        for (int step = 0; step < lengths[col][row]; step++) t.前に進む();\n      }\n      t.右を向く();\n    }\n  }\n}\n',
  },
};
