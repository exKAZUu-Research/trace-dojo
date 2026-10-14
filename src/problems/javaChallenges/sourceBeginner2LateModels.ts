import type { SourceJavaModel } from './sourceModels';

export const sourceBeginner2LateModels = {
  inheritance1: {
    title: '継承(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'inheritance1',
    authoringSeed: 'source-expansion-v1:inheritance1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle();
    t.drawCurve();
  }
}
class MyTurtle {
  Turtle t = new Turtle();

  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
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
  inheritance2: {
    title: '継承(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'inheritance2',
    authoringSeed: 'source-expansion-v1:inheritance2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(2);
    t.drawCurve();
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p);
  }
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}`,
    finalBoard: `.......
.......
..#....
..#....
..###..
.......
.......`,
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
  },
  inheritance3: {
    title: '継承(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'inheritance3',
    authoringSeed: 'source-expansion-v1:inheritance3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(0);
    t.drawCurve();
    t.drawLine();
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p + 1, p + 2);
  }
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}`,
    finalBoard: `.......
.......
.#.....
.#.....
.#####.
.......
.......`,
    finalTurtles: [{ x: 5, y: 4, color: '#', dir: 'E' }],
  },
  inheritance4: {
    title: '継承(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'inheritance4',
    authoringSeed: 'source-expansion-v1:inheritance4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    SquareTurtle t = new SquareTurtle();
    t.drawSquare();
  }
}
class MyTurtle {
  Turtle t = new Turtle(0, 1);
  void drawLine() {
    this.t.前に進む();
    this.t.前に進む();
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine();
    this.t.右を向く();
    this.drawLine();
  }
}
class SquareTurtle extends CurveTurtle {
  void drawSquare() {
    this.drawCurve();
    this.t.右を向く();
    this.drawCurve();
  }
}`,
    finalBoard: `.......
###....
#.#....
###....
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 1, color: '#', dir: 'W' }],
  },
  override1: {
    title: 'オーバーライド(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'override1',
    authoringSeed: 'source-expansion-v1:override1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    FastTurtle t = new FastTurtle();
    t.drawLine();
  }
}
class MyTurtle {
  Turtle t = new Turtle();

  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() {
    return 2;
  }
}
class FastTurtle extends MyTurtle {
  @Override int length() {
    return 3;
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
  override2: {
    title: 'オーバーライド(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'override2',
    authoringSeed: 'source-expansion-v1:override2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    SuperFastTurtle t = new SuperFastTurtle();
    t.drawLine();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() {
    return 2;
  }
}
class FastTurtle extends MyTurtle {
  @Override int length() {
    // 親クラス (MyTurtle) の length() を呼び出す。
    return super.length() + 1;
  }
}
class SuperFastTurtle extends FastTurtle {
  @Override int length() {
    // 親クラス (FastTurtle) の length() を呼び出す。
    return super.length() + 1;
  }
}`,
    finalBoard: `#......
#......
#......
#......
#......
.......
.......`,
    finalTurtles: [{ x: 0, y: 4, color: '#', dir: 'N' }],
  },
  override3: {
    title: 'オーバーライド(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'override3',
    authoringSeed: 'source-expansion-v1:override3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    FastCurveTurtle t = new FastCurveTurtle();
    t.draw();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void draw() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() {
    return 2;
  }
}
class FastCurveTurtle extends MyTurtle {
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
    this.t.右を向く();
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
  }
  @Override int length() {
    // 親クラス (MyTurtle) の length() を呼び出す。
    return super.length() + 1;
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
  polymorphism1: {
    title: 'ポリモルフィズム(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'polymorphism1',
    authoringSeed: 'source-expansion-v1:polymorphism1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new MyTurtle(0, 0),
      new FastTurtle(1)
    };
    for (int i = 0; i < ts.length; i++) {
      ts[i].drawLine();
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void drawLine() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() { return 3; }
}`,
    finalBoard: `#......
##.....
##.....
.#.....
.#.....
.......
.......`,
    finalTurtles: [
      { x: 0, y: 2, color: '#', dir: 'N' },
      { x: 1, y: 4, color: '#', dir: 'N' },
    ],
  },
  polymorphism2: {
    title: 'ポリモルフィズム(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'polymorphism2',
    authoringSeed: 'source-expansion-v1:polymorphism2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new FastTurtle(3),
      new CurveTurtle(0)
    };
    for (int i = 0; i < ts.length; i++) {
      ts[i].draw();
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void draw() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() { return 3; }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p + 1);
  }
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
    this.t.右を向く();
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
  }
}`,
    finalBoard: `.......
