import type { SourceJavaModel } from './sourceModels';

export const sourceBeginner2EarlyModels = {
  multiObject1: {
    title: '複数のオブジェクトを使おう(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    sourceProblemId: 'multiObject1',
    authoringSeed: 'source-expansion-v1:multiObject1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Turtle t2 = new Turtle(3, 3);
    t1.前に進む();
    t1.右を向く();
    t2.前に進む();
    t2.左を向く();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
...#...
...#...
.......
.......`,
    finalTurtles: [
      { x: 1, y: 2, color: '#', dir: 'E' },
      { x: 3, y: 4, color: '#', dir: 'W' },
    ],
  },
  multiObject2: {
    title: '複数のオブジェクトを使おう(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    sourceProblemId: 'multiObject2',
    authoringSeed: 'source-expansion-v1:multiObject2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    t1.前に進む();
    t1.右を向く();
    Turtle t2 = new Turtle(3, 3);
    t2.前に進む();
    t2.左を向く();
    t2.前に進む();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
...#...
..##...
.......
.......`,
    finalTurtles: [
      { x: 1, y: 2, color: '#', dir: 'E' },
      { x: 2, y: 4, color: '#', dir: 'W' },
    ],
  },
  multiObject3: {
    title: '複数のオブジェクトを使おう(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    sourceProblemId: 'multiObject3',
    authoringSeed: 'source-expansion-v1:multiObject3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 4);
    Turtle t2 = new Turtle(5, 4);
    Turtle t3 = new Turtle(2, 1);

    t1.右を向く();
    t1.右を向く();
    t1.前に進む();

    t2.左を向く();
    t2.左を向く();
    t2.前に進む();

    t3.右を向く();
    t3.前に進む();
    t3.前に進む();
  }
}`,
    finalBoard: `.......
..###..
.......
.#...#.
.#...#.
.......
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'S' },
      { x: 5, y: 3, color: '#', dir: 'S' },
      { x: 4, y: 1, color: '#', dir: 'E' },
    ],
  },
  multiObject4: {
    title: '複数のオブジェクトを使おう(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    sourceProblemId: 'multiObject4',
    authoringSeed: 'source-expansion-v1:multiObject4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 6);
    Turtle t2 = new Turtle(6, 0);

    t1.右を向く();
    t1.右を向く();

    for (int i = 0; i < 5; i++) {
      t1.前に進む();
      t2.前に進む();
      if (i % 2 == 0) {
        t1.左を向く();
        t2.左を向く();
      } else {
        t1.右を向く();
        t2.右を向く();
      }
    }
  }
}`,
    finalBoard: `......#
.....##
....##.
..#.#..
.##....
##.....
#......`,
    finalTurtles: [
      { x: 2, y: 3, color: '#', dir: 'E' },
      { x: 4, y: 3, color: '#', dir: 'W' },
    ],
  },
  multiObject5: {
    title: '複数のオブジェクトを使おう(5)',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    sourceProblemId: 'multiObject5',
    authoringSeed: 'source-expansion-v1:multiObject5',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 3);
    Turtle t2 = new Turtle(4, 3);
    Turtle t3 = new Turtle(0, 0);
    Turtle t4 = new Turtle(1, 6);
    Turtle t5 = new Turtle(6, 4);

    t1.右を向く();

    while (t1.前に進めるか()) {
      while (t1.前に進めるか()) {
        t1.前に進む();
      }
      t1.右を向く();
    }
  }
}`,
    finalBoard: `####...
.#.#...
.#.#...
#####..
.#....#
.######
.#.....`,
    finalTurtles: [
      { x: 6, y: 5, color: '#', dir: 'S' },
      { x: 4, y: 3, color: '#', dir: 'N' },
      { x: 0, y: 0, color: '#', dir: 'N' },
      { x: 1, y: 6, color: '#', dir: 'N' },
      { x: 6, y: 4, color: '#', dir: 'N' },
    ],
  },
  multiObject6: {
    title: '複数のオブジェクトを使おう(6)',
    courseId: 'tuBeginner2',
    lectureIndex: 0,
    sourceProblemId: 'multiObject6',
    authoringSeed: 'source-expansion-v1:multiObject6',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle[] turtles = new Turtle[3];
    for (int i = 0; i < turtles.length; i++) {
      turtles[i] = new Turtle(1 + i * 2, 0);
    }

    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < turtles.length; j++) {
        N歩前に進める(turtles[j], j);
      }
    }
  }

  static void N歩前に進める(Turtle t, int n) {
    for (int i = 0; i < n; i++) {
      t.前に進む();
    }
  }
}`,
    finalBoard: `.#.#.#.
