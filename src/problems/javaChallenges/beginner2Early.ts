import type { JavaChallengeDefinition } from './types';

type Replacement = [id: string, search: string, replacement: string];
type BugReplacement = [...Replacement, kind: 'logical' | 'syntax'];
type Model = Pick<
  JavaChallengeDefinition,
  'title' | 'lectureIndex' | 'correctProgram' | 'finalBoard' | 'finalTurtles'
> & {
  id: string;
  blanks: Replacement[];
  bugs: BugReplacement[];
};

const models: Model[] = [
  {
    id: 'sharedReference',
    lectureIndex: 0,
    title: '２つの名前で描く道',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle first = new Turtle(1, 1, "R");
    Turtle second = new Turtle(4, 1, "B");
    Turtle alias = first;
    alias.forward();
    first.turnRight();
    alias.forward();
    second.forward();
  }
}`,
    finalBoard: `.......
.R..B..
.RR.B..
.......
.......
.......
.......`,
    finalTurtles: [
      { x: 2, y: 2, color: 'R', dir: 'E' },
      { x: 4, y: 2, color: 'B', dir: 'N' },
    ],
    blanks: [
      ['alias', 'Turtle alias = first;', 'Turtle alias = @[first]@;'],
      ['receiver', 'first.turnRight();', '@[first]@.turnRight();'],
      ['referenceType', 'Turtle alias =', '@[Turtle]@ alias ='],
    ],
    bugs: [
      ['otherObject', 'Turtle alias = first;', 'Turtle alias = second;', 'logical'],
      ['independentCopy', 'Turtle alias = first;', 'Turtle alias = new Turtle(1, 1, "R");', 'logical'],
      ['referenceType', 'Turtle alias =', 'int alias =', 'syntax'],
    ],
  },
  {
    id: 'referenceSwap',
    lectureIndex: 0,
    title: '２匹の役割交代',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle first = new Turtle(1, 1, "R");
    Turtle second = new Turtle(4, 1, "B");
    Turtle saved = first;
    first = second;
    second = saved;
    first.forward();
    second.turnRight();
    second.forward();
  }
}`,
    finalBoard: `.......
.RR.B..
....B..
.......
.......
.......
.......`,
    finalTurtles: [
      { x: 2, y: 1, color: 'R', dir: 'E' },
      { x: 4, y: 2, color: 'B', dir: 'N' },
    ],
    blanks: [
      ['temporary', 'Turtle saved = first;', 'Turtle saved = @[first]@;'],
      ['firstAssignment', 'first = second;', 'first = @[second]@;'],
      ['secondAssignment', 'second = saved;', 'second = @[saved]@;'],
    ],
    bugs: [
      ['lostReference', 'second = saved;', 'second = first;', 'logical'],
      ['saveWrongObject', 'Turtle saved = first;', 'Turtle saved = second;', 'logical'],
      ['assignmentType', 'first = second;', 'first = 2;', 'syntax'],
    ],
  },
  {
    id: 'referenceParameter',
    lectureIndex: 0,
    title: '引数でつなぐ操作',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle first = new Turtle(1, 1, "R");
    Turtle second = new Turtle(4, 1, "B");
    advance(first);
    advance(second);
    first.forward();
  }
  static void advance(Turtle turtle) {
    turtle.forward();
    Guide.turn(turtle);
  }
}

class Guide {
  static void turn(Turtle turtle) {
    turtle.turnRight();
  }
}`,
    finalBoard: `.......