#......
#......
####...
...#...
...#...
...#...`,
    finalTurtles: [
      { x: 3, y: 6, color: '#', dir: 'N' },
      { x: 2, y: 3, color: '#', dir: 'E' },
    ],
  },
  polymorphism3: {
    title: 'ポリモルフィズム(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    sourceProblemId: 'polymorphism3',
    authoringSeed: 'source-expansion-v1:polymorphism3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle[] ts = {
      new MyTurtle(0, 0),
      new FastTurtle(3),
      new CurveTurtle(2)
    };
    for (int i = 0; i < ts.length; i++) {
      ts[i].draw();
      ts[i].t.右を向く();
      ts[i].draw();
    }
  }
}
class MyTurtle {
  Turtle t;
  MyTurtle(int x, int y) {
    this.t = new Turtle(x, y);
  }
  void draw() {
    for (int i = 0; i < this.length(); i++) {
      this.t.前に進む();
    }
  }
  int length() { return 2; }
}
class FastTurtle extends MyTurtle {
  FastTurtle(int p) {
    super(p, p);
  }
  @Override int length() { return 3; }
}
class CurveTurtle extends MyTurtle {
  CurveTurtle(int p) {
    super(p, p + 1);
  }
  @Override void draw() {
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
    this.t.右を向く();
    // 親クラス (MyTurtle) の draw() を呼び出す。
    super.draw();
  }
}`,
    finalBoard: `#......
#......
###....
..###..
..###..
..###..
...####`,
    finalTurtles: [
      { x: 2, y: 2, color: '#', dir: 'E' },
      { x: 6, y: 6, color: '#', dir: 'E' },
      { x: 2, y: 3, color: '#', dir: 'W' },
    ],
  },
  overload1: {
    title: 'オーバーロード(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overload1',
    authoringSeed: 'source-expansion-v1:overload1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle();
    t.drawCurve();
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(3);
    this.t.右を向く();
    this.drawLine();
  }
}`,
    finalBoard: `#......
#......
#......
###....
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 3, color: '#', dir: 'E' }],
  },
  overload2: {
    title: 'オーバーロード(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overload2',
    authoringSeed: 'source-expansion-v1:overload2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.operate(0);
    t.operate("right");
    t.operate("up");
    t.operate(1);
    t.operate(0);
  }
}
class MyTurtle {
  private Turtle t = new Turtle(0, 0);
  public void operate(int n) {
    if (n == 0) {
      this.t.前に進む();
    } else if (n == 1) {
      this.t.右を向く();
      this.t.前に進む();
      this.t.左を向く();
    }
  }
  public void operate(String s) {
    if (s.equals("up")) {
      operate(0);
    } else if (s.equals("right")) {
      operate(1);
    }
  }
}`,
    finalBoard: `#......
##.....
.##....
..#....
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 3, color: '#', dir: 'N' }],
  },
  overload3: {
    title: 'オーバーロード(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overload3',
    authoringSeed: 'source-expansion-v1:overload3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle();
    t.drawLine(max(2, 3));
    t.t.右を向く();
    t.drawLine(max(2, 3, 4));
    t.t.右を向く();
    t.drawLine(max(2, 1));
    t.t.右を向く();
    t.drawLine(max(3, 2, 1));
    t.t.右を向く();
  }
  public static int max(int a, int b) {
    if (a > b) return a;
    else return b;
  }
  public static int max(int a, int b, int c) {
    if (a >= b && a >= c) return a;
    else if (b >= c) return b;
    else return c;
  }
}
class MyTurtle {
  public Turtle t = new Turtle();
  public void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
}`,
    finalBoard: `#......
