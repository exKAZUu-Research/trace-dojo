import { challengeFillInBlankProblemDefinitions } from './challengeDefinitions';
import type { LanguageId } from '../problemData';

export const fillInBlankProblemDefinitions = {
  fillInBlank1: {
    instrumented: `
const t = new Turtle(); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 4; s.set('i', s.get('i') + 1)) {
  t.forward();
}
delete s.vars['i'];
`,
    java: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    for (int i = 0; @[i < 4]@; i++) {
      t.前に進む();
    }
  }
}
`,
  },
  fillInBlank2: {
    instrumented: `
s.set('x', <1-4>);
s.set('y', s.get('x') + 1);
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.forward();
`,
    java: `
public class Main {
  public static void main(String[] args) {
    int x = <1-4>;
    int y = @[x + 1]@;
    Turtle t = new Turtle(x, y);
    t.前に進む();
  }
}
`,
  },
  fillInBlank3: {
    instrumented: `
const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.forward();
t.forward();
`,
    java: `
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
  },
  fillInBlank4: {
    instrumented: `
const t = new Turtle(); registerDisplayRef('t', () => t); // step
for (s.set('i', 0); s.get('i') < 3; s.set('i', s.get('i') + 1)) {
  t.forward();
  t.turnRight();
}
delete s.vars['i'];
`,
    java: `
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
  },
  ...challengeFillInBlankProblemDefinitions,
} as const satisfies Record<string, Record<LanguageId, string>>;