...#.#.
...#.#.
...#.#.
.....#.
.....#.
.....#.`,
    finalTurtles: [
      { x: 1, y: 0, color: '#', dir: 'N' },
      { x: 3, y: 3, color: '#', dir: 'N' },
      { x: 5, y: 6, color: '#', dir: 'N' },
    ],
  },
  makeClass1: {
    title: 'クラスを作ろう(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'makeClass1',
    authoringSeed: 'source-expansion-v1:makeClass1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.moveForward();
    t.speed = 1;
    t.moveForward();
  }
}

class MyTurtle {
  Turtle t = new Turtle();
  int speed = 2;

  void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
}`,
    finalBoard: `#......
#......
#......
#......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 3, color: '#', dir: 'N' }],
  },
  makeClass2: {
    title: 'クラスを作ろう(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'makeClass2',
    authoringSeed: 'source-expansion-v1:makeClass2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.moveDiagonally();
    t.speed = 2;
    t.moveDiagonally();
  }
}

class MyTurtle {
  Turtle t = new Turtle();
  int speed = 1;

  void moveDiagonally() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
      this.t.右を向く();
      this.t.前に進む();
      this.t.左を向く();
    }
  }
}`,
    finalBoard: `#......
##.....
.##....
..##...
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 3, color: '#', dir: 'N' }],
  },
  makeClass3: {
    title: 'クラスを作ろう(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'makeClass3',
    authoringSeed: 'source-expansion-v1:makeClass3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.drawSquare();
    t.size = 4;
    t.drawSquare();
  }
}

class MyTurtle {
  Turtle t = new Turtle();
  int size = 2;

  void drawSquare() {
    for (int i = 0; i < this.size * 4; i++) {
      if (i % this.size == this.size - 1) {
        this.t.右を向く();
      } else {
        this.t.前に進む();
      }
    }
  }
}`,
    finalBoard: `####...
##.#...
#..#...
####...
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }],
  },
  makeClass4: {
    title: 'クラスを作ろう(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'makeClass4',
    authoringSeed: 'source-expansion-v1:makeClass4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.moveForward();
    t.speed = 1;
    t.turnRight();
    t.moveForward();
  }
}
class MyTurtle {
  Turtle fast = new Turtle(1, 1);
  Turtle slow = new Turtle(5, 1);
  int speed = 2;

  void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.fast.前に進む();
      this.fast.前に進む();
      this.slow.前に進む();
    }
  }
  void turnRight() {
    this.fast.右を向く();
    this.slow.右を向く();
  }
}`,
    finalBoard: `.......
.#...#.
.#...#.
.#...##
.#.....
.###...
.......`,
    finalTurtles: [
      { x: 3, y: 5, color: '#', dir: 'E' },
      { x: 6, y: 3, color: '#', dir: 'E' },
    ],
  },
  makeClass5: {
    title: 'クラスを作ろう(5)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'makeClass5',
    authoringSeed: 'source-expansion-v1:makeClass5',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.operate();
    t.operation = "LFFRFF";
    t.operate();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  String operation = "FFRFF";

  void operate() {
    for (int i = 0; i < this.operation.length(); i++) {
      switch (this.operation.charAt(i)) {
        case 'F':
          this.t.前に進む(); break;
        case 'R':
          this.t.右を向く(); break;
        case 'L':
          this.t.左を向く(); break;
      }
    }
  }
}`,
    finalBoard: `#......
#......
###....
..#....
..###..
.......
.......`,
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
  },
  makeClass6: {
    title: 'クラスを作ろう(6)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'makeClass6',
    authoringSeed: 'source-expansion-v1:makeClass6',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.turnRight();
    t.moveForward();
    t.turnLeft();
    t.moveForward();
    t.moveForward();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  int speed = 1;
  void moveForward() {
    for (int i = 0; i < this.speed; i++)
      this.t.前に進む();
    speed++;
  }
  void turnRight() {
    this.t.右を向く();
  }
  void turnLeft() {
    this.t.左を向く();
  }
}`,
    finalBoard: `##.....