#####..
#...#..
#####..
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 1, color: '#', dir: 'N' }],
  },
  overload4: {
    title: 'オーバーロード(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overload4',
    authoringSeed: 'source-expansion-v1:overload4',
    correctProgram: `public class Main {
  public static void main(String[] a) {
    MyTurtle t = new MyTurtle();
    t.move(2);
    t.move(1, 3);
    t.move(-3);
    t.move(-1, 0);
    t.move(4, 2);
    t.move(0, -4);
  }
}
class MyTurtle {
  private Turtle t = new Turtle(0, 0);
  public void move(int dy) {
    while (dy > 0) {
      dy--;
      this.t.前に進む();
    }
    while (dy < 0) {
      dy++;
      this.t.後に戻る();
    }
  }
  public void move(int dx, int dy) {
    move(dy);
    if (dx != 0) {
      this.t.右を向く();
      while (dx > 0) {
        dx--;
        this.t.前に進む();
      }
      while (dx < 0) {
        dx++;
        this.t.後に戻る();
      }
      this.t.左を向く();
    }
  }
}`,
    finalBoard: `#...#..
#...#..
##..#..
##..#..
#####..
##.....
.......`,
    finalTurtles: [{ x: 4, y: 0, color: '#', dir: 'N' }],
  },
  overloadAndOverride1: {
    title: 'オーバーロードとオーバーライド(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overloadAndOverride1',
    authoringSeed: 'source-expansion-v1:overloadAndOverride1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m2 = new MyTurtle2();
    m2.drawLine();
    MyTurtle m3 = new MyTurtle3();
    m3.drawLine();
    MyTurtle[] ms = { m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く();
      m.drawLine();
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(4);
  }
}
class MyTurtle3 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3);
  }
}`,
    finalBoard: `#......
#......
#......
####...
#####..
.......
.......`,
    finalTurtles: [
      { x: 4, y: 4, color: '#', dir: 'E' },
      { x: 3, y: 3, color: '#', dir: 'E' },
    ],
  },
  overloadAndOverride2: {
    title: 'オーバーロードとオーバーライド(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overloadAndOverride2',
    authoringSeed: 'source-expansion-v1:overloadAndOverride2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m2 = new MyTurtle2();
    m2.drawLine(2);
    MyTurtle m3 = new MyTurtle3();
    m3.drawLine(1);
    MyTurtle[] ms = { m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く();
      m.drawLine();
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3);
  }
}
class MyTurtle3 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(4);
  }
}`,
    finalBoard: `#......
#####..
####...
.......
.......
.......
.......`,
    finalTurtles: [
      { x: 3, y: 2, color: '#', dir: 'E' },
      { x: 4, y: 1, color: '#', dir: 'E' },
    ],
  },
  overloadAndOverride3: {
    title: 'オーバーロードとオーバーライド(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    sourceProblemId: 'overloadAndOverride3',
    authoringSeed: 'source-expansion-v1:overloadAndOverride3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m1 = new MyTurtle();
    m1.drawLine(4);
    MyTurtle m2 = new MyTurtle2();
    m2.drawLine(3);
    MyTurtle m3 = new MyTurtle3();
    m3.drawLine(1);
    MyTurtle[] ms = { m1, m2, m3 };
    for (MyTurtle m : ms) {
      m.t.右を向く();
      m.drawLine();
    }
  }
}
class MyTurtle {
  Turtle t = new Turtle();
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++)
      this.t.前に進む();
  }
  void drawLine() {
    this.drawLine(2);
  }
}
class MyTurtle2 extends MyTurtle {
  @Override void drawLine() {
    this.drawLine(3);
  }
}
class MyTurtle3 extends MyTurtle2 {
  @Override void drawLine(int steps) {
    // MyTurtleクラスの "drawLine(int steps)" を呼ぶ。
    super.drawLine(steps * 2);
  }
}`,
    finalBoard: `#......