.R..B..
.RR.B..
.......
.......
.......
.......`,
    finalTurtles: [
      { x: 2, y: 2, color: 'R', dir: 'E' },
      { x: 4, y: 2, color: 'B', dir: 'E' },
    ],
    blanks: [
      ['parameter', 'static void advance(Turtle turtle)', 'static void advance(@[Turtle]@ turtle)'],
      ['passObject', 'advance(first);', 'advance(@[first]@);'],
      ['forwardReference', 'Guide.turn(turtle);', 'Guide.turn(@[turtle]@);'],
    ],
    bugs: [
      ['repeatedObject', 'advance(second);', 'advance(first);', 'logical'],
      [
        'rebindParameter',
        '    turtle.forward();',
        '    turtle = new Turtle(2, 2, "G");\n    turtle.forward();',
        'logical',
      ],
      ['wrongArgument', 'advance(first);', 'advance("first");', 'syntax'],
    ],
  },
  {
    id: 'referenceArray',
    lectureIndex: 0,
    title: '配列から選ぶ亀',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle red = new Turtle(1, 1, "R");
    Turtle blue = new Turtle(4, 1, "B");
    Turtle[] team = {red, blue, red};
    for (Turtle member : team) {
      member.forward();
    }
    team[2].turnRight();
    red.forward();
  }
}`,
    finalBoard: `.......
.R..B..
.R..B..
.RR....
.......
.......
.......`,
    finalTurtles: [
      { x: 2, y: 3, color: 'R', dir: 'E' },
      { x: 4, y: 2, color: 'B', dir: 'N' },
    ],
    blanks: [
      ['sharedEntry', '{red, blue, red}', '{red, blue, @[red]@}'],
      ['elementType', 'for (Turtle member : team)', 'for (@[Turtle]@ member : team)'],
    ],
    bugs: [
      ['lastReference', '{red, blue, red}', '{red, blue, blue}', 'logical'],
      ['selectedObject', 'team[2].turnRight();', 'team[1].turnRight();', 'logical'],
      ['arrayElementType', 'Turtle[] team', 'int[] team', 'syntax'],
    ],
  },
  {
    id: 'constructorSpeed',
    lectureIndex: 1,
    title: '歩幅を持つ亀',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker walker = new Walker(1, 1, 2);
    walker.move();
    walker.speed = 1;
    walker.move();
  }
}

class Walker {
  Turtle turtle;
  int speed;
  Walker(int x, int y, int speed) {
    this.turtle = new Turtle(x, y);
    this.speed = speed;
  }
  void move() {
    for (int i = 0; i < speed; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
.#.....
.#.....
.......
.......`,
    finalTurtles: [{ x: 1, y: 4, color: '#', dir: 'N' }],
    blanks: [
      ['initializeField', 'this.speed = speed;', '@[this.speed]@ = speed;'],
      ['constructorName', 'Walker(int x, int y, int speed)', '@[Walker]@(int x, int y, int speed)'],
      ['useField', 'i < speed', 'i < @[speed]@'],
    ],
    bugs: [
      ['shadowedField', 'this.speed = speed;', 'speed = speed;', 'logical'],
      ['ignoreUpdatedField', 'i < speed', 'i < 2', 'logical'],
      ['constructorReturnType', 'Walker(int x, int y, int speed)', 'void Walker(int x, int y, int speed)', 'syntax'],
    ],
  },
  {
    id: 'constructorReference',
    lectureIndex: 1,
    title: '同じ亀を包むクラス',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle turtle = new Turtle(1, 1, "R");
    Driver first = new Driver(turtle);
    Driver second = new Driver(turtle);
    first.step();
    second.corner();
    first.step();
  }
}

class Driver {
  Turtle turtle;
  Driver(Turtle turtle) {
    this.turtle = turtle;
  }
  void step() {
    turtle.forward();
  }
  void corner() {
    turtle.turnRight();
  }
}`,
    finalBoard: `.......
.R.....
.RR....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 2, color: 'R', dir: 'E' }],
    blanks: [
      ['storeReference', 'this.turtle = turtle;', 'this.turtle = @[turtle]@;'],
      ['constructorArgument', 'Driver second = new Driver(turtle);', 'Driver second = new Driver(@[turtle]@);'],
      ['fieldType', '  Turtle turtle;', '  @[Turtle]@ turtle;'],
    ],
    bugs: [
      ['copyInsteadOfShare', 'this.turtle = turtle;', 'this.turtle = new Turtle(1, 1, "R");', 'logical'],
      [
        'secondIndependent',
        'Driver second = new Driver(turtle);',
        'Driver second = new Driver(new Turtle(4, 1, "B"));',
        'logical',
      ],
      ['constructorParameterType', 'Driver(Turtle turtle)', 'Driver(int turtle)', 'syntax'],
    ],
  },
  {
    id: 'constructorCoordinates',
    lectureIndex: 1,
    title: '位置から始まる描画',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Corner left = new Corner(1, 2);
    Corner right = new Corner(4, 1);
    left.draw();
    right.draw();
  }
}

class Corner {
  Turtle turtle;
  Corner(int x, int y) {
    turtle = new Turtle(x, y);
  }
  void draw() {
    turtle.forward();
    turtle.turnRight();
    turtle.forward();
  }
}`,
    finalBoard: `.......
....#..
.#..##.
.##....
.......
.......
.......`,
    finalTurtles: [
      { x: 2, y: 3, color: '#', dir: 'E' },
      { x: 5, y: 2, color: '#', dir: 'E' },
    ],
    blanks: [
      ['coordinateOrder', 'new Turtle(x, y)', 'new Turtle(@[x, y]@)'],
      ['instantiate', 'new Corner(1, 2)', '@[new]@ Corner(1, 2)'],
      ['instanceCall', 'right.draw();', '@[right]@.draw();'],
    ],
    bugs: [
      ['swappedCoordinates', 'new Turtle(x, y)', 'new Turtle(y, x)', 'logical'],
      ['wrongInstance', 'right.draw();', 'left.draw();', 'logical'],
      ['missingNew', 'new Corner(1, 2)', 'Corner(1, 2)', 'syntax'],
    ],
  },
  {
    id: 'instanceCounters',
    lectureIndex: 1,
    title: 'それぞれの歩数',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Stepper first = new Stepper(1);
    Stepper second = new Stepper(4);
    first.steps = 2;
    second.steps = 1;
    first.draw();
    second.draw();
  }
}

class Stepper {
  Turtle turtle;
  int steps;
  Stepper(int x) {
    turtle = new Turtle(x, 1);
  }
  void draw() {
    for (int i = 0; i < steps; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#..#..
.#..#..
.#.....
.......
.......
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'N' },
      { x: 4, y: 2, color: '#', dir: 'N' },
    ],
    blanks: [
      ['fieldOwner', 'second.steps = 1;', '@[second]@.steps = 1;'],
      ['initializeTurtle', 'new Turtle(x, 1)', 'new Turtle(@[x]@, 1)'],
    ],
    bugs: [
      ['wrongFieldOwner', 'second.steps = 1;', 'first.steps = 1;', 'logical'],
      ['ignoreConstructorInput', 'new Turtle(x, 1)', 'new Turtle(1, 1)', 'logical'],
      ['fieldType', 'int steps;', 'boolean steps;', 'syntax'],
    ],
  },
  {
    id: 'accessorSpeed',
    lectureIndex: 2,
    title: '設定した歩幅で進む',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker walker = new Walker();
    walker.setSpeed(2);
    walker.move();
    walker.setSpeed(1);
    walker.move();
  }
}

