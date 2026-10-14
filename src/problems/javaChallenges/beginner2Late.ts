import type { JavaChallengeDefinition } from './types';

const inheritedCorner = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Corner route = new Corner();
    route.draw();
  }
}
class Line {
  Turtle t = new Turtle();
  void line() { t.前に進む(); t.前に進む(); }
}
class Corner extends Line {
  void draw() { line(); t.右を向く(); line(); }
}`,
  finalBoard: '#......\n#......\n###....\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 2, y: 2, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const polymorphicStride = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker route = new LongWalker();
    route.walk();
    route.t.右を向く();
    route.walk();
  }
}
class Walker {
  Turtle t = new Turtle();
  void walk() { t.前に進む(); }
}
class LongWalker extends Walker {
  @Override
  void walk() { super.walk(); super.walk(); }
}`,
  finalBoard: '#......\n#......\n###....\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 2, y: 2, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const mixedRoutes = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Route[] routes = {new Route(0), new BentRoute(3)};
    for (Route route : routes) route.draw();
  }
}
class Route {
  Turtle t;
  Route(int x) { t = new Turtle(x, 0); }
  void draw() { t.前に進む(); }
}
class BentRoute extends Route {
  BentRoute(int x) { super(x); }
  @Override
  void draw() { super.draw(); t.右を向く(); t.前に進む(); }
}`,
  finalBoard: '#..#...\n#..##..\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [
    { x: 0, y: 1, color: '#', dir: 'N' },
    { x: 4, y: 1, color: '#', dir: 'E' },
  ],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const inheritedDispatch = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Pattern route = new WidePattern();
    route.draw();
  }
}
class Pattern {
  Turtle t = new Turtle();
  int steps() { return 1; }
  void draw() {
    for (int i = 0; i < steps(); i++) t.前に進む();
    t.右を向く();
    for (int i = 0; i < steps(); i++) t.前に進む();
  }
}
class WidePattern extends Pattern {
  @Override
  int steps() { return 3; }
}`,
  finalBoard: '#......\n#......\n#......\n####...\n.......\n.......\n.......',
  finalTurtles: [{ x: 3, y: 3, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const overloadDefault = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Pen pen = new Pen();
    pen.draw();
    pen.t.右を向く();
    pen.draw(3);
  }
}
class Pen {
  Turtle t = new Turtle();
  void draw() { draw(2); }
  void draw(int steps) {
    for (int i = 0; i < steps; i++) t.前に進む();
  }
}`,
  finalBoard: '#......\n#......\n####...\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 3, y: 2, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const overloadTypes = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Guide guide = new Guide();
    guide.draw(2);
    guide.draw(true);
    guide.draw(3);
  }
}
class Guide {
  Turtle t = new Turtle();
  void draw(int steps) {
    for (int i = 0; i < steps; i++) t.前に進む();
  }
  void draw(boolean corner) {
    if (corner) t.右を向く();
    t.前に進む();
  }
}`,
  finalBoard: '#......\n#......\n#####..\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 4, y: 2, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const overloadDelegation = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    RoutePen path = new RoutePen();
    path.draw(2, 3);
  }
}
class RoutePen {
  Turtle t = new Turtle();
  void draw(int steps) {
    for (int i = 0; i < steps; i++) t.前に進む();
  }
  void draw(int first, int second) {
    draw(first);
    t.右を向く();
    draw(second);
  }
}`,
  finalBoard: '#......\n#......\n####...\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 3, y: 2, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const overloadDispatch = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Brush brush = new DoubleBrush();
    brush.draw();
    brush.t.右を向く();
    brush.draw(3);
  }
}
class Brush {
  Turtle t = new Turtle();
  void draw() { draw(1); }
  void draw(int steps) {
    for (int i = 0; i < steps; i++) t.前に進む();
  }
}
class DoubleBrush extends Brush {
  @Override
  void draw() { draw(2); }
}`,
  finalBoard: '#......\n#......\n####...\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 3, y: 2, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const catchRoute = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    try {
      t.前に進む();
      throw new IllegalArgumentException();
    } catch (IllegalArgumentException e) {
      t.右を向く();
    }
    t.前に進む();
  }
}
`,
  finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 1, y: 1, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const finallyRoute = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    try {
      t.前に進む();
      throw new IllegalStateException();
    } catch (IllegalStateException e) {
      t.右を向く();
    } finally {
      t.前に進む();
    }
    t.右を向く();
  }
}
`,
  finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 1, y: 1, color: '#', dir: 'S' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const customException = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    try {
      advance(t, 3);
    } catch (RouteException e) {
      t.右を向く();
      t.前に進む();
    }
  }
  static void advance(Turtle t, int steps) throws RouteException {
    if (steps > 2) throw new RouteException();
    for (int i = 0; i < steps; i++) t.前に進む();
  }
}
class RouteException extends Exception {}
`,
  finalBoard: '##.....\n.......\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 1, y: 0, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const exceptionPropagation = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle();
    try {
      turnAtLimit(t);
      t.前に進む();
    } catch (LimitException e) {
      t.右を向く();
      t.前に進む();
    }
  }
  static void turnAtLimit(Turtle t) throws LimitException {
    t.前に進む();
    throw new LimitException();
  }
}
class LimitException extends Exception {}`,
  finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
  finalTurtles: [{ x: 1, y: 1, color: '#', dir: 'E' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const matrixRows = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    int[][] lengths = {{1, 2}, {3, 1}};
    Turtle t = new Turtle();
    for (int row = 0; row < lengths.length; row++) {
      for (int col = 0; col < lengths[row].length; col++) {
        for (int step = 0; step < lengths[row][col]; step++) t.前に進む();
      }
      t.右を向く();
    }
  }
}
`,
  finalBoard: '#......\n#......\n#......\n#####..\n.......\n.......\n.......',
  finalTurtles: [{ x: 4, y: 3, color: '#', dir: 'S' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const jaggedRows = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    int[][] paths = {{4}, {1, 2}, {1, 1, 1}};
    Turtle t = new Turtle();
    for (int[] row : paths) {
      for (int steps : row) {
        for (int i = 0; i < steps; i++) t.前に進む();
      }
      t.右を向く();
    }
  }
}
`,
  finalBoard: '#......\n#..#...\n#..#...\n#..#...\n####...\n.......\n.......',
  finalTurtles: [{ x: 3, y: 1, color: '#', dir: 'W' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const cubeLayers = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    int[][][] routes = {{{1, 2}, {2, 1}}, {{2, 2}, {1, 1}}};
    Turtle t = new Turtle();
    for (int row = 0; row < routes[1].length; row++) {
      for (int col = 0; col < routes[1][row].length; col++) {
        for (int i = 0; i < routes[1][row][col]; i++) t.前に進む();
      }
      t.右を向く();
    }
  }
}
`,
  finalBoard: '#......\n#......\n#......\n#......\n###....\n.......\n.......',
  finalTurtles: [{ x: 2, y: 4, color: '#', dir: 'S' }],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

const cubeSelection = {
  correctProgram: `public class Main {
  public static void main(String[] args) {
    int[][][] paths = {{{1, 2}}, {{3, 1}}};
    for (int layer = 0; layer < paths.length; layer++) {
      Turtle t = new Turtle(layer * 3, 0);
      int[] route = paths[layer][0];
      for (int step = 0; step < route[0]; step++) t.前に進む();
      t.右を向く();
      for (int step = 0; step < route[1]; step++) t.前に進む();
    }
  }
}
`,
  finalBoard: '#..#...\n####...\n...#...\n...##..\n.......\n.......\n.......',
  finalTurtles: [
    { x: 2, y: 1, color: '#', dir: 'E' },
    { x: 4, y: 3, color: '#', dir: 'E' },
  ],
} satisfies Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>;

export const beginner2Late: Record<string, JavaChallengeDefinition> = {
  ...blankVariants(4, '継承した亀の道', inheritedCorner, {
    tu2InheritedCornerBlank1: 'extends Line',
    tu2InheritedCornerBlank2: 'line(); t.右を向く(); line();',
    tu2InheritedCornerBlank3: 'new Corner()',
  }),
  tu2InheritedCornerBug1: {
    ...inheritedCorner,
    title: 'バグ修正：継承した亀の道',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: inheritedCorner.correctProgram.replace(
      'line(); t.右を向く(); line();',
      'line(); t.右を向く(); t.前に進む();'
    ),
  },
  tu2InheritedCornerBug2: {
    ...inheritedCorner,
    title: 'バグ修正：継承した亀の道',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: inheritedCorner.correctProgram.replace(
      'Corner route = new Corner();',
      'Corner route = new Corner(); route.line();'
    ),
  },
  tu2InheritedCornerBug3: {
    ...inheritedCorner,
    title: 'バグ修正：継承した亀の道',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: inheritedCorner.correctProgram.replace('extends Line', 'implements Line'),
  },
  ...blankVariants(4, '親の型で歩く亀', polymorphicStride, {
    tu2PolymorphicStrideBlank1: 'new LongWalker()',
    tu2PolymorphicStrideBlank2: 'super.walk(); super.walk();',
    tu2PolymorphicStrideBlank3: 'extends Walker',
  }),
  tu2PolymorphicStrideBug1: {
    ...polymorphicStride,
    title: 'バグ修正：親の型で歩く亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: polymorphicStride.correctProgram.replace('new LongWalker()', 'new Walker()'),
  },
  tu2PolymorphicStrideBug2: {
    ...polymorphicStride,
    title: 'バグ修正：親の型で歩く亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: polymorphicStride.correctProgram.replace(
      'void walk() { super.walk(); super.walk(); }',
      'void walk() { super.walk(); }'
    ),
  },
  tu2PolymorphicStrideBug3: {
    ...polymorphicStride,
    title: 'バグ修正：親の型で歩く亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: polymorphicStride.correctProgram.replace(
      'void walk() { super.walk(); super.walk(); }',
      'private void walk() { super.walk(); super.walk(); }'
    ),
  },
  ...blankVariants(4, '配列に並ぶ亀たち', mixedRoutes, {
    tu2MixedRoutesBlank1: 'Route[]',
    tu2MixedRoutesBlank2: 'super(x)',
    tu2MixedRoutesBlank3: 'super.draw(); t.右を向く(); t.前に進む();',
  }),
  tu2MixedRoutesBug1: {
    ...mixedRoutes,
    title: 'バグ修正：配列に並ぶ亀たち',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: mixedRoutes.correctProgram.replace('new BentRoute(3)', 'new Route(3)'),
  },
  tu2MixedRoutesBug2: {
    ...mixedRoutes,
    title: 'バグ修正：配列に並ぶ亀たち',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: mixedRoutes.correctProgram.replace(
      'super.draw(); t.右を向く(); t.前に進む();',
      't.右を向く(); t.前に進む();'
    ),
  },
  tu2MixedRoutesBug3: {
    ...mixedRoutes,
    title: 'バグ修正：配列に並ぶ亀たち',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: mixedRoutes.correctProgram.replace(
      'BentRoute(int x) { super(x); }',
      'BentRoute(int x) { this(x); }'
    ),
  },
  ...blankVariants(4, '呼び出し先が変わる亀', inheritedDispatch, {
    tu2InheritedDispatchBlank1: 'new WidePattern()',
    tu2InheritedDispatchBlank2: 'int steps() { return 3; }',
  }),
  tu2InheritedDispatchBug1: {
    ...inheritedDispatch,
    title: 'バグ修正：呼び出し先が変わる亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: inheritedDispatch.correctProgram.replace('new WidePattern()', 'new Pattern()'),
  },
  tu2InheritedDispatchBug2: {
    ...inheritedDispatch,
    title: 'バグ修正：呼び出し先が変わる亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: inheritedDispatch.correctProgram.replace(
      '@Override\n  int steps() { return 3; }',
      'int steps(int unused) { return 3; }'
    ),
  },
  tu2InheritedDispatchBug3: {
    ...inheritedDispatch,
    title: 'バグ修正：呼び出し先が変わる亀',
    courseId: 'tuBeginner2',
    lectureIndex: 4,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: inheritedDispatch.correctProgram.replace(
      'int steps() { return 3; }',
      'String steps() { return "3"; }'
    ),
  },
  ...blankVariants(5, '引数で選ぶ道', overloadDefault, {
    tu2OverloadDefaultBlank1: 'draw(2)',
    tu2OverloadDefaultBlank2: 'pen.draw(3)',
    tu2OverloadDefaultBlank3: 'int steps',
  }),
  tu2OverloadDefaultBug1: {
    ...overloadDefault,
    title: 'バグ修正：引数で選ぶ道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadDefault.correctProgram.replace('pen.draw(3)', 'pen.draw()'),
  },
  tu2OverloadDefaultBug2: {
    ...overloadDefault,
    title: 'バグ修正：引数で選ぶ道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadDefault.correctProgram.replace('pen.draw();', 'pen.draw(3);'),
  },
  tu2OverloadDefaultBug3: {
    ...overloadDefault,
    title: 'バグ修正：引数で選ぶ道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: overloadDefault.correctProgram.replace('pen.draw(3)', 'pen.draw(true)'),
  },
  ...blankVariants(5, '型で選ぶ曲がり角', overloadTypes, {
    tu2OverloadTypesBlank1: 'boolean corner',
    tu2OverloadTypesBlank2: 'guide.draw(true)',
    tu2OverloadTypesBlank3: 'guide.draw(2)',
  }),
  tu2OverloadTypesBug1: {
    ...overloadTypes,
    title: 'バグ修正：型で選ぶ曲がり角',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadTypes.correctProgram.replace('guide.draw(true)', 'guide.draw(1)'),
  },
  tu2OverloadTypesBug2: {
    ...overloadTypes,
    title: 'バグ修正：型で選ぶ曲がり角',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadTypes.correctProgram.replace('if (corner)', 'if (!corner)'),
  },
  tu2OverloadTypesBug3: {
    ...overloadTypes,
    title: 'バグ修正：型で選ぶ曲がり角',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: overloadTypes.correctProgram.replace('void draw(boolean corner)', 'void draw(int corner)'),
  },
  ...blankVariants(5, '二つの長さの道', overloadDelegation, {
    tu2OverloadDelegationBlank1: 'int first, int second',
    tu2OverloadDelegationBlank2: 'draw(first)',
    tu2OverloadDelegationBlank3: 'draw(second)',
  }),
  tu2OverloadDelegationBug1: {
    ...overloadDelegation,
    title: 'バグ修正：二つの長さの道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadDelegation.correctProgram.replace('draw(first);', 'draw(second);'),
  },
  tu2OverloadDelegationBug2: {
    ...overloadDelegation,
    title: 'バグ修正：二つの長さの道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadDelegation.correctProgram.replace('draw(second);', 'draw(first);'),
  },
  tu2OverloadDelegationBug3: {
    ...overloadDelegation,
    title: 'バグ修正：二つの長さの道',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: overloadDelegation.correctProgram.replace(
      'void draw(int first, int second)',
      'void draw(int first, boolean second)'
    ),
  },
  ...blankVariants(5, '親の型と引数の組合せ', overloadDispatch, {
    tu2OverloadDispatchBlank1: 'new DoubleBrush()',
    tu2OverloadDispatchBlank2: 'void draw() { draw(2); }',
  }),
  tu2OverloadDispatchBug1: {
    ...overloadDispatch,
    title: 'バグ修正：親の型と引数の組合せ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadDispatch.correctProgram.replace('new DoubleBrush()', 'new Brush()'),
  },
  tu2OverloadDispatchBug2: {
    ...overloadDispatch,
    title: 'バグ修正：親の型と引数の組合せ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: overloadDispatch.correctProgram.replace(
      '@Override\n  void draw() { draw(2); }',
      'void draw(boolean wide) { draw(2); }'
    ),
  },
  tu2OverloadDispatchBug3: {
    ...overloadDispatch,
    title: 'バグ修正：親の型と引数の組合せ',
    courseId: 'tuBeginner2',
    lectureIndex: 5,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: overloadDispatch.correctProgram.replace(
      'void draw() { draw(2); }',
      'int draw() { draw(2); return 2; }'
    ),
  },
  ...blankVariants(6, '例外の後の道', catchRoute, {
    tu2CatchRouteBlank1: 'throw new IllegalArgumentException()',
    tu2CatchRouteBlank2: 'IllegalArgumentException e',
    tu2CatchRouteBlank3: 't.右を向く()',
  }),
  tu2CatchRouteBug1: {
    ...catchRoute,
    title: 'バグ修正：例外の後の道',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: catchRoute.correctProgram.replace('throw new IllegalArgumentException();', 't.前に進む();'),
  },
  tu2CatchRouteBug2: {
    ...catchRoute,
    title: 'バグ修正：例外の後の道',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: catchRoute.correctProgram.replace('t.右を向く();', 't.前に進む();'),
  },
  tu2CatchRouteBug3: {
    ...catchRoute,
    title: 'バグ修正：例外の後の道',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: catchRoute.correctProgram.replace(
      'throw new IllegalArgumentException();',
      'throw IllegalArgumentException;'
    ),
  },
  ...blankVariants(6, '必ず通る後片付け', finallyRoute, {
    tu2FinallyRouteBlank1: 'finally',
    tu2FinallyRouteBlank2: 'IllegalStateException e',
    tu2FinallyRouteBlank3: 'throw new IllegalStateException()',
  }),
  tu2FinallyRouteBug1: {
    ...finallyRoute,
    title: 'バグ修正：必ず通る後片付け',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: finallyRoute.correctProgram.replace('throw new IllegalStateException();', 'return;'),
  },
  tu2FinallyRouteBug2: {
    ...finallyRoute,
    title: 'バグ修正：必ず通る後片付け',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: finallyRoute.correctProgram.replace('throw new IllegalStateException();', 't.前に進む();'),
  },
  tu2FinallyRouteBug3: {
    ...finallyRoute,
    title: 'バグ修正：必ず通る後片付け',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: finallyRoute.correctProgram.replace('finally {', 'finally (Exception e) {'),
  },
  ...blankVariants(6, '独自の例外で曲がる', customException, {
    tu2CustomExceptionBlank1: 'extends Exception',
    tu2CustomExceptionBlank2: 'throws RouteException',
    tu2CustomExceptionBlank3: 'steps > 2',
  }),
  tu2CustomExceptionBug1: {
    ...customException,
    title: 'バグ修正：独自の例外で曲がる',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: customException.correctProgram.replace('steps > 2', 'steps < 2'),
  },
  tu2CustomExceptionBug2: {
    ...customException,
    title: 'バグ修正：独自の例外で曲がる',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: customException.correctProgram.replace('advance(t, 3)', 'advance(t, 2)'),
  },
  tu2CustomExceptionBug3: {
    ...customException,
    title: 'バグ修正：独自の例外で曲がる',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: customException.correctProgram.replace('extends Exception', 'extends Turtle'),
  },
  ...blankVariants(6, '呼び出しを戻る例外', exceptionPropagation, {
    tu2ExceptionPropagationBlank1: 'throws LimitException',
    tu2ExceptionPropagationBlank2: 'catch (LimitException e)',
  }),
  tu2ExceptionPropagationBug1: {
    ...exceptionPropagation,
    title: 'バグ修正：呼び出しを戻る例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: exceptionPropagation.correctProgram.replace('throw new LimitException();', 'return;'),
  },
  tu2ExceptionPropagationBug2: {
    ...exceptionPropagation,
    title: 'バグ修正：呼び出しを戻る例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: exceptionPropagation.correctProgram.replace('t.右を向く();\n      t.前に進む();', 't.前に進む();'),
  },
  tu2ExceptionPropagationBug3: {
    ...exceptionPropagation,
    title: 'バグ修正：呼び出しを戻る例外',
    courseId: 'tuBeginner2',
    lectureIndex: 6,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: exceptionPropagation.correctProgram.replace('throws LimitException', 'throw LimitException'),
  },
  ...blankVariants(7, '行ごとの歩数', matrixRows, {
    tu2MatrixRowsBlank1: 'int[][]',
    tu2MatrixRowsBlank2: 'lengths[row][col]',
    tu2MatrixRowsBlank3: 'lengths[row].length',
  }),
  tu2MatrixRowsBug1: {
    ...matrixRows,
    title: 'バグ修正：行ごとの歩数',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: matrixRows.correctProgram.replace('lengths[row][col]', 'lengths[col][row]'),
  },
  tu2MatrixRowsBug2: {
    ...matrixRows,
    title: 'バグ修正：行ごとの歩数',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: matrixRows.correctProgram.replace('lengths[row].length', 'lengths.length - 1'),
  },
  tu2MatrixRowsBug3: {
    ...matrixRows,
    title: 'バグ修正：行ごとの歩数',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: matrixRows.correctProgram.replace('int[][] lengths', 'int[] lengths'),
  },
  ...blankVariants(7, '長さの異なる行', jaggedRows, {
    tu2JaggedRowsBlank1: 'int[] row',
    tu2JaggedRowsBlank2: 'int steps : row',
    tu2JaggedRowsBlank3: 'int[][] paths',
  }),
  tu2JaggedRowsBug1: {
    ...jaggedRows,
    title: 'バグ修正：長さの異なる行',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: jaggedRows.correctProgram.replace('i < steps', 'i < row[0]'),
  },
  tu2JaggedRowsBug2: {
    ...jaggedRows,
    title: 'バグ修正：長さの異なる行',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: jaggedRows.correctProgram.replace('int steps : row', 'int steps : paths[0]'),
  },
  tu2JaggedRowsBug3: {
    ...jaggedRows,
    title: 'バグ修正：長さの異なる行',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: jaggedRows.correctProgram.replace('int[] row : paths', 'int row : paths'),
  },
  ...blankVariants(7, '層を選んで歩く', cubeLayers, {
    tu2CubeLayersBlank1: 'int[][][]',
    tu2CubeLayersBlank2: 'routes[1][row][col]',
    tu2CubeLayersBlank3: 'routes[1][row].length',
  }),
  tu2CubeLayersBug1: {
    ...cubeLayers,
    title: 'バグ修正：層を選んで歩く',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: cubeLayers.correctProgram.replace('routes[1][row][col]', 'routes[0][row][col]'),
  },
  tu2CubeLayersBug2: {
    ...cubeLayers,
    title: 'バグ修正：層を選んで歩く',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: cubeLayers.correctProgram.replace('routes[1][row][col]', 'routes[1][col][row]'),
  },
  tu2CubeLayersBug3: {
    ...cubeLayers,
    title: 'バグ修正：層を選んで歩く',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: cubeLayers.correctProgram.replace('int[][][] routes', 'int[][] routes'),
  },
  ...blankVariants(7, '三つの添字と二匹の亀', cubeSelection, {
    tu2CubeSelectionBlank1: 'paths[layer][0]',
    tu2CubeSelectionBlank2: 'int[] route',
  }),
  tu2CubeSelectionBug1: {
    ...cubeSelection,
    title: 'バグ修正：三つの添字と二匹の亀',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: cubeSelection.correctProgram.replace('paths[layer][0]', 'paths[0][0]'),
  },
  tu2CubeSelectionBug2: {
    ...cubeSelection,
    title: 'バグ修正：三つの添字と二匹の亀',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    starterProgram: cubeSelection.correctProgram.replace('step < route[1]', 'step < route[0]'),
  },
  tu2CubeSelectionBug3: {
    ...cubeSelection,
    title: 'バグ修正：三つの添字と二匹の亀',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    starterProgram: cubeSelection.correctProgram.replace(
      'int[] route = paths[layer][0]',
      'int[][] route = paths[layer][0]'
    ),
  },
};

function blankVariants(
  lectureIndex: number,
  title: string,
  model: Pick<JavaChallengeDefinition, 'correctProgram' | 'finalBoard' | 'finalTurtles'>,
  holes: Record<string, string>
): Record<string, JavaChallengeDefinition> {
  return Object.fromEntries(
    Object.entries(holes).map(([id, hole]) => [
      id,
      {
        ...model,
        title: `穴埋め：${title}`,
        courseId: 'tuBeginner2',
        lectureIndex,
        problemFormat: 'fillInBlank',
        starterProgram: model.correctProgram.replace(hole, `@[${hole}]@`),
      },
    ])
  );
}