#......
#######
####...
###....
.......
.......`,
    finalTurtles: [
      { x: 2, y: 4, color: '#', dir: 'E' },
      { x: 3, y: 3, color: '#', dir: 'E' },
      { x: 6, y: 2, color: '#', dir: 'E' },
    ],
  },
  exception1: {
    title: '例外(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'exception1',
    authoringSeed: 'source-expansion-v1:exception1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (Exception e) {
      m.t.右を向く();
      m.t.前に進む();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    for (int i = 0; i < 4; i++) {
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
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
##.....`,
    finalTurtles: [{ x: 1, y: 6, color: '#', dir: 'E' }],
  },
  exception3: {
    title: '例外(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'exception3',
    authoringSeed: 'source-expansion-v1:exception3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (Exception e) {
      m.t.右を向く();
      m.t.前に進む();
      m.t.左を向く();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    for (int i = 0; i < 4; i++) {
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
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
##.....`,
    finalTurtles: [{ x: 1, y: 6, color: '#', dir: 'N' }],
  },
  exception4: {
    title: '例外(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'exception4',
    authoringSeed: 'source-expansion-v1:exception4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (Exception e) {
      m.t.前に進む();
      m.t.右を向く();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) {
        if (!t.前に進めるか()) {
          throw new RuntimeException("前に進めない！");
        }
        this.t.前に進む();
      }
    } catch (RuntimeException e) {
      t.右を向く();
      throw e; // catchした例外をもう一度throwする。
    }
  }
}`,
    finalBoard: `#......
#......
#......
#......
#......
#......
##.....`,
    finalTurtles: [{ x: 1, y: 6, color: '#', dir: 'S' }],
  },
  originalException1: {
    title: '独自に定義した例外(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'originalException1',
    authoringSeed: 'source-expansion-v1:originalException1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    m.drawLine();
    m.drawLine();
  }
}

class OutOfBoardException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() {
    try {
      for (int i = 0; i < 4; i++) {
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        this.t.前に進む();
      }
    } catch (Exception e) {
      this.t.右を向く();
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
##.....`,
    finalTurtles: [{ x: 1, y: 6, color: '#', dir: 'E' }],
  },
  originalException2: {
    title: '独自に定義した例外(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'originalException2',
    authoringSeed: 'source-expansion-v1:originalException2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawLine();
      m.drawLine();
    } catch (OutOfBoardException e) {
      m.t.右を向く();
      m.t.前に進む();
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawLine() throws OutOfBoardException {
    for (int i = 0; i < 4; i++) {
      if (!this.t.前に進めるか()) {
        throw new OutOfBoardException();
      }
      this.t.前に進む();
    }
  }
}

class OutOfBoardException extends Exception { }`,
    finalBoard: `#......
#......
#......
#......
#......
#......
##.....`,
    finalTurtles: [{ x: 1, y: 6, color: '#', dir: 'E' }],
  },
  originalException3: {
    title: '独自に定義した例外(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'originalException3',
    authoringSeed: 'source-expansion-v1:originalException3',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawSquare();
    } catch (OutOfBoardException e) {
      m.t.右を向く();
      m.t.前に進む();
    } catch (ColoredException e) {
      m.t.前に進む();
      m.t.左を向く();
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle();

  public void drawSquare()
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) {
      if (!this.t.前に進めるか()) {
        throw new OutOfBoardException();
      }
      if (this.t.前のマスが塗られているか()) {
        throw new ColoredException();
      }
      this.t.前に進む();
      this.t.右を向く();
    }
  }
}`,
    finalBoard: `##.....
##.....
.......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'S' }],
  },
  originalException4: {
    title: '独自に定義した例外(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'originalException4',
    authoringSeed: 'source-expansion-v1:originalException4',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    try {
      m.drawSquare();
    } catch (Exception e) {
      m.t.左を向く();
      m.t.左を向く();
      m.t.前に進む();
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(5, 4);

  public void drawSquare()
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < 2; j++) {
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        if (this.t.前のマスが塗られているか()) {
          throw new ColoredException();
        }
        this.t.前に進む();
      }
      this.t.右を向く();
    }
  }
}`,
    finalBoard: `.......
.......
.......
.......
.....#.
.....#.
.....##`,
    finalTurtles: [{ x: 5, y: 6, color: '#', dir: 'W' }],
  },
  originalException5: {
    title: '独自に定義した例外(5)',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    sourceProblemId: 'originalException5',
    authoringSeed: 'source-expansion-v1:originalException5',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle();
    for (int n = 0; n < 3; n++) {
      try {
        m.drawSquare(n + 1);
      } catch (OutOfBoardException e) {
        m.t.右を向く();
        m.t.右を向く();
      } catch (ColoredException e) {
        m.t.前に進む();
        m.t.前に進む();
      }
    }
  }
}