class Walker {
  private Turtle turtle = new Turtle(1, 1);
  private int speed;
  public void setSpeed(int speed) {
    this.speed = speed;
  }
  public int getSpeed() {
    return speed;
  }
  public void move() {
    for (int i = 0; i < getSpeed(); i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
.#.....
.#.....
.......
.......`,
    finalTurtles: [{ x: 1, y: 4, color: '#', dir: 'N' }],
    blanks: [
      ['setterField', 'this.speed = speed;', '@[this.speed]@ = speed;'],
      ['getterReturn', 'return speed;', 'return @[speed]@;'],
      ['getterCall', 'i < getSpeed()', 'i < @[getSpeed()]@'],
    ],
    bugs: [
      ['setterShadow', 'this.speed = speed;', 'speed = speed;', 'logical'],
      ['getterConstant', 'return speed;', 'return 1;', 'logical'],
      ['privateFieldAccess', 'walker.setSpeed(2);', 'walker.speed = 2;', 'syntax'],
    ],
  },
  {
    id: 'boundedAccessor',
    lectureIndex: 2,
    title: '安全な歩幅の設定',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker walker = new Walker();
    walker.setSpeed(2);
    walker.move();
    walker.setSpeed(-1);
    walker.move();
  }
}

class Walker {
  private Turtle turtle = new Turtle(1, 1);
  private int speed = 1;
  public void setSpeed(int value) {
    if (value >= 0 && value <= 2) {
      speed = value;
    }
  }
  public void move() {
    for (int i = 0; i < speed; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#.....
.#.....
.#.....
.#.....
.#.....
.......`,
    finalTurtles: [{ x: 1, y: 5, color: '#', dir: 'N' }],
    blanks: [
      ['validation', 'value >= 0 && value <= 2', '@[value >= 0 && value <= 2]@'],
      ['setterArgument', 'walker.setSpeed(-1);', 'walker.setSpeed(@[-1]@);'],
      ['acceptedValue', 'speed = value;', 'speed = @[value]@;'],
    ],
    bugs: [
      ['acceptNegative', 'value >= 0 && value <= 2', 'value <= 2', 'logical'],
      ['rejectBoundary', 'value >= 0 && value <= 2', 'value >= 0 && value < 2', 'logical'],
      ['privateSetter', 'public void setSpeed', 'private void setSpeed', 'syntax'],
    ],
  },
  {
    id: 'accessorDelegation',
    lectureIndex: 2,
    title: '操作をまとめるクラス',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Pen pen = new Pen();
    pen.advance();
    pen.corner();
    pen.advance();
  }
}

class Pen {
  private Turtle turtle = new Turtle(2, 1);
  public void advance() {
    turtle.forward();
  }
  public void corner() {
    turn();
  }
  private void turn() {
    turtle.turnRight();
  }
}`,
    finalBoard: `.......
..#....
..##...
.......
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 2, color: '#', dir: 'E' }],
    blanks: [
      ['delegate', '    turn();', '    @[turn()]@;'],
      ['forwardCall', '    turtle.forward();', '    turtle.@[forward]@();'],
      ['publicOperation', 'public void corner()', '@[public]@ void corner()'],
    ],
    bugs: [
      ['delegateWrongOperation', '    turn();', '    advance();', 'logical'],
      ['turnDirection', 'turtle.turnRight();', 'turtle.turnLeft();', 'logical'],
      ['privateHelperAccess', 'pen.corner();', 'pen.turn();', 'syntax'],
    ],
  },
  {
    id: 'accessorAccumulation',
    lectureIndex: 2,
    title: '歩幅を増やす操作',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker walker = new Walker();
    walker.increaseSpeed(1);
    walker.increaseSpeed(2);
    int distance = walker.getSpeed();
    Turtle marker = new Turtle(4, 1, "B");
    for (int i = 0; i < distance; i++) marker.forward();
    walker.move();
  }
}