.#.....
.#.....
.#.....
.#.....
.#.....
.......`,
    finalTurtles: [{ x: 1, y: 5, color: '#', dir: 'N' }],
  },
  constructor1: {
    title: 'コンストラクタ(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'constructor1',
    authoringSeed: 'source-expansion-v1:constructor1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 1, 2);
    t.moveForward();
    t.speed = 1;
    t.moveForward();
  }
}

class MyTurtle {
  Turtle t;
  int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.speed = speed;
  }
  void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
}`,
    finalBoard: `.......
#......
#......
#......
#......
.......
.......`,
    finalTurtles: [{ x: 0, y: 4, color: '#', dir: 'N' }],
  },
  constructor2: {
    title: 'コンストラクタ(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'constructor2',
    authoringSeed: 'source-expansion-v1:constructor2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(1, 1, "FRFLFFF");
    t.operate();
  }
}
class MyTurtle {
  Turtle t;
  String operation;

  MyTurtle(int x, int y, String operation) {
    this.t = new Turtle(x, y);
    this.operation = operation;
  }
  void operate() {
    for (int i = 0; i < this.operation.length(); i++) {
      switch (this.operation.charAt(i)) {
      case 'F':
        this.t.前に進む(); break;
      case 'R':
        this.t.右を向く(); break;
      case 'L':
        this.t.左を向く(); break;
      }
    }
  }
}`,
    finalBoard: `.......
.#.....
.##....
..#....
..#....
..#....
.......`,
    finalTurtles: [{ x: 2, y: 5, color: '#', dir: 'N' }],
  },
  constructor3: {
    title: 'コンストラクタ(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 1,
    sourceProblemId: 'constructor3',
    authoringSeed: 'source-expansion-v1:constructor3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(2);
    t.moveForward();
    t.turnRight();
    t.moveForward();
    t.moveForward();
    t.turnLeft();
  }
}
class MyTurtle {
  Turtle t;
  int speed;

  MyTurtle(int speed) {
    this.t = new Turtle();
    this.speed = speed;
  }
  void moveForward() {
    for (int i = 0; i < this.speed; i++)
      this.t.前に進む();
    this.speed--;
  }
  void turnRight() {
    this.t.右を向く();
  }
  void turnLeft() {
    this.t.左を向く();
  }
}`,
    finalBoard: `#......
#......
##.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  encapsulation: {
    title: 'カプセル化',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'encapsulation',
    authoringSeed: 'source-expansion-v1:encapsulation',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.moveForward();
    t.changeSpeed(1);
    t.moveForward();
  }
}

class MyTurtle {
  private Turtle t = new Turtle();
  private int speed = 2;

  public void moveForward() {
    for (int i = 0; i < this.speed; i++) {
      this.t.前に進む();
    }
  }
  public void changeSpeed(int speed) {
    this.speed = speed;
  }
}`,
    finalBoard: `#......
#......
#......
#......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 3, color: '#', dir: 'N' }],
  },
  withoutEncapsulation: {
    title: 'カプセル化なし(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withoutEncapsulation',
    authoringSeed: 'source-expansion-v1:withoutEncapsulation',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    drawSquare(t, 2);
    drawSquare(t, 3);
  }

  static void drawSquare(Turtle t, int size) {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < size - 1; j++) {
        t.前に進む();
      }
      t.右を向く();
    }
  }
}`,
    finalBoard: `###....
###....
###....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }],
  },
  withEncapsulation: {
    title: 'カプセル化あり(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withEncapsulation',
    authoringSeed: 'source-expansion-v1:withEncapsulation',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    SquareTurtle t = new SquareTurtle();
    t.draw(2);
    t.draw(3);
  }
}

class SquareTurtle {
  private Turtle t = new Turtle(0, 0);

  void draw(int size) {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < size - 1; j++) {
        this.t.前に進む();
      }
      this.t.右を向く();
    }
  }
}`,
    finalBoard: `###....
###....
###....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }],
  },
  withoutEncapsulation2: {
    title: 'カプセル化なし(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withoutEncapsulation2',
    authoringSeed: 'source-expansion-v1:withoutEncapsulation2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    drawCurve(t, 3);
  }
  static void drawCurve(Turtle t, int speed) {
    drawLine(t, speed);
    t.右を向く();
    drawLine(t, speed);
  }
  static void drawLine(Turtle t, int speed) {
    for (int i = 0; i < speed; i++) {
      t.前に進む();
    }
  }
}`,
    finalBoard: `#......
#......
#......
####...
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 3, color: '#', dir: 'E' }],
  },
  withEncapsulation2: {
    title: 'カプセル化あり(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withEncapsulation2',
    authoringSeed: 'source-expansion-v1:withEncapsulation2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle();
    t.draw(2);
  }
}
class CurveTurtle {
  private Turtle t = new Turtle(0, 0);
  void draw(int speed) {
    this.drawLine(speed);
    this.t.右を向く();
    this.drawLine(speed);
  }
  void drawLine(int speed) {
    for (int i = 0; i < speed; i++) {
      this.t.前に進む();
    }
  }
}`,
    finalBoard: `#......
#......
###....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 2, color: '#', dir: 'E' }],
  },
  withEncapsulation4: {
    title: 'カプセル化あり(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withEncapsulation4',
    authoringSeed: 'source-expansion-v1:withEncapsulation4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0, 2);
    t.moveForward();
    t.setSpeed(t.getSpeed() * 3 / 2);
    t.moveForward();
    t.setSpeed(-1);
    t.moveForward();
    t.setSpeed(99);
    t.moveBackward();
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.setSpeed(speed);
  }
  public int getSpeed() {
    return this.speed;
  }
  public void setSpeed(int speed) {
    if (speed < 0)      this.speed = 0;
    else if (5 < speed) this.speed = 5;
    else                this.speed = speed;
  }
  public void moveForward() {
    for (int i = 0; i < this.speed; i++)
      this.t.前に進む();
  }
  public void moveBackward() {
    for (int i = 0; i < this.speed; i++)
      this.t.後に戻る();
  }
}`,
    finalBoard: `#......
#......
#......
#......
#......
#......
.......`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }],
  },
  withEncapsulation5: {
    title: 'カプセル化あり(5)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withEncapsulation5',
    authoringSeed: 'source-expansion-v1:withEncapsulation5',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(3, 0, 3);
    t.moveForward();
    t.changeSpeed(-2);
    t.moveForward();
    t.changeSpeed(5);
    t.moveForward();
  }
}