class OutOfBoardException extends Exception { }
class ColoredException extends Exception { }

class MyTurtle {
  public Turtle t = new Turtle(5, 5);

  public void drawSquare(int size)
        throws OutOfBoardException, ColoredException {
    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < size; j++) {
        if (!this.t.前に進めるか()) {
          throw new OutOfBoardException();
        }
        if (this.t.前のマスが塗られているか()) {
          throw new ColoredException();
        }
        this.t.前に進む();
      }
      this.t.右を向く();
    }
  }
}`,
    finalBoard: `.......
.......
.......
.......
..#....
..#####
..#..##`,
    finalTurtles: [{ x: 2, y: 4, color: '#', dir: 'S' }],
  },
  twoDimensionalArray1: {
    title: '二次元配列(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'twoDimensionalArray1',
    authoringSeed: 'source-expansion-v1:twoDimensionalArray1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    int [][] arr = { { 0, 3 }, { 1, 1 }, { 0, 2 },
                     { 2, 3 }, { 0, 1 }, };
    Turtle t = new Turtle();
    for (int i = 0; i < arr.length; i++) {
      int c = arr[i][1];
      switch (arr[i][0]) {
        case 0:
          for (int j = 0; j < c; j++) {
            t.前に進む();
          }
          break;
        case 1:
          for (int j = 0; j < c; j++) {
            t.右を向く();
          }
          break;
        case 2:
          for (int j = 0; j < c; j++) {
            t.左を向く();
          }
          break;
      }
    }
  }
}`,
    finalBoard: `#......
#......
#.#....
###....
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 2, color: '#', dir: 'S' }],
  },
  twoDimensionalArray2: {
    title: '二次元配列(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'twoDimensionalArray2',
    authoringSeed: 'source-expansion-v1:twoDimensionalArray2',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    int [][] arr = { { 0, 3 }, { 1 }, { 0, 2 },
                     { 2 }, { 0, 1 }, };
    Turtle t = new Turtle();
    for (int i = 0; i < arr.length; i++) {
      switch (arr[i][0]) {
        case 0:
          int c = arr[i][1];
          for (int j = 0; j < c; j++) {
            t.前に進む();
          }
          break;
        case 1:
          t.右を向く();
          break;
        case 2:
          t.左を向く();
          break;
      }
    }
  }
}`,
    finalBoard: `#......
#......
#......
###....
..#....
.......
.......`,
    finalTurtles: [{ x: 2, y: 4, color: '#', dir: 'N' }],
  },
  twoDimensionalArray3: {
    title: '二次元配列(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'twoDimensionalArray3',
    authoringSeed: 'source-expansion-v1:twoDimensionalArray3',
    correctProgram: `public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][] arr = {
      { FORWARD, 3 },
      { TURN_RIGHT },
      { FORWARD, 2 },
      { TURN_LEFT },
      { FORWARD, 1 }
    };

    Turtle t = new Turtle();
    for (int i = 0; i < arr.length; i++) {
      moveTurtle(t, arr[i]);
    }
  }

  private static void moveTurtle(Turtle t, int[] command) {
    switch (command[0]) {
      case FORWARD:
        int steps = command[1];
        for (int j = 0; j < steps; j++) {
          t.前に進む();
        }
        break;
      case TURN_RIGHT:
        t.右を向く();
        break;
      case TURN_LEFT:
        t.左を向く();
        break;
    }
  }
}`,
    finalBoard: `#......