class Walker {
  private Turtle turtle = new Turtle(1, 1, "R");
  private int speed;
  public void increaseSpeed(int amount) {
    speed += amount;
  }
  public int getSpeed() {
    return speed;
  }
  public void move() {
    for (int i = 0; i < speed; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.R..B..
.R..B..
.R..B..
.R..B..
.......
.......`,
    finalTurtles: [
      { x: 1, y: 4, color: 'R', dir: 'N' },
      { x: 4, y: 4, color: 'B', dir: 'N' },
    ],
    blanks: [
      ['accumulate', 'speed += amount;', 'speed @[+=]@ amount;'],
      ['getter', 'walker.getSpeed()', 'walker.@[getSpeed]@()'],
    ],
    bugs: [
      ['replaceInsteadOfAdd', 'speed += amount;', 'speed = amount;', 'logical'],
      ['getterOffset', 'return speed;', 'return speed + 1;', 'logical'],
      ['getterReturnType', 'public int getSpeed()', 'public void getSpeed()', 'syntax'],
    ],
  },
  {
    id: 'staticUtility',
    lectureIndex: 3,
    title: '共通の移動メソッド',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Turtle red = new Turtle(1, 1, "R");
    Turtle blue = new Turtle(4, 1, "B");
    Moves.advance(red, 2);
    Moves.corner(red);
    Moves.advance(red, 1);
    Moves.advance(blue, 1);
  }
}

class Moves {
  static void advance(Turtle turtle, int steps) {
    for (int i = 0; i < steps; i++) turtle.forward();
  }
  static void corner(Turtle turtle) {
    turtle.turnRight();
  }
}`,
    finalBoard: `.......
.R..B..
.R..B..
.RR....
.......
.......
.......`,
    finalTurtles: [
      { x: 2, y: 3, color: 'R', dir: 'E' },
      { x: 4, y: 2, color: 'B', dir: 'N' },
    ],
    blanks: [
      ['staticDeclaration', 'static void advance', '@[static]@ void advance'],
      ['classCall', 'Moves.corner(red);', '@[Moves]@.corner(red);'],
      ['objectArgument', 'Moves.advance(blue, 1);', 'Moves.advance(@[blue]@, 1);'],
    ],
    bugs: [
      ['instanceMethod', 'static void advance', 'void advance', 'syntax'],
      ['wrongArgument', 'Moves.advance(blue, 1);', 'Moves.advance(red, 1);', 'logical'],
      ['ignoreParameter', 'i < steps', 'i < 1', 'logical'],
    ],
  },
  {
    id: 'sharedSpeed',
    lectureIndex: 3,
    title: '共有する歩幅',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker first = new Walker(1);
    Walker second = new Walker(4);
    first.speed = 2;
    first.move();
    second.move();
  }
}

class Walker {
  static int speed = 1;
  Turtle turtle;
  Walker(int x) {
    turtle = new Turtle(x, 1);
  }
  void move() {
    for (int i = 0; i < speed; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#..#..
.#..#..
.#..#..
.......
.......
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'N' },
      { x: 4, y: 3, color: '#', dir: 'N' },
    ],
    blanks: [
      ['sharedField', 'static int speed', '@[static]@ int speed'],
      ['sharedUpdate', 'first.speed = 2;', '@[first.speed]@ = 2;'],
      ['instanceTurtle', 'Turtle turtle;', '@[Turtle]@ turtle;'],
    ],
    bugs: [
      ['instanceSpeed', 'static int speed', 'int speed', 'logical'],
      ['sharedTurtle', '  Turtle turtle;', '  static Turtle turtle;', 'logical'],
      ['staticMovement', '  void move()', '  static void move()', 'syntax'],
    ],
  },
  {
    id: 'staticCounter',
    lectureIndex: 3,
    title: '作った数と描く長さ',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Painter first = new Painter(1);
    Painter second = new Painter(4);
    first.draw();
    second.draw();
  }
}

