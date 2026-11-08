import type { JavaChallengeDefinition } from './types';

export const beginner2Early: Record<string, JavaChallengeDefinition> = {
  javaB2Early_sharedReference_bugFix_otherObject: {
    title: 'バグ修正：２つの名前で描く道',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    problemFormat: 'bugFix',
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Turtle first = new Turtle(1, 1, "R");\n    Turtle second = new Turtle(4, 1, "B");\n    Turtle alias = first;\n    alias.forward();\n    first.turnRight();\n    alias.forward();\n    second.forward();\n  }\n}',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Turtle first = new Turtle(1, 1, "R");\n    Turtle second = new Turtle(4, 1, "B");\n    Turtle alias = second;\n    alias.forward();\n    first.turnRight();\n    alias.forward();\n    second.forward();\n  }\n}',
    finalBoard: '.......\n.R..B..\n.RR.B..\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: 'R',
        dir: 'E',
      },
      {
        x: 4,
        y: 2,
        color: 'B',
        dir: 'N',
      },
    ],
    bugKind: 'logical',
  },
  javaB2Early_constructorSpeed_bugFix_shadowedField: {
    title: 'バグ修正：歩幅を持つ亀',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    problemFormat: 'bugFix',
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker walker = new Walker(1, 1, 2);\n    walker.move();\n    walker.speed = 1;\n    walker.move();\n  }\n}\n\nclass Walker {\n  Turtle turtle;\n  int speed;\n  Walker(int x, int y, int speed) {\n    this.turtle = new Turtle(x, y);\n    this.speed = speed;\n  }\n  void move() {\n    for (int i = 0; i < speed; i++) turtle.forward();\n  }\n}',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker walker = new Walker(1, 1, 2);\n    walker.move();\n    walker.speed = 1;\n    walker.move();\n  }\n}\n\nclass Walker {\n  Turtle turtle;\n  int speed;\n  Walker(int x, int y, int speed) {\n    this.turtle = new Turtle(x, y);\n    speed = speed;\n  }\n  void move() {\n    for (int i = 0; i < speed; i++) turtle.forward();\n  }\n}',
    finalBoard: '.......\n.#.....\n.#.....\n.#.....\n.#.....\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
    bugKind: 'logical',
  },
  javaB2Early_boundedAccessor_bugFix_acceptNegative: {
    title: 'バグ修正：安全な歩幅の設定',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    problemFormat: 'bugFix',
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker walker = new Walker();\n    walker.setSpeed(2);\n    walker.move();\n    walker.setSpeed(-1);\n    walker.move();\n  }\n}\n\nclass Walker {\n  private Turtle turtle = new Turtle(1, 1);\n  private int speed = 1;\n  public void setSpeed(int value) {\n    if (value >= 0 && value <= 2) {\n      speed = value;\n    }\n  }\n  public void move() {\n    for (int i = 0; i < speed; i++) turtle.forward();\n  }\n}',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker walker = new Walker();\n    walker.setSpeed(2);\n    walker.move();\n    walker.setSpeed(-1);\n    walker.move();\n  }\n}\n\nclass Walker {\n  private Turtle turtle = new Turtle(1, 1);\n  private int speed = 1;\n  public void setSpeed(int value) {\n    if (value <= 2) {\n      speed = value;\n    }\n  }\n  public void move() {\n    for (int i = 0; i < speed; i++) turtle.forward();\n  }\n}',
    finalBoard: '.......\n.#.....\n.#.....\n.#.....\n.#.....\n.#.....\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 5,
        color: '#',
        dir: 'N',
      },
    ],
    bugKind: 'logical',
  },
  javaB2Early_sharedSpeed_bugFix_instanceSpeed: {
    title: 'バグ修正：共有する歩幅',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    problemFormat: 'bugFix',
    correctProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker first = new Walker(1);\n    Walker second = new Walker(4);\n    first.speed = 2;\n    first.move();\n    second.move();\n  }\n}\n\nclass Walker {\n  static int speed = 1;\n  Turtle turtle;\n  Walker(int x) {\n    turtle = new Turtle(x, 1);\n  }\n  void move() {\n    for (int i = 0; i < speed; i++) turtle.forward();\n  }\n}',
    starterProgram:
      'public class Main {\n  public static void main(String[] args) {\n    Walker first = new Walker(1);\n    Walker second = new Walker(4);\n    first.speed = 2;\n    first.move();\n    second.move();\n  }\n}\n\nclass Walker {\n  int speed = 1;\n  Turtle turtle;\n  Walker(int x) {\n    turtle = new Turtle(x, 1);\n  }\n  void move() {\n    for (int i = 0; i < speed; i++) turtle.forward();\n  }\n}',
    finalBoard: '.......\n.#..#..\n.#..#..\n.#..#..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 3,
        color: '#',
        dir: 'N',
      },
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
    bugKind: 'logical',
  },
};