#......
#......
###....
..#....
.......
.......`,
    finalTurtles: [{ x: 2, y: 4, color: '#', dir: 'N' }],
  },
  twoDimensionalArray4: {
    title: '二次元配列(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'twoDimensionalArray4',
    authoringSeed: 'source-expansion-v1:twoDimensionalArray4',
    correctProgram: `public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;
  private static final int PUT_TURTLE = 3;

  public static void main(String[] args) {
    int[][] arr = {
      { PUT_TURTLE, 1, 2 },
      { FORWARD, 3 },
      { TURN_RIGHT },
      { FORWARD, 2 },
      { TURN_LEFT },
      { FORWARD, 1 }
    };

    Turtle turtle = null;
    for (int i = 0; i < arr.length; i++) {
      int command = arr[i][0];
      switch (command) {
        case PUT_TURTLE:
          turtle = new Turtle(arr[i][1], arr[i][2]);
          break;
        case FORWARD:
          int steps = arr[i][1];
          for (int j = 0; j < steps; j++) {
            turtle.前に進む();
          }
          break;
        case TURN_RIGHT:
          turtle.右を向く();
          break;
        case TURN_LEFT:
          turtle.左を向く();
          break;
      }
    }
  }
}`,
    finalBoard: `.......
.......
.#.....
.#.....
.#.....
.###...
...#...`,
    finalTurtles: [{ x: 3, y: 6, color: '#', dir: 'N' }],
  },
  twoDimensionalArray6: {
    title: '二次元配列(6)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'twoDimensionalArray6',
    authoringSeed: 'source-expansion-v1:twoDimensionalArray6',
    correctProgram: `public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][] commands = {
      { FORWARD, FORWARD, FORWARD, FORWARD },
      { FORWARD, FORWARD, TURN_RIGHT, FORWARD, FORWARD },
      { TURN_LEFT, FORWARD, TURN_RIGHT, FORWARD }
    };

    Turtle[] turtles = new Turtle[commands.length];
    for (int nthTurtle = 0; nthTurtle < commands.length; nthTurtle++) {
      turtles[nthTurtle] = new Turtle(nthTurtle, 0);
    }

    for (int nthTurtle = 0; nthTurtle < commands.length; nthTurtle++) {
      for (int i = 0; i < commands[nthTurtle].length; i++) {
        int command = commands[nthTurtle][i];
        switch (command) {
          case FORWARD:
            turtles[nthTurtle].前に進む();
            break;
          case TURN_RIGHT:
            turtles[nthTurtle].右を向く();
            break;
          case TURN_LEFT:
            turtles[nthTurtle].左を向く();
            break;
        }
      }
    }
  }
}`,
    finalBoard: `###....
##.....
####...
#......
#......
.......
.......`,
    finalTurtles: [
      { x: 0, y: 4, color: '#', dir: 'N' },
      { x: 3, y: 2, color: '#', dir: 'E' },
      { x: 1, y: 1, color: '#', dir: 'N' },
    ],
  },
  threeDimensionalArray1: {
    title: '三次元配列(1)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'threeDimensionalArray1',
    authoringSeed: 'source-expansion-v1:threeDimensionalArray1',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    int[][][] a = { { {0, 0}, {1, 1}, {0, 3} },
                    { {5, 2}, {2, 1}, {0, 4} } };
    Turtle[] turtles = new Turtle[a.length];
    for (int i = 0; i < a.length; i++) {
      turtles[i] = new Turtle(a[i][0][0], a[i][0][1]);
      for (int j = 1; j < a[i].length; j++) {
        int c = a[i][j][1];
        switch (a[i][j][0]) {
          case 0:
            for (int k = 0; k < c; k++) {
              turtles[i].前に進む();
            }
            break;
          case 1:
            for (int k = 0; k < c; k++) {
              turtles[i].右を向く();
            }
            break;
          case 2:
            for (int k = 0; k < c; k++) {
              turtles[i].左を向く();
            }
            break;
        }
      }
    }
  }
}`,
    finalBoard: `####...
