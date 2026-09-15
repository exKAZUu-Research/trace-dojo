import { type CourseId, type ProblemId, courseIdToLectureIds, courseIdToLectureIndexToProblemIds } from '../problemData';

export interface FillInBlankDefinition {
  baseProblemId: ProblemId;
  java: string;
}

export const fillInBlankDefinitions: Record<string, FillInBlankDefinition> = {
  straightBlank: {
    baseProblemId: 'straight',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        @[亀.前に進む();]@ // step
        亀.前に進む(); // step
    }
}
    `,
  },
  straightSecondBlank: {
    baseProblemId: 'straight',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        @[亀.前に進む();]@ // step
    }
}
    `,
  },
  square1Blank: {
    baseProblemId: 'square1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        亀.前に進む(); // step
        @[亀.右を向く();]@ // step
        亀.前に進む(); // step
        亀.右を向く(); // step
        亀.前に進む(); // step
    }
}
    `,
  },
  while1Blank: {
    baseProblemId: 'while1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(); // step
        int i = 0; // step
        while (i < <3-5>) {
            亀.前に進む(); // step
            @[i++;]@ // step
        }
    }
}
    `,
  },
  doubleLoop1Blank: {
    baseProblemId: 'doubleLoop1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <2-3>; i++) { // step
            for (int j = 0; j < <2-3>; j++) { // step
                t.前に進む(); // step
            }
            @[t.右を向く();]@ // step
        }
    }
}
    `,
  },
  elseIf1Blank: {
    baseProblemId: 'elseIf1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        for (int i = 0; i < <4-6>; i++) { // step
            if (i < 2)
                t.前に進む(); // step
            else if (i == 2)
                @[t.左を向く();]@ // step
            else
                t.後に戻る(); // step
        }
    }
}
    `,
  },
  break1Blank: {
    baseProblemId: 'break1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        while (true) {
            if (!t.前に進めるか()) break;
            @[t.前に進む();]@ // step
        }
    }
}
    `,
  },
  method1Blank: {
    baseProblemId: 'method1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step: 1
        二歩前に進める(t); // caller
        @[t.右を向く();]@ // step: 2
        三歩前に進める(t); // caller
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む(); // step: 3
        t.前に進む(); // step: 4
    }
    static void 三歩前に進める(Turtle t) {
        t.前に進む(); // step: 5
        t.前に進む(); // step: 6
        t.前に進む(); // step: 7
    }
}
    `,
  },
  array1Blank: {
    baseProblemId: 'array1',
    java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        int[] arr = { 2, <1-2>, <1-2> }; // step
        for (int i = 0; i < arr.length; i++) { // step
            N歩前に進める(t, arr[i]); // caller
            @[t.右を向く();]@ // step
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) { // step
            t.前に進む(); // step
        }
    }
}
    `,
  },
  multiObject1Blank: {
    baseProblemId: 'multiObject1',
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    Turtle t2 = new Turtle(3, 3); // step
    t1.前に進む(); // step
    @[t1.右を向く();]@ // step
    t2.前に進む(); // step
    t2.左を向く(); // step
  }
}
`,
  },
  makeClass1Blank: {
    baseProblemId: 'makeClass1',
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.moveForward(); // caller
    @[t.speed = 1;]@ // step
    t.moveForward(); // caller
  }
}

class MyTurtle {
  Turtle t = new Turtle(); // step
  int speed = 2; // step

  void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
    `,
  },
  encapsulationBlank: {
    baseProblemId: 'encapsulation',
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t = new MyTurtle(); // caller
    t.moveForward(); // caller
    @[t.changeSpeed(1);]@ // caller
    t.moveForward(); // caller
  }
}

class MyTurtle {
  private Turtle t = new Turtle(); // step
  private int speed = 2; // step

  public void moveForward() {
    for (int i = 0; i < this.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
  public void changeSpeed(int speed) {
    this.speed = speed; // step
  }
}
`,
  },
  staticMethod1Blank: {
    baseProblemId: 'staticMethod1',
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t1 = new Turtle(1, 1); // step
    @[Controller.moveTwoSteps(t1);]@ // caller
    Turtle t2 = new Turtle(3, 3); // step
    Controller.moveTwoSteps(t2); // caller
  }
}

class Controller {
  static void moveTwoSteps(Turtle t) {
    t.前に進む(); // step
    t.前に進む(); // step
  }
}
    `,
  },
  inheritance1Blank: {
    baseProblemId: 'inheritance1',
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(); // caller
    @[t.drawCurve();]@ // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step

  void drawLine() {
    this.t.前に進む(); // step
    this.t.前に進む(); // step
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
`,
  },
  exception1Blank: {
    baseProblemId: 'exception1',
    java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle m = new MyTurtle(); // caller
    try {
      m.drawLine(); // caller
      m.drawLine(); // caller
    } catch (Exception e) {
      @[m.t.右を向く();]@ // step
      m.t.前に進む(); // step
    }
  }
}

class MyTurtle {
  public Turtle t = new Turtle(); // step

  public void drawLine() {
    for (int i = 0; i < 4; i++) { // step
      if (!t.前に進めるか()) {
        throw new RuntimeException("前に進めない！");
      }
      this.t.前に進む(); // step
    }
  }
}
    `,
  },
  twoDimensionalArray1Blank: {
    baseProblemId: 'twoDimensionalArray1',
    java: `
public class Main {
  public static void main(String[] args) {
    int [][] arr = { { 0, 3 }, { 1, 1 }, { 0, 2 },
                     { 2, 3 }, { 0, 1 }, };
    Turtle t = new Turtle(); // step
    for (int i = 0; i < arr.length; i++) { // step
      @[int c = arr[i][1];]@ // step
      switch (arr[i][0]) {
        case 0:
          for (int j = 0; j < c; j++) { // step
            t.前に進む(); // step
          }
          break;
        case 1:
          for (int j = 0; j < c; j++) { // step
            t.右を向く(); // step
          }
          break;
        case 2:
          for (int j = 0; j < c; j++) { // step
            t.左を向く(); // step
          }
          break;
      }
    }
  }
}
  `,
  },
  test1Blank: {
    baseProblemId: 'test1',
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle c = new Turtle(); // step
    @[c.forward();]@ // step
    c.forward(); // step
    c.forward(); // step
  }
}
`,
  },
  overload1Blank: {
    baseProblemId: 'overload1',
    java: `
public class Main {
  public static void main(String[] args) {
    CurveTurtle t = new CurveTurtle(); // caller
    @[t.drawCurve();]@ // caller
  }
}
class MyTurtle {
  Turtle t = new Turtle(); // step
  void drawLine(int steps) {
    for (int i = 0; i < steps; i++) // step
      this.t.前に進む(); // step
  }
  void drawLine() {
    this.drawLine(2); // caller
  }
}
class CurveTurtle extends MyTurtle {
  void drawCurve() {
    this.drawLine(3); // caller
    this.t.右を向く(); // step
    this.drawLine(); // caller
  }
}
    `,
  },
};

export const getLectureExerciseIds = (courseId: CourseId, lectureId: string): string[] => {
  const lectureIndex = courseIdToLectureIds[courseId]?.indexOf(lectureId) ?? -1;
  if (lectureIndex < 0) return [];
  const baseIds = new Set(courseIdToLectureIndexToProblemIds[courseId][lectureIndex]);
  return Object.entries(fillInBlankDefinitions)
    .filter(([, definition]) => baseIds.has(definition.baseProblemId))
    .map(([id]) => id);
};