class MyTurtle {
  private Turtle t;
  private int speed;

  MyTurtle(int x, int y, int speed) {
    this.t = new Turtle(x, y);
    this.speed = speed;
  }
  public void moveForward() {
    for (int i = 0; i < Math.abs(this.speed); i++) {
      this.t.前に進む();
    }
  }
  public void changeSpeed(int speed) {
    if (this.speed * speed < 0) {
      this.t.右を向く();
      this.t.右を向く();
    }
    this.speed = speed;
  }
}`,
    finalBoard: `...#...
...#...
...#...
...#...
...#...
...#...
...#...`,
    finalTurtles: [{ x: 3, y: 6, color: '#', dir: 'N' }],
  },
  withEncapsulation7: {
    title: 'カプセル化あり(7)',
    courseId: 'tuBeginner2',
    lectureIndex: 2,
    sourceProblemId: 'withEncapsulation7',
    authoringSeed: 'source-expansion-v1:withEncapsulation7',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(0, 0);
    t.setOperation("FFRFR");
    t.operate();
    t.setOperation("ABC");
    t.operate();
  }
}
class MyTurtle {
  private Turtle t;
  private String operation;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
    this.operation = "F";
  }
  public void setOperation(String op) {
    this.operation = op;
  }
  public void operate() {
    for (int i = 0; i < this.operation.length(); i++) {
      switch (this.operation.charAt(i)) {
        case 'F':
          this.t.前に進む(); break;
        case 'B':
          this.t.後に戻る(); break;
        case 'R':
          this.t.右を向く(); break;
        case 'L':
          this.t.左を向く(); break;
      }
    }
  }
}`,
    finalBoard: `#......
