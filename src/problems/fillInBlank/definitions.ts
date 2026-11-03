import { challengeFillInBlankProblemDefinitions } from './challengeDefinitions';

export const fillInBlankProblemDefinitions = {
  fillInBlank1: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    for (int i = 0; @[i < 4]@; i++) { // step
      t.前に進む(); // step
    }
  }
}
`,
  fillInBlank2: `
public class Main {
  public static void main(String[] args) {
    int x = <1-4>; // step
    int y = @[x + 1]@; // step
    Turtle t = new Turtle(x, y); // step
    t.前に進む(); // step
  }
}
`,
  fillInBlank3: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    t.前に進む(); // step
    @[t.右を向く();]@ // step
    t.前に進む(); // step
    t.前に進む(); // step
  }
}
`,
  fillInBlank4: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    for (int i = 0; i < @[3]@; i++) { // step
      t.前に進む(); // step
      @[t.右を向く();]@ // step
    }
  }
}
`,
  ...challengeFillInBlankProblemDefinitions,
} as const satisfies Record<string, string>;
