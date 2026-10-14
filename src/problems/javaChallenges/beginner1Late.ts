import type { JavaChallengeDefinition } from './types';

type Model = Pick<
  JavaChallengeDefinition,
  'lectureIndex' | 'title' | 'correctProgram' | 'finalBoard' | 'finalTurtles'
> & {
  blanks: { id: string; answer: string }[];
  bugs: { id: string; from: string; to: string; kind: 'logical' | 'syntax' }[];
};

const models: Model[] = [
  {
    lectureIndex: 4,
    title: '分岐する道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 4; i++) {
            if (i < 2) t.前に進む();
            else if (i == 2) t.右を向く();
            else t.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...##..\n.......',
    finalTurtles: [{ x: 4, y: 5, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI5BranchRouteBlank1', answer: 'i < 2' },
      { id: 'javaI5BranchRouteBlank2', answer: 'i == 2' },
    ],
    bugs: [
      { id: 'javaI5BranchRouteBug1', from: 'i == 2', to: 'i == 3', kind: 'logical' },
      { id: 'javaI5BranchRouteBug2', from: 'else if (i == 2)', to: 'else (i == 2)', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 4,
    title: '条件の優先順位',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int score = 3;
        if (score >= 4) t.左を向く();
        else if (score >= 2) t.右を向く();
        else t.前に進む();
        t.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...##..\n.......\n.......\n.......',
    finalTurtles: [{ x: 4, y: 3, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI5BranchPriorityBlank1', answer: 'score >= 4' },
      { id: 'javaI5BranchPriorityBlank2', answer: 'score >= 2' },
    ],
    bugs: [
      { id: 'javaI5BranchPriorityBug1', from: 'score >= 4', to: 'score >= 2', kind: 'logical' },
      { id: 'javaI5BranchPriorityBug2', from: 'else if (score >= 2)', to: 'else if (score)', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 4,
    title: '順番に進む道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 4; i++) {
            if (i % 3 == 0) t.前に進む();
            else if (i % 3 == 1) t.右を向く();
            else t.後に戻る();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n..##...\n.......\n.......',
    finalTurtles: [{ x: 3, y: 4, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI5BranchRemainderBlank1', answer: 'i % 3 == 0' },
      { id: 'javaI5BranchRemainderBlank2', answer: 'i % 3 == 1' },
    ],
    bugs: [
      { id: 'javaI5BranchRemainderBug1', from: 'i % 3 == 1', to: 'i % 3 == 2', kind: 'logical' },
      { id: 'javaI5BranchRemainderBug2', from: 'else if (i % 3 == 1)', to: 'else if (i % 3)', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 4,
    title: '番号で選ぶ道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int command = 0; command < 4; command++) {
            switch (command) {
                case 0: case 1: t.前に進む(); break;
                case 2: t.右を向く(); break;
                default: t.後に戻る(); break;
            }
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n..##...\n.......',
    finalTurtles: [{ x: 2, y: 5, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI5SwitchGroupBlank1', answer: 'case 0: case 1:' },
      { id: 'javaI5SwitchGroupBlank2', answer: 'switch (command)' },
    ],
    bugs: [
      {
        id: 'javaI5SwitchGroupBug1',
        from: 'case 2: t.右を向く(); break;',
        to: 'case 2: t.右を向く();',
        kind: 'logical',
      },
      { id: 'javaI5SwitchGroupBug2', from: 'switch (command)', to: 'switch (command == 2)', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 4,
    title: '連続して描く道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int level = 2;
        switch (level) {
            case 3: t.前に進む();
            case 2: t.右を向く();
            case 1: t.前に進む(); break;
            default: t.左を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...##..\n.......\n.......\n.......',
    finalTurtles: [{ x: 4, y: 3, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI5SwitchCascadeBlank1', answer: 'case 2:' },
      { id: 'javaI5SwitchCascadeBlank2', answer: 't.右を向く();' },
    ],
    bugs: [
      {
        id: 'javaI5SwitchCascadeBug1',
        from: 'case 2: t.右を向く();',
        to: 'case 2: t.右を向く(); break;',
        kind: 'logical',
      },
      { id: 'javaI5SwitchCascadeBug2', from: 'case 2:', to: 'case level:', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 4,
    title: '合図で選ぶ道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        char command = 'X';
        switch (command) {
            case 'L': t.左を向く(); break;
            case 'R': t.右を向く(); break;
            default: t.前に進む(); break;
        }
        t.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [{ id: 'javaI5SwitchDefaultBlank1', answer: 'default:' }],
    bugs: [
      { id: 'javaI5SwitchDefaultBug1', from: 'default: t.前に進む();', to: 'default: t.右を向く();', kind: 'logical' },
      { id: 'javaI5SwitchDefaultBug2', from: "case 'R':", to: "case 'L':", kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 5,
    title: '途中で止まる線',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 3; i > 0; i--) {
            if (i == 1) break;
            t.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI6BreakCountBlank1', answer: 'i == 1' },
      { id: 'javaI6BreakCountBlank2', answer: 'break' },
    ],
    bugs: [
      { id: 'javaI6BreakCountBug1', from: 'i == 1', to: 'i == 2', kind: 'logical' },
      { id: 'javaI6BreakCountBug2', from: 'break;', to: 'break();', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 5,
    title: '途中まで描く階段',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int row = 0; row < 2; row++) {
            for (int col = 0; col < 3; col++) {
                if (col == 1) break;
                t.前に進む();
            }
            t.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'S' }],
    blanks: [
      { id: 'javaI6BreakNestedBlank1', answer: 'col == 1' },
      { id: 'javaI6BreakNestedBlank2', answer: 'break' },
    ],
    bugs: [
      { id: 'javaI6BreakNestedBug1', from: 'break;', to: 'continue;', kind: 'logical' },
      { id: 'javaI6BreakNestedBug2', from: 'col == 1', to: 'col == 2', kind: 'logical' },
    ],
  },
  {
    lectureIndex: 5,
    title: '条件が合うまで進む',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int value = 0;
        while (value < 3) {
            value++;
            if (value % 2 == 0) break;
            t.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n.......\n.......',
    finalTurtles: [{ x: 3, y: 4, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI6BreakSearchBlank1', answer: 'value % 2 == 0' },
      { id: 'javaI6BreakSearchBlank2', answer: 'value++' },
    ],
    bugs: [
      { id: 'javaI6BreakSearchBug1', from: 'value % 2 == 0', to: 'value % 2 == 1', kind: 'logical' },
      { id: 'javaI6BreakSearchBug2', from: 'value % 2 == 0', to: 'value == 3', kind: 'logical' },
    ],
  },
  {
    lectureIndex: 5,
    title: '休みながら進む線',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 3; i++) {
            if (i == 1) continue;
            t.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI6ContinueSkipBlank1', answer: 'i == 1' },
      { id: 'javaI6ContinueSkipBlank2', answer: 'continue' },
    ],
    bugs: [
      { id: 'javaI6ContinueSkipBug1', from: 'continue;', to: 'break;', kind: 'logical' },
      { id: 'javaI6ContinueSkipBug2', from: 'i == 1', to: 'i < 2', kind: 'logical' },
    ],
  },
  {
    lectureIndex: 5,
    title: '曲がる順番',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 3; i++) {
            t.前に進む();
            if (i % 2 == 0) continue;
            t.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...##..\n.......',
    finalTurtles: [{ x: 4, y: 5, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI6ContinueTurnsBlank1', answer: 'i % 2 == 0' },
      { id: 'javaI6ContinueTurnsBlank2', answer: 'continue' },
    ],
    bugs: [
      { id: 'javaI6ContinueTurnsBug1', from: 'i % 2 == 0', to: 'i % 2 != 0', kind: 'logical' },
      { id: 'javaI6ContinueTurnsBug2', from: 'continue;', to: 'continue();', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 5,
    title: '数えながら進む線',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int i = 0;
        while (i < 4) {
            i++;
            if (i == 2) continue;
            t.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n...#...',
    finalTurtles: [{ x: 3, y: 6, color: '#', dir: 'N' }],
    blanks: [{ id: 'javaI6ContinueWhileBlank1', answer: 'continue' }],
    bugs: [
      { id: 'javaI6ContinueWhileBug1', from: 'continue;', to: 'break;', kind: 'logical' },
      { id: 'javaI6ContinueWhileBug2', from: 'i == 2', to: 'i < 3', kind: 'logical' },
    ],
  },
  {
    lectureIndex: 6,
    title: '長さを指定する道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        advance(t, 2);
        t.右を向く();
        advance(t, 1);
    }
    static void advance(Turtle turtle, int steps) {
        for (int i = 0; i < steps; i++) turtle.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...##..\n.......',
    finalTurtles: [{ x: 4, y: 5, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI7MethodStepsBlank1', answer: 'i < steps' },
      { id: 'javaI7MethodStepsBlank2', answer: 'Turtle turtle' },
    ],
    bugs: [
      { id: 'javaI7MethodStepsBug1', from: 'i < steps', to: 'i <= steps', kind: 'logical' },
      { id: 'javaI7MethodStepsBug2', from: 'int steps', to: 'String steps', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 6,
    title: '角をつなぐ道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        corner(t);
        corner(t);
    }
    static void corner(Turtle turtle) {
        turtle.前に進む();
        turtle.右を向く();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'S' }],
    blanks: [
      { id: 'javaI7MethodCornerBlank1', answer: 'turtle.右を向く();' },
      { id: 'javaI7MethodCornerBlank2', answer: 'corner(t);\n        corner(t);' },
    ],
    bugs: [
      { id: 'javaI7MethodCornerBug1', from: 'turtle.右を向く();', to: 'turtle.左を向く();', kind: 'logical' },
      {
        id: 'javaI7MethodCornerBug2',
        from: 'static void corner(Turtle turtle)',
        to: 'static int corner(Turtle turtle)',
        kind: 'syntax',
      },
    ],
  },
  {
    lectureIndex: 6,
    title: '計算した長さの線',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int steps = difference(5, 3);
        for (int i = 0; i < steps; i++) t.前に進む();
    }
    static int difference(int a, int b) {
        return a - b;
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI7ReturnDifferenceBlank1', answer: 'a - b' },
      { id: 'javaI7ReturnDifferenceBlank2', answer: 'return a - b;' },
    ],
    bugs: [
      { id: 'javaI7ReturnDifferenceBug1', from: 'a - b', to: 'a / b', kind: 'logical' },
      { id: 'javaI7ReturnDifferenceBug2', from: 'static int difference', to: 'static void difference', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 6,
    title: '判定して描く道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        for (int i = 0; i < 3; i++) {
            if (isEven(i)) t.前に進む();
            else t.右を向く();
        }
    }
    static boolean isEven(int value) {
        return value % 2 == 0;
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI7ReturnBooleanBlank1', answer: 'value % 2 == 0' },
      { id: 'javaI7ReturnBooleanBlank2', answer: 'boolean' },
    ],
    bugs: [
      { id: 'javaI7ReturnBooleanBug1', from: 'value % 2 == 0', to: 'value % 2 != 0', kind: 'logical' },
      { id: 'javaI7ReturnBooleanBug2', from: 'return value % 2 == 0;', to: 'return value % 2;', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 6,
    title: '長さを選ぶ道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int steps = smaller(2, 3);
        for (int i = 0; i < steps; i++) t.前に進む();
    }
    static int smaller(int a, int b) {
        if (a < b) return a;
        return b;
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI7ReturnChoiceBlank1', answer: 'a < b' },
      { id: 'javaI7ReturnChoiceBlank2', answer: 'return b;' },
    ],
    bugs: [
      { id: 'javaI7ReturnChoiceBug1', from: 'a < b', to: 'a > b', kind: 'logical' },
      { id: 'javaI7ReturnChoiceBug2', from: 'return b;', to: 'return;', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 6,
    title: '引数と変数の道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int steps = 1;
        advance(t, steps);
        for (int i = 0; i < steps; i++) t.前に進む();
    }
    static void advance(Turtle turtle, int steps) {
        steps++;
        for (int i = 0; i < steps; i++) turtle.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n...#...',
    finalTurtles: [{ x: 3, y: 6, color: '#', dir: 'N' }],
    blanks: [{ id: 'javaI7MethodValueBlank1', answer: 'steps++;' }],
    bugs: [
      { id: 'javaI7MethodValueBug1', from: 'steps++;', to: 'steps--;', kind: 'logical' },
      { id: 'javaI7MethodValueBug2', from: 'advance(t, steps);', to: 'advance(steps, t);', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 7,
    title: '配列で決める道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int[] lengths = {1, 2};
        for (int i = 0; i < lengths.length; i++) {
            for (int j = 0; j < lengths[i]; j++) t.前に進む();
            t.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...###.\n.......\n.......',
    finalTurtles: [{ x: 5, y: 4, color: '#', dir: 'S' }],
    blanks: [
      { id: 'javaI8ArrayRouteBlank1', answer: 'lengths.length' },
      { id: 'javaI8ArrayRouteBlank2', answer: 'lengths[i]' },
    ],
    bugs: [
      { id: 'javaI8ArrayRouteBug1', from: 'lengths[i]', to: 'lengths[0]', kind: 'logical' },
      { id: 'javaI8ArrayRouteBug2', from: 'lengths.length', to: 'lengths.length()', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 7,
    title: '書き換えた配列の道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int[] lengths = {1, 2};
        lengths[0] = lengths[1];
        for (int i = 0; i < lengths[0]; i++) t.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI8ArrayUpdateBlank1', answer: 'lengths[0] = lengths[1];' },
      { id: 'javaI8ArrayUpdateBlank2', answer: 'lengths[0];' },
    ],
    bugs: [
      {
        id: 'javaI8ArrayUpdateBug1',
        from: 'lengths[0] = lengths[1];',
        to: 'lengths[1] = lengths[0];',
        kind: 'logical',
      },
      { id: 'javaI8ArrayUpdateBug2', from: 'int[] lengths', to: 'int lengths', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 7,
    title: '逆順にたどる道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        int[] lengths = {1, 2};
        for (int i = lengths.length - 1; i >= 0; i--) {
            for (int j = 0; j < lengths[i]; j++) t.前に進む();
            t.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...##..\n.......',
    finalTurtles: [{ x: 4, y: 5, color: '#', dir: 'S' }],
    blanks: [
      { id: 'javaI8ArrayReverseBlank1', answer: 'lengths.length - 1' },
      { id: 'javaI8ArrayReverseBlank2', answer: 'i >= 0' },
    ],
    bugs: [
      { id: 'javaI8ArrayReverseBug1', from: 'i >= 0', to: 'i > 0', kind: 'logical' },
      { id: 'javaI8ArrayReverseBug2', from: 'lengths[i]', to: 'lengths(i)', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 7,
    title: '文字で指定する道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        String commands = "FRF";
        for (int i = 0; i < commands.length(); i++) {
            if (commands.charAt(i) == 'F') t.前に進む();
            else t.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
    blanks: [
      { id: 'javaI8StringCommandsBlank1', answer: 'commands.length()' },
      { id: 'javaI8StringCommandsBlank2', answer: 'commands.charAt(i)' },
    ],
    bugs: [
      {
        id: 'javaI8StringCommandsBug1',
        from: "commands.charAt(i) == 'F'",
        to: "commands.charAt(i) == 'R'",
        kind: 'logical',
      },
      { id: 'javaI8StringCommandsBug2', from: 'commands.charAt(i)', to: 'commands[i]', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 7,
    title: '文字列から選ぶ道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        String commands = "LFR";
        String selected = commands.substring(1, 2);
        if (selected.equals("F")) t.前に進む();
        else t.右を向く();
        t.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...#...\n...#...\n.......',
    finalTurtles: [{ x: 3, y: 5, color: '#', dir: 'N' }],
    blanks: [
      { id: 'javaI8StringSliceBlank1', answer: 'commands.substring(1, 2)' },
      { id: 'javaI8StringSliceBlank2', answer: 'selected.equals("F")' },
    ],
    bugs: [
      {
        id: 'javaI8StringSliceBug1',
        from: 'commands.substring(1, 2)',
        to: 'commands.substring(0, 1)',
        kind: 'logical',
      },
      { id: 'javaI8StringSliceBug2', from: 'String selected', to: 'char selected', kind: 'syntax' },
    ],
  },
  {
    lectureIndex: 7,
    title: 'つなげた合図の道',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        String commands = "F";
        commands = commands + "RF";
        for (int i = 0; i < commands.length(); i++) {
            char command = commands.charAt(i);
            if (command == 'R') t.右を向く();
            else t.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
    blanks: [{ id: 'javaI8StringJoinBlank1', answer: 'commands + "RF"' }],
    bugs: [
      { id: 'javaI8StringJoinBug1', from: 'commands = commands + "RF";', to: 'commands = "RF";', kind: 'logical' },
      { id: 'javaI8StringJoinBug2', from: 'char command', to: 'String command', kind: 'syntax' },
    ],
  },
];

export const beginner1Late: Record<string, JavaChallengeDefinition> = Object.fromEntries(models.flatMap(expandModel));

function expandModel(model: Model): [string, JavaChallengeDefinition][] {
  const { blanks, bugs, ...shared } = model;
  const entries: [string, JavaChallengeDefinition][] = [];
  for (const [index, blank] of blanks.entries()) {
    entries.push([
      blank.id,
      {
        ...shared,
        courseId: 'tuBeginner1',
        problemFormat: 'fillInBlank',
        title: `${model.title}（穴埋め${index + 1}）`,
        starterProgram: replaceOnce(model.correctProgram, blank.answer, `@[${blank.answer}]@`),
      },
    ]);
  }
  for (const [index, bug] of bugs.entries()) {
    entries.push([
      bug.id,
      {
        ...shared,
        courseId: 'tuBeginner1',
        problemFormat: 'bugFix',
        title: `${model.title}（修正${index + 1}）`,
        starterProgram: replaceOnce(model.correctProgram, bug.from, bug.to),
        bugKind: bug.kind,
      },
    ]);
  }
  return entries;
}

function replaceOnce(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw new Error(`Expected one occurrence of ${from}`);
  return source.replace(from, () => to);
}