#......
##.....
.#.....
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 3, color: '#', dir: 'S' }],
  },
  staticMethod1: {
    title: '静的メソッド(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticMethod1',
    authoringSeed: 'source-expansion-v1:staticMethod1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Controller.moveTwoSteps(t1);
    Turtle t2 = new Turtle(3, 3);
    Controller.moveTwoSteps(t2);
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
.#.#...
...#...
...#...
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'N' },
      { x: 3, y: 5, color: '#', dir: 'N' },
    ],
  },
  staticMethod2: {
    title: '静的メソッド(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticMethod2',
    authoringSeed: 'source-expansion-v1:staticMethod2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Turtle t2 = new Turtle(3, 3);
    Controller.moveTwoSteps(t1);
    Controller.moveTwoSteps(t2);
    t1.前に進む();
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
.#.#...
.#.#...
...#...
.......`,
    finalTurtles: [
      { x: 1, y: 4, color: '#', dir: 'N' },
      { x: 3, y: 5, color: '#', dir: 'N' },
    ],
  },
  staticMethod3: {
    title: '静的メソッド(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticMethod3',
    authoringSeed: 'source-expansion-v1:staticMethod3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 0);
    Controller.moveThreeSteps(t1);
    Turtle t2 = new Turtle(3, 0);
    Turtle t3 = new Turtle(6, 0);
    Controller.moveThreeSteps(t2);
    Controller.moveThreeSteps(t3);
  }
}

class Controller {
  static void moveThreeSteps(Turtle t) {
    t.前に進む();
    t.前に進む();
    t.前に進む();
  }
}`,
    finalBoard: `#..#..#
#..#..#
#..#..#
#..#..#
.......
.......
.......`,
    finalTurtles: [
      { x: 0, y: 3, color: '#', dir: 'N' },
      { x: 3, y: 3, color: '#', dir: 'N' },
      { x: 6, y: 3, color: '#', dir: 'N' },
    ],
  },
  staticMethod4: {
    title: '静的メソッド(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticMethod4',
    authoringSeed: 'source-expansion-v1:staticMethod4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(0, 0);
    Turtle t2 = new Turtle(1, 1);
    Controller.drawSquare(t1, 4);
    Turtle t3 = new Turtle(2, 2);
    Controller.drawSquare(t2, 3);
    Controller.drawSquare(t3, 2);
  }
}

class Controller {
  static void drawSquare(Turtle t, int size) {
    for (int i = 0; i < 4; i++) {
      Controller.drawLine(t, size - 1);
      t.右を向く();
    }
  }
  static void drawLine(Turtle t, int n) {
    for (int i = 0; i < n; i++)
      t.前に進む();
  }
}`,
    finalBoard: `####...
####...
####...
####...
.......
.......
.......`,
    finalTurtles: [
      { x: 0, y: 0, color: '#', dir: 'N' },
      { x: 1, y: 1, color: '#', dir: 'N' },
      { x: 2, y: 2, color: '#', dir: 'N' },
    ],
  },
  staticField1: {
    title: '静的フィールド(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticField1',
    authoringSeed: 'source-expansion-v1:staticField1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1);
    Controller.moveTwoSteps(t1);
    Turtle t2 = new Turtle(3, 3);
    Controller.moveTwoSteps(t2);
    int count = Controller.stepCount;
  }
}

class Controller {
  static int stepCount;

  static void moveTwoSteps(Turtle t) {
    t.前に進む();
    stepCount++;
    t.前に進む();
    stepCount++;
  }
}`,
    finalBoard: `.......
.#.....
.#.....
.#.#...
...#...
...#...
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'N' },
      { x: 3, y: 5, color: '#', dir: 'N' },
    ],
  },
  staticField2: {
    title: '静的フィールド(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticField2',
    authoringSeed: 'source-expansion-v1:staticField2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle();
    t1.moveForward();
    Settings.speed = 2;
    MyTurtle t2 = new MyTurtle();
    t1.moveForward();
    t2.moveForward();
  }
}

class Settings {
  static public int speed = 3;
}

class MyTurtle {
  private Turtle t = new Turtle();

  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) {
      this.t.前に進む();
    }
  }
}`,
    finalBoard: `#......
#......
#......
#......
#......
#......
.......`,
    finalTurtles: [
      { x: 0, y: 5, color: '#', dir: 'N' },
      { x: 0, y: 2, color: '#', dir: 'N' },
    ],
  },
  staticField3: {
    title: '静的フィールド(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticField3',
    authoringSeed: 'source-expansion-v1:staticField3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    LineTurtle t1 = new LineTurtle();
    SquareTurtle t2 = new SquareTurtle();
    t1.drawLine();
    t2.drawSquare();
    Settings.speed = 3;
    t1.drawLine();
  }
}
class Settings {
  static public int speed = 2;
}
class LineTurtle {
  private Turtle t = new Turtle(0, 0);
  void drawLine() {
    for (int i = 0; i < Settings.speed; i++)
      t.前に進む();
  }
}
class SquareTurtle {
  private Turtle t = new Turtle(1, 1);
  void drawSquare() {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < Settings.speed; j++)
        t.前に進む();
      t.右を向く();
    }
  }
}`,
    finalBoard: `#......