.......
.#####.
.......
.......
.......
.......`,
    finalTurtles: [
      { x: 3, y: 0, color: '#', dir: 'E' },
      { x: 1, y: 2, color: '#', dir: 'W' },
    ],
  },
  threeDimensionalArray2: {
    title: '三次元配列(2)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'threeDimensionalArray2',
    authoringSeed: 'source-expansion-v1:threeDimensionalArray2',
    correctProgram: `public class Main {
  private static final int FORWARD = 0;
  private static final int RIGHT = 1;
  private static final int LEFT = 2;

  public static void main(String[] args) {
    int[][][] arr = {
      { {0, 0}, {RIGHT, 1}, {FORWARD, 1} },
      { {3, 1}, {FORWARD, 3}, {RIGHT, 2}, {FORWARD, 1} },
      { {4, 5}, {LEFT, 3}, {FORWARD, 2} },
    };
    Turtle[] turtles = new Turtle[arr.length];
    for (int i = 0; i < arr.length; i++) {
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]);
      for (int j = 1; j < arr[i].length; j++) {
        int command = arr[i][j][0];
        int times = arr[i][j][1];
        switch (command) {
          case FORWARD:
            for (int k = 0; k < times; k++) {
              turtles[i].前に進む();
            }
            break;
          case RIGHT:
            for (int k = 0; k < times; k++) {
              turtles[i].右を向く();
            }
            break;
          case LEFT:
            for (int k = 0; k < times; k++) {
              turtles[i].左を向く();
            }
            break;
        }
      }
    }
  }
}`,
    finalBoard: `##.....
...#...
...#...
...#...
...#...
....###
.......`,
    finalTurtles: [
      { x: 1, y: 0, color: '#', dir: 'E' },
      { x: 3, y: 3, color: '#', dir: 'S' },
      { x: 6, y: 5, color: '#', dir: 'E' },
    ],
  },
  threeDimensionalArray3: {
    title: '三次元配列(3)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'threeDimensionalArray3',
    authoringSeed: 'source-expansion-v1:threeDimensionalArray3',
    correctProgram: `public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][][] arr = {
      { {0, 0}, {FORWARD, FORWARD, TURN_RIGHT, FORWARD} },
      { {2, 3}, {TURN_LEFT, FORWARD, FORWARD} }
    };
    Turtle[] turtles = new Turtle[arr.length];
    for (int i = 0; i < arr.length; i++) {
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]);
      for (int j = 0; j < arr[i][1].length; j++) {
        int command = arr[i][1][j];
        switch (command) {
          case FORWARD:
            turtles[i].前に進む();
            break;
          case TURN_RIGHT:
            turtles[i].右を向く();
            break;
          case TURN_LEFT:
            turtles[i].左を向く();
            break;
        }
      }
    }
  }
}`,
    finalBoard: `#......
#......
##.....
###....
.......
.......
.......`,
    finalTurtles: [
      { x: 1, y: 2, color: '#', dir: 'E' },
      { x: 0, y: 3, color: '#', dir: 'W' },
    ],
  },
  threeDimensionalArray4: {
    title: '三次元配列(4)',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    sourceProblemId: 'threeDimensionalArray4',
    authoringSeed: 'source-expansion-v1:threeDimensionalArray4',
    correctProgram: `public class Main {
  private static final int FORWARD = 0;
  private static final int TURN_RIGHT = 1;
  private static final int TURN_LEFT = 2;

  public static void main(String[] args) {
    int[][][] arr = {
      { {2, 1}, {FORWARD, TURN_LEFT, FORWARD, FORWARD} },
      { {3, 2}, {TURN_RIGHT, FORWARD, TURN_RIGHT} },
      { {1, 3}, {FORWARD, FORWARD, TURN_LEFT, FORWARD, TURN_LEFT} },
      { {3, 3}, {TURN_RIGHT, FORWARD, FORWARD, TURN_RIGHT, FORWARD} }
    };
    Turtle[] turtles = new Turtle[arr.length];
    for (int i = 0; i < arr.length; i++) {
      turtles[i] = new Turtle(arr[i][0][0], arr[i][0][1]);
      for (int j = 0; j < arr[i][1].length; j++) {
        int command = arr[i][1][j];
        switch (command) {
          case FORWARD:
            turtles[i].前に進む();
            break;
          case TURN_RIGHT:
            turtles[i].右を向く();
            break;
          case TURN_LEFT:
            turtles[i].左を向く();
            break;
        }
      }
    }
  }
}`,
    finalBoard: `.......
..#....
######.
.#.###.
.#.....
##.....
.......`,
    finalTurtles: [
      { x: 0, y: 2, color: '#', dir: 'W' },
      { x: 4, y: 2, color: '#', dir: 'S' },
      { x: 0, y: 5, color: '#', dir: 'S' },
      { x: 5, y: 2, color: '#', dir: 'S' },
    ],
  },
} satisfies Record<string, SourceJavaModel>;
