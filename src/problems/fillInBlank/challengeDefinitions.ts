import type { LanguageId } from '../problemData';

export const challengeFillInBlankProblemDefinitions = {
  straightBlank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        @[亀.前に進む();]@ // step\n        亀.前に進む(); // step\n    }\n}',
    instrumented: 'const t = new Turtle(); // step\n@[t.forward();]@\nt.forward();',
  },
  straightSecondBlank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        亀.前に進む(); // step\n        @[亀.前に進む();]@ // step\n    }\n}',
    instrumented: 'const t = new Turtle(); // step\n@[t.forward();]@\nt.forward();',
  },
  square1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        亀.前に進む(); // step\n        @[亀.右を向く();]@ // step\n        亀.前に進む(); // step\n        亀.右を向く(); // step\n        亀.前に進む(); // step\n    }\n}',
    instrumented:
      'const t = new Turtle(); // step\nt.forward();\n@[t.turnRight();]@\nt.forward();\nt.turnRight();\nt.forward();',
  },
  while1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle 亀 = new Turtle(); // step\n        int i = 0; // step\n        while (i < <3-5>) {\n            亀.前に進む(); // step\n            @[i++;]@ // step\n        }\n    }\n}',
    instrumented:
      "const t = new Turtle(); // step\ns.set('i', 0);\nwhile (s.get('i') < <3-5>) {\n  t.forward();\n  @[s.set('i', s.get('i') + 1);]@\n}",
  },
  doubleLoop1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        for (int i = 0; i < <2-3>; i++) { // step\n            for (int j = 0; j < <2-3>; j++) { // step\n                t.前に進む(); // step\n            }\n            @[t.右を向く();]@ // step\n        }\n    }\n}',
    instrumented:
      "const t = new Turtle(); // step\nfor (s.set('i', 0); s.get('i') < <2-3>; s.set('i', s.get('i') + 1)) {\n  for (s.set('j', 0); s.get('j') < <2-3>; s.set('j', s.get('j') + 1)) {\n      t.forward();\n  }\n  delete s.vars['j'];\n  @[t.turnRight();]@\n}\ndelete s.vars['i'];",
  },
  elseIf1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        for (int i = 0; i < <4-6>; i++) { // step\n            if (i < 2)\n                t.前に進む(); // step\n            else if (i == 2)\n                @[t.左を向く();]@ // step\n            else\n                t.後に戻る(); // step\n        }\n    }\n}',
    instrumented:
      "const t = new Turtle(); // step\nfor (s.set('i', 0); s.get('i') < <4-6>; s.set('i', s.get('i') + 1)) {\n  if (s.get('i') < 2) {\n    t.forward();\n  } else if (s.get('i') === 2) {\n    @[t.turnLeft();]@\n  } else {\n    t.backward();\n  }\n}\ndelete s.vars['i'];",
  },
  break1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        while (true) {\n            if (!t.前に進めるか()) break;\n            @[t.前に進む();]@ // step\n        }\n    }\n}',
    instrumented:
      'const t = new Turtle(); // step\nwhile (true) {\n  if (!t.canMoveForward()) break;\n  @[t.forward();]@\n}',
  },
  method1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step: 1\n        二歩前に進める(t); // caller\n        @[t.右を向く();]@ // step: 2\n        三歩前に進める(t); // caller\n    }\n    static void 二歩前に進める(Turtle t) {\n        t.前に進む(); // step: 3\n        t.前に進む(); // step: 4\n    }\n    static void 三歩前に進める(Turtle t) {\n        t.前に進む(); // step: 5\n        t.前に進む(); // step: 6\n        t.前に進む(); // step: 7\n    }\n}',
    instrumented:
      "const t = new Turtle(); // step\ncall(forwardTwoSteps, 't')(t);\n@[t.turnRight();]@\ncall(threeStepsForward, 't')(t);\n\nfunction forwardTwoSteps(t) {\n  t.forward();\n  t.forward();\n}\n\nfunction threeStepsForward(t) {\n  t.forward();\n  t.forward();\n  t.forward();\n}",
  },
  array1Blank: {
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle(); // step\n        int[] arr = { 2, <1-2>, <1-2> }; // step\n        for (int i = 0; i < arr.length; i++) { // step\n            N歩前に進める(t, arr[i]); // caller\n            @[t.右を向く();]@ // step\n        }\n    }\n    static void N歩前に進める(Turtle t, int n) {\n        for (int i = 0; i < n; i++) { // step\n            t.前に進む(); // step\n        }\n    }\n}',
    instrumented:
      "const t = new Turtle(); // step\ns.set('arr', [2, <1-2>, <1-2>]);\nfor (s.set('i', 0); s.get('i') < s.get('arr').length; s.set('i', s.get('i') + 1)) {\n  call(forwardGivenSteps, 't', 'n')(t, s.get('arr')[s.get('i')]);\n  @[t.turnRight();]@\n}\ndelete s.vars['i'];\n\nfunction forwardGivenSteps(t, n) {\n  for (s.set('i', 0); s.get('i') < n; s.set('i', s.get('i') + 1)) {\n    t.forward();\n  }\n  delete s.vars['i'];\n}",
  },
  multiObject1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle t1 = new Turtle(1, 1); // step\n    Turtle t2 = new Turtle(3, 3); // step\n    t1.前に進む(); // step\n    @[t1.右を向く();]@ // step\n    t2.前に進む(); // step\n    t2.左を向く(); // step\n  }\n}',
    instrumented:
      'const t1 = new Turtle(1, 1); // step\nconst t2 = new Turtle(3, 3); // step\nt1.前に進む(); // step\n@[t1.右を向く();]@ // step\nt2.前に進む(); // step\nt2.左を向く(); // step',
  },
  makeClass1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    MyTurtle t = new MyTurtle(); // caller\n    t.moveForward(); // caller\n    @[t.speed = 1;]@ // step\n    t.moveForward(); // caller\n  }\n}\n\nclass MyTurtle {\n  Turtle t = new Turtle(); // step\n  int speed = 2; // step\n\n  void moveForward() {\n    for (int i = 0; i < this.speed; i++) { // step\n      this.t.前に進む(); // step\n    }\n  }\n}',
    instrumented:
      "function main() {\n  const t = call(MyTurtle)();\n  call(t.moveForward.bind(t))();\n  @[t.speed = 1;]@ // step\n  call(t.moveForward.bind(t))();\n}\n\nclass MyTurtle {\n  constructor() {\n    this.t = new Turtle(); // step\n    this.speed = 2; // step\n  }\n  moveForward() {\n    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step\n      this.t.前に進む(); // step\n    }\n    delete s.vars['i'];\n  }\n}\n\nmain();",
  },
  encapsulationBlank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    MyTurtle t = new MyTurtle(); // caller\n    t.moveForward(); // caller\n    @[t.changeSpeed(1);]@ // caller\n    t.moveForward(); // caller\n  }\n}\n\nclass MyTurtle {\n  private Turtle t = new Turtle(); // step\n  private int speed = 2; // step\n\n  public void moveForward() {\n    for (int i = 0; i < this.speed; i++) { // step\n      this.t.前に進む(); // step\n    }\n  }\n  public void changeSpeed(int speed) {\n    this.speed = speed; // step\n  }\n}',
    instrumented:
      "function main() {\n  const t = call(MyTurtle)();\n  call(t.moveForward.bind(t))();\n  @[call(t.changeSpeed.bind(t), 'speed')(1);]@\n  call(t.moveForward.bind(t))();\n}\n\nclass MyTurtle {\n  constructor() {\n    this.t = new Turtle(); // step\n    this.speed = 2; // step\n  }\n\n  moveForward() {\n    for (s.set('i', 0); s.get('i') < this.speed; s.set('i', s.get('i') + 1)) { // step\n      this.t.前に進む(); // step\n    }\n    delete s.vars['i'];\n  }\n  changeSpeed(speed) {\n    this.speed = speed; // step\n  }\n}\n\nmain();",
  },
  staticMethod1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle t1 = new Turtle(1, 1); // step\n    @[Controller.moveTwoSteps(t1);]@ // caller\n    Turtle t2 = new Turtle(3, 3); // step\n    Controller.moveTwoSteps(t2); // caller\n  }\n}\n\nclass Controller {\n  static void moveTwoSteps(Turtle t) {\n    t.前に進む(); // step\n    t.前に進む(); // step\n  }\n}',
    instrumented:
      "const t1 = new Turtle(1, 1); // step\n@[call(moveTwoSteps, 't')(t1);]@\nconst t2 = new Turtle(3, 3); // step\ncall(moveTwoSteps, 't')(t2);\n\nfunction moveTwoSteps(t) {\n  t.前に進む(); // step\n  t.前に進む(); // step\n}",
  },
  inheritance1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    CurveTurtle t = new CurveTurtle(); // caller\n    @[t.drawCurve();]@ // caller\n  }\n}\nclass MyTurtle {\n  Turtle t = new Turtle(); // step\n\n  void drawLine() {\n    this.t.前に進む(); // step\n    this.t.前に進む(); // step\n  }\n}\nclass CurveTurtle extends MyTurtle {\n  void drawCurve() {\n    this.drawLine(); // caller\n    this.t.右を向く(); // step\n    this.drawLine(); // caller\n  }\n}',
    instrumented:
      'function main() {\n  const t = call(CurveTurtle)();\n  @[call(t.drawCurve.bind(t))();]@\n}\n\nclass MyTurtle {\n  constructor() {\n    this.t = new Turtle(); // step\n  }\n  drawLine() {\n    this.t.前に進む(); // step\n    this.t.前に進む(); // step\n  }\n}\n\nclass CurveTurtle extends MyTurtle {\n  drawCurve() {\n    call(this.drawLine.bind(this))();\n    this.t.右を向く(); // step\n    call(this.drawLine.bind(this))();\n  }\n}\nmain();',
  },
  exception1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    MyTurtle m = new MyTurtle(); // caller\n    try {\n      m.drawLine(); // caller\n      m.drawLine(); // caller\n    } catch (Exception e) {\n      @[m.t.右を向く();]@ // step\n      m.t.前に進む(); // step\n    }\n  }\n}\n\nclass MyTurtle {\n  public Turtle t = new Turtle(); // step\n\n  public void drawLine() {\n    for (int i = 0; i < 4; i++) { // step\n      if (!t.前に進めるか()) {\n        throw new RuntimeException("前に進めない！");\n      }\n      this.t.前に進む(); // step\n    }\n  }\n}',
    instrumented:
      "function main() {\n  const m = call(MyTurtle)();\n  try {\n    call(m.drawLine.bind(m))();\n    call(m.drawLine.bind(m))();\n  } catch (e) {\n    @[m.t.右を向く();]@ // step\n    m.t.前に進む(); // step\n  }\n}\n\nclass MyTurtle {\n  constructor() {\n    this.t = new Turtle(); // step\n  }\n\n  drawLine() {\n    for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) { // step\n      if (!this.t.前に進めるか()) {\n        delete s.vars['i'];\n        throw new Error(\"前に進めない！\");\n      }\n      this.t.前に進む(); // step\n    }\n    delete s.vars['i'];\n  }\n}\n\nmain();",
  },
  twoDimensionalArray1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    int [][] arr = { { 0, 3 }, { 1, 1 }, { 0, 2 },\n                     { 2, 3 }, { 0, 1 }, };\n    Turtle t = new Turtle(); // step\n    for (int i = 0; i < arr.length; i++) { // step\n      @[int c = arr[i][1];]@ // step\n      switch (arr[i][0]) {\n        case 0:\n          for (int j = 0; j < c; j++) { // step\n            t.前に進む(); // step\n          }\n          break;\n        case 1:\n          for (int j = 0; j < c; j++) { // step\n            t.右を向く(); // step\n          }\n          break;\n        case 2:\n          for (int j = 0; j < c; j++) { // step\n            t.左を向く(); // step\n          }\n          break;\n      }\n    }\n  }\n}',
    instrumented:
      "const arr = [[0, 3], [1, 1], [0, 2], [2, 3], [0, 1]];\nconst t = new Turtle(); // step\nfor (s.set('i', 0); s.get('i') < arr.length; s.set('i', s.get('i') + 1)) { // step\n  @[s.set('c', arr[s.get('i')][1]);]@ // step\n  switch (arr[s.get('i')][0]) {\n    case 0:\n      for (s.set('j', 0); s.get('j') < s.get('c'); s.set('j', s.get('j') + 1)) { // step\n        t.前に進む(); // step\n      }\n      break;\n    case 1:\n      for (s.set('j', 0); s.get('j') < s.get('c'); s.set('j', s.get('j') + 1)) { // step\n        t.右を向く(); // step\n      }\n      break;\n    case 2:\n      for (s.set('j', 0); s.get('j') < s.get('c'); s.set('j', s.get('j') + 1)) { // step\n        t.左を向く(); // step\n      }\n      break;\n  }\n  delete s.vars['c'];\n}\ndelete s.vars['i'];",
  },
  test1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    Turtle c = new Turtle(); // step\n    @[c.forward();]@ // step\n    c.forward(); // step\n    c.forward(); // step\n  }\n}',
    instrumented: 'const t = new Turtle(); // step\n@[t.forward();]@\nt.forward();\nt.forward();',
  },
  overload1Blank: {
    java: 'public class Main {\n  public static void main(String[] args) {\n    CurveTurtle t = new CurveTurtle(); // caller\n    @[t.drawCurve();]@ // caller\n  }\n}\nclass MyTurtle {\n  Turtle t = new Turtle(); // step\n  void drawLine(int steps) {\n    for (int i = 0; i < steps; i++) // step\n      this.t.前に進む(); // step\n  }\n  void drawLine() {\n    this.drawLine(2); // caller\n  }\n}\nclass CurveTurtle extends MyTurtle {\n  void drawCurve() {\n    this.drawLine(3); // caller\n    this.t.右を向く(); // step\n    this.drawLine(); // caller\n  }\n}',
    instrumented:
      "function main() {\n  const t = call(CurveTurtle)();\n  @[call(t.drawCurve.bind(t))();]@\n}\n\nclass MyTurtle {\n  constructor() {\n    this.t = new Turtle(); // step\n  }\n  drawLine(steps) {\n    for (s.set('i', 0); s.get('i') < steps; s.set('i', s.get('i') + 1)) { // step\n      this.t.前に進む(); // step\n    }\n    delete s.vars['i'];\n  }\n  drawLine2() {\n    call(this.drawLine.bind(this), 'steps')(2);\n  }\n}\n\nclass CurveTurtle extends MyTurtle {\n  drawCurve() {\n    call(this.drawLine.bind(this), 'steps')(3);\n    this.t.右を向く(); // step\n    call(this.drawLine2.bind(this))();\n  }\n}\n\nmain();",
  },
} as const satisfies Record<string, Record<LanguageId, string>>;