class Painter {
  static int count;
  Turtle turtle;
  Painter(int x) {
    turtle = new Turtle(x, 1);
    count++;
  }
  void draw() {
    for (int i = 0; i < count; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#..#..
.#..#..
.#..#..
.......
.......
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'N' },
      { x: 4, y: 3, color: '#', dir: 'N' },
    ],
    blanks: [
      ['classCounter', 'static int count', '@[static]@ int count'],
      ['increment', 'count++;', '@[count++]@;'],
      ['readCount', 'i < count', 'i < @[count]@'],
    ],
    bugs: [
      ['instanceCounter', 'static int count', 'int count', 'logical'],
      ['resetCounter', 'count++;', 'count = 1;', 'logical'],
      ['classInstanceCall', 'second.draw();', 'Painter.draw();', 'syntax'],
    ],
  },
  {
    id: 'staticAndInstance',
    lectureIndex: 3,
    title: '共通設定と個別の歩幅',
    correctProgram: `public class Main {
  public static void main(String[] args) {
    Walker first = new Walker(1, 1);
    Walker second = new Walker(4, 2);
    Settings.bonus = 1;
    first.move();
    second.move();
  }
}

class Settings {
  static int bonus;
}
class Walker {
  Turtle turtle;
  int speed;
  Walker(int x, int speed) {
    turtle = new Turtle(x, 1);
    this.speed = speed;
  }
  void move() {
    int distance = speed + Settings.bonus;
    for (int i = 0; i < distance; i++) turtle.forward();
  }
}`,
    finalBoard: `.......
.#..#..
.#..#..
.#..#..
....#..
.......
.......`,
    finalTurtles: [
      { x: 1, y: 3, color: '#', dir: 'N' },
      { x: 4, y: 4, color: '#', dir: 'N' },
    ],
    blanks: [
      ['classField', 'speed + Settings.bonus', 'speed + @[Settings.bonus]@'],
      ['instanceField', 'this.speed = speed;', '@[this.speed]@ = speed;'],
    ],
    bugs: [
      ['sharedBaseSpeed', '  int speed;', '  static int speed;', 'logical'],
      ['ignoreSharedBonus', 'speed + Settings.bonus', 'speed', 'logical'],
      ['instanceConfiguration', 'static int bonus', 'int bonus', 'syntax'],
    ],
  },
];

export const beginner2Early: Record<string, JavaChallengeDefinition> = Object.fromEntries(
  models.flatMap((model) => [
    ...model.blanks.map(([id, search, replacement]) => createDefinition(model, id, search, replacement, 'fillInBlank')),
    ...model.bugs.map(([id, search, replacement, kind]) =>
      createDefinition(model, id, search, replacement, 'bugFix', kind)
    ),
  ])
);

function createDefinition(
  model: Model,
  variantId: string,
  search: string,
  replacement: string,
  problemFormat: JavaChallengeDefinition['problemFormat'],
  bugKind?: JavaChallengeDefinition['bugKind']
): [string, JavaChallengeDefinition] {
  const { correctProgram, finalBoard, finalTurtles, lectureIndex, title } = model;
  if (!correctProgram.includes(search) || correctProgram.indexOf(search) !== correctProgram.lastIndexOf(search)) {
    throw new Error(`Ambiguous Java challenge variant: ${model.id}/${variantId}`);
  }
  return [
    `javaB2Early_${model.id}_${problemFormat}_${variantId}`,
    {
      title: `${problemFormat === 'fillInBlank' ? '穴埋め' : 'バグ修正'}：${title}`,
      courseId: 'tuBeginner2',
      lectureIndex,
      problemFormat,
      correctProgram,
      starterProgram: correctProgram.replace(search, replacement),
      finalBoard,
      finalTurtles,
      ...(bugKind ? { bugKind } : {}),
    },
  ];
}