####...
##.#...
####...
#......
#......
.......`,
    finalTurtles: [
      { x: 0, y: 5, color: '#', dir: 'N' },
      { x: 1, y: 1, color: '#', dir: 'N' },
    ],
  },
  staticField4: {
    title: '静的フィールド(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticField4',
    authoringSeed: 'source-expansion-v1:staticField4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    AcceleratedTurtle t1 = new AcceleratedTurtle();
    SquareTurtle t2 = new SquareTurtle();
    t1.drawLine();
    t2.drawSquare();
    Settings.speed = 2;
    t1.drawLine();
  }
}
class Settings {
  static public int speed = 2;
}
class AcceleratedTurtle {
  private Turtle t = new Turtle(0, 0);
  void drawLine() {
    for (int i = 0; i < Settings.speed; i++)
      t.前に進む();
    Settings.speed++;
  }
}
class SquareTurtle {
  private Turtle t = new Turtle(1, 1);
  void drawSquare() {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < Settings.speed; j++)
        t.前に進む();
      t.右を向く();
    }
  }
}`,
    finalBoard: `#......
#####..
##..#..
##..#..
#####..
.......
.......`,
    finalTurtles: [
      { x: 0, y: 4, color: '#', dir: 'N' },
      { x: 1, y: 1, color: '#', dir: 'N' },
    ],
  },
  staticField5: {
    title: '静的フィールド(5)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticField5',
    authoringSeed: 'source-expansion-v1:staticField5',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    SlowTurtle t1 = new SlowTurtle();
    FastTurtle t2 = new FastTurtle();
    t1.moveForward();
    t2.moveForward();
    Settings.additionalSpeed++;
    t1.moveForward();
    t2.moveForward();
  }
}
class Settings {
  static public int additionalSpeed = 0;
}
class SlowTurtle {
  private Turtle t = new Turtle(0, 0);
  private int base = 1;
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++)
      t.前に進む();
  }
}
class FastTurtle {
  private Turtle t = new Turtle(6, 0);
  private int base = 2;
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++)
      t.前に進む();
  }
}`,
    finalBoard: `#.....#
#.....#
#.....#
#.....#
......#
......#
.......`,
    finalTurtles: [
      { x: 0, y: 3, color: '#', dir: 'N' },
      { x: 6, y: 5, color: '#', dir: 'N' },
    ],
  },
  staticField6: {
    title: '静的フィールド(6)',
    courseId: 'tuBeginner2',
    lectureIndex: 3,
    sourceProblemId: 'staticField6',
    authoringSeed: 'source-expansion-v1:staticField6',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(0, 0);
    MyTurtle t2 = new MyTurtle(3, 0);
    t1.moveForward();
    t2.moveForward();
    t1.base++;
    Settings.additionalSpeed++;
    t1.moveForward();
    t2.moveForward();
  }
}
class Settings {
  static public int additionalSpeed = 0;
}
class MyTurtle {
  private Turtle t;
  public int base;

  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
    this.base = 1;
  }
  void moveForward() {
    for (int i = 0; i < this.base + Settings.additionalSpeed; i++)
      this.t.前に進む();
  }
}`,
    finalBoard: `#..#...
#..#...
#..#...
#..#...
#......
.......
.......`,
    finalTurtles: [
      { x: 0, y: 4, color: '#', dir: 'N' },
      { x: 3, y: 3, color: '#', dir: 'N' },
    ],
  },
} satisfies Record<string, SourceJavaModel>;
