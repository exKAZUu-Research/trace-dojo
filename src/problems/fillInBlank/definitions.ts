import { challengeFillInBlankProblemDefinitions } from './challengeDefinitions';

export const fillInBlankProblemDefinitions = {
  fillInBlank1: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    for (int i = 0; @[i < 4]@; i++) {
      t.前に進む();
    }
  }
}
`,
  fillInBlank2: `
public class Main {
  public static void main(String[] args) {
    int x = <1-4>;
    int y = @[x + 1]@;
    Turtle t = new Turtle(x, y);
    t.前に進む();
  }
}
`,
  fillInBlank3: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    t.前に進む();
    @[t.右を向く();]@
    t.前に進む();
    t.前に進む();
  }
}
`,
  fillInBlank4: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    for (int i = 0; i < @[3]@; i++) {
      t.前に進む();
      @[t.右を向く();]@
    }
  }
}
`,
  ...challengeFillInBlankProblemDefinitions,
} as const satisfies Record<string, string>;
