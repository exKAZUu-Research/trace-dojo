export const challengeFillInBlankProblemDefinitions = {
  straightBlank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        @[亀.前に進む();]@ // step\n        亀.前に進む(); // step\n    }\n}',
  straightSecondBlank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        亀.前に進む(); // step\n        @[亀.前に進む();]@ // step\n    }\n}',
  square1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        亀.前に進む(); // step\n        @[亀.右を向く();]@ // step\n        亀.前に進む(); // step\n        亀.右を向く(); // step\n        亀.前に進む(); // step\n    }\n}',
  while1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        int i = 0; // step\n        while (i < <3-5>) {\n            亀.前に進む(); // step\n            @[i++;]@ // step\n        }\n    }\n}',
  doubleLoop1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        for (int i = 0; i < <2-3>; i++) { // step\n            for (int j = 0; j < <2-3>; j++) { // step\n                t.前に進む(); // step\n            }\n            @[t.右を向く();]@ // step\n        }\n    }\n}',
  elseIf1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        for (int i = 0; i < <4-6>; i++) { // step\n            if (i < 2)\n                t.前に進む(); // step\n            else if (i == 2)\n                @[t.左を向く();]@ // step\n            else\n                t.後に戻る(); // step\n        }\n    }\n}',
  break1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        while (true) {\n            if (!t.前に進めるか()) break;\n            @[t.前に進む();]@ // step\n        }\n    }\n}',
  method1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step: 1\n        二歩前に進める(t); // caller\n        @[t.右を向く();]@ // step: 2\n        三歩前に進める(t); // caller\n    }\n    static void 二歩前に進める(Turtle t) {\n        t.前に進む(); // step: 3\n        t.前に進む(); // step: 4\n    }\n    static void 三歩前に進める(Turtle t) {\n        t.前に進む(); // step: 5\n        t.前に進む(); // step: 6\n        t.前に進む(); // step: 7\n    }\n}',
  array1Blank:
    'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        int[] arr = { 2, <1-2>, <1-2> }; // step\n        for (int i = 0; i < arr.length; i++) { // step\n            N歩前に進める(t, arr[i]); // caller\n            @[t.右を向く();]@ // step\n        }\n    }\n    static void N歩前に進める(Turtle t, int n) {\n        for (int i = 0; i < n; i++) { // step\n            t.前に進む(); // step\n        }\n    }\n}',
  multiObject1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    Turtle t1 = new Turtle(1, 1); // step\n    Turtle t2 = new Turtle(3, 3); // step\n    t1.前に進む(); // step\n    @[t1.右を向く();]@ // step\n    t2.前に進む(); // step\n    t2.左を向く(); // step\n  }\n}',
  makeClass1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    MyTurtle t = new MyTurtle(); // caller\n    t.moveForward(); // caller\n    @[t.speed = 1;]@ // step\n    t.moveForward(); // caller\n  }\n}\n\nclass MyTurtle {\n  Turtle t = new Turtle(); // step\n  int speed = 2; // step\n\n  void moveForward() {\n    for (int i = 0; i < this.speed; i++) { // step\n      this.t.前に進む(); // step\n    }\n  }\n}',
  encapsulationBlank:
    'public class Main {\n  public static void main(String[] args) {\n    MyTurtle t = new MyTurtle(); // caller\n    t.moveForward(); // caller\n    @[t.changeSpeed(1);]@ // caller\n    t.moveForward(); // caller\n  }\n}\n\nclass MyTurtle {\n  private Turtle t = new Turtle(); // step\n  private int speed = 2; // step\n\n  public void moveForward() {\n    for (int i = 0; i < this.speed; i++) { // step\n      this.t.前に進む(); // step\n    }\n  }\n  public void changeSpeed(int speed) {\n    this.speed = speed; // step\n  }\n}',
  staticMethod1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    Turtle t1 = new Turtle(1, 1); // step\n    @[Controller.moveTwoSteps(t1);]@ // caller\n    Turtle t2 = new Turtle(3, 3); // step\n    Controller.moveTwoSteps(t2); // caller\n  }\n}\n\nclass Controller {\n  static void moveTwoSteps(Turtle t) {\n    t.前に進む(); // step\n    t.前に進む(); // step\n  }\n}',
  inheritance1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    CurveTurtle t = new CurveTurtle(); // caller\n    @[t.drawCurve();]@ // caller\n  }\n}\nclass MyTurtle {\n  Turtle t = new Turtle(); // step\n\n  void drawLine() {\n    this.t.前に進む(); // step\n    this.t.前に進む(); // step\n  }\n}\nclass CurveTurtle extends MyTurtle {\n  void drawCurve() {\n    this.drawLine(); // caller\n    this.t.右を向く(); // step\n    this.drawLine(); // caller\n  }\n}',
  exception1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    MyTurtle m = new MyTurtle(); // caller\n    try {\n      m.drawLine(); // caller\n      m.drawLine(); // caller\n    } catch (Exception e) {\n      @[m.t.右を向く();]@ // step\n      m.t.前に進む(); // step\n    }\n  }\n}\n\nclass MyTurtle {\n  public Turtle t = new Turtle(); // step\n\n  public void drawLine() {\n    for (int i = 0; i < 4; i++) { // step\n      if (!t.前に進めるか()) {\n        throw new RuntimeException("前に進めない！");\n      }\n      this.t.前に進む(); // step\n    }\n  }\n}',
  twoDimensionalArray1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    int [][] arr = { { 0, 3 }, { 1, 1 }, { 0, 2 },\n                     { 2, 3 }, { 0, 1 }, };\n    Turtle t = new Turtle(); // step\n    for (int i = 0; i < arr.length; i++) { // step\n      @[int c = arr[i][1];]@ // step\n      switch (arr[i][0]) {\n        case 0:\n          for (int j = 0; j < c; j++) { // step\n            t.前に進む(); // step\n          }\n          break;\n        case 1:\n          for (int j = 0; j < c; j++) { // step\n            t.右を向く(); // step\n          }\n          break;\n        case 2:\n          for (int j = 0; j < c; j++) { // step\n            t.左を向く(); // step\n          }\n          break;\n      }\n    }\n  }\n}',
  test1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    Turtle c = new Turtle(); // step\n    @[c.forward();]@ // step\n    c.forward(); // step\n    c.forward(); // step\n  }\n}',
  overload1Blank:
    'public class Main {\n  public static void main(String[] args) {\n    CurveTurtle t = new CurveTurtle(); // caller\n    @[t.drawCurve();]@ // caller\n  }\n}\nclass MyTurtle {\n  Turtle t = new Turtle(); // step\n  void drawLine(int steps) {\n    for (int i = 0; i < steps; i++) // step\n      this.t.前に進む(); // step\n  }\n  void drawLine() {\n    this.drawLine(2); // caller\n  }\n}\nclass CurveTurtle extends MyTurtle {\n  void drawCurve() {\n    this.drawLine(3); // caller\n    this.t.右を向く(); // step\n    this.drawLine(); // caller\n  }\n}',
} as const satisfies Record<string, string>;
