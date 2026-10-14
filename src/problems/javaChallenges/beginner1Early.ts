import type { JavaChallengeDefinition } from './types';

interface Variant {
  id: string;
  answer: string;
  replacement: string;
  bugKind: 'logical' | 'syntax';
  blank: boolean;
  blankAnswer?: string;
}

interface Model {
  id: string;
  title: string;
  lectureIndex: number;
  correctProgram: string;
  finalBoard: string;
  finalTurtles: JavaChallengeDefinition['finalTurtles'];
  variants: Variant[];
}

const models: Model[] = [
  {
    id: 'corner',
    title: '角のある道',
    lectureIndex: 0,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'E',
      },
    ],
    variants: [
      {
        id: 'approach',
        answer: '亀.前に進む();',
        replacement: '亀.後に戻る();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'turn',
        answer: '亀.右を向く();',
        replacement: '亀.左を向く();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'order',
        answer: '亀.右を向く();\n        亀.前に進む();',
        replacement: '亀.前に進む();\n        亀.右を向く();',
        bugKind: 'logical',
        blank: false,
      },
    ],
  },
  {
    id: 'return',
    title: '戻ってから進む道',
    lectureIndex: 0,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        亀.前に進む();
        亀.後に戻る();
        亀.左を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n..##...\n...#...\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
    variants: [
      {
        id: 'return',
        answer: '亀.後に戻る();',
        replacement: '亀.前に進む();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'turn',
        answer: '亀.左を向く();',
        replacement: '亀.右を向く();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'departure',
        answer: '亀.左を向く();\n        亀.前に進む();',
        replacement: '亀.左を向く();\n        亀.後に戻る();',
        bugKind: 'logical',
        blank: false,
      },
    ],
  },
  {
    id: 'stair',
    title: '階段の道',
    lectureIndex: 0,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 2);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n...#...\n...##..\n....#..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'firstTurn',
        answer: '亀.右を向く();',
        replacement: '亀.左を向く();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'secondTurn',
        answer: '亀.左を向く();',
        replacement: '亀.右を向く();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'order',
        answer: '亀.左を向く();\n        亀.前に進む();',
        replacement: '亀.前に進む();\n        亀.左を向く();',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'reverseCorner',
    title: '後ろ向きに描く道',
    lectureIndex: 0,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        亀.後に戻る();
        亀.右を向く();
        亀.後に戻る();
        亀.左を向く();
    }
}`,
    finalBoard: '.......\n.......\n..##...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'firstStep',
        answer: '亀.後に戻る();',
        replacement: '亀.前に進む();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'corner',
        answer: '亀.右を向く();',
        replacement: '亀.左を向く();',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'finish',
        answer: '亀.左を向く();',
        replacement: '亀.右を向く();',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'coordinateUpdate',
    title: '変数で決める出発点',
    lectureIndex: 1,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 2;
        x = x + 1;
        int y = x - 1;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n...#...\n...#...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'update',
        answer: 'x = x + 1;',
        replacement: 'x = x - 1;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'dependency',
        answer: 'int y = x - 1;',
        replacement: 'int y = x + 1;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'coordinates',
        answer: 'new Turtle(x, y)',
        replacement: 'new Turtle(y, x)',
        bugKind: 'logical',
        blank: false,
      },
    ],
  },
  {
    id: 'arithmeticCorner',
    title: '計算して描く角',
    lectureIndex: 1,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int width = 5;
        int x = width / 2;
        int y = width % 2;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n..#....\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
    variants: [
      {
        id: 'quotient',
        answer: 'int x = width / 2;',
        replacement: 'int x = width % 2;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'remainder',
        answer: 'int y = width % 2;',
        replacement: 'int y = width / 2;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'type',
        answer: 'int width = 5;',
        replacement: 'boolean width = 5;',
        bugKind: 'syntax',
        blank: true,
      },
    ],
  },
  {
    id: 'variableSquare',
    title: '変数と四角い道',
    lectureIndex: 1,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 2;
        int y = x + 1;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n..##...\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
    variants: [
      {
        id: 'origin',
        answer: 'int y = x + 1;',
        replacement: 'int y = x - 1;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'initialization',
        answer: 'int x = 2;',
        replacement: 'int x;',
        bugKind: 'syntax',
        blank: true,
      },
      {
        id: 'orientation',
        answer: '亀.右を向く();',
        replacement: '亀.左を向く();',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'assignmentPath',
    title: '代入を追って描く道',
    lectureIndex: 1,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 4;
        int y = x - 2;
        x = y + 1;
        Turtle 亀 = new Turtle(x, y);
        亀.後に戻る();
        亀.左を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n..##...\n...#...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 1,
        color: '#',
        dir: 'W',
      },
    ],
    variants: [
      {
        id: 'dependency',
        answer: 'int y = x - 2;',
        replacement: 'int y = x - 1;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'assignment',
        answer: 'x = y + 1;',
        replacement: 'y = x + 1;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'operator',
        answer: 'x = y + 1;',
        replacement: 'x = y - 1;',
        bugKind: 'logical',
        blank: true,
        blankAnswer: 'y + 1',
      },
    ],
  },
  {
    id: 'countedLine',
    title: '繰り返して描く直線',
    lectureIndex: 2,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        for (int i = 0; i < 3; i++) {
            亀.前に進む();
        }
    }
}`,
    finalBoard: '.......\n..#....\n..#....\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'bound',
        answer: 'i < 3',
        replacement: 'i <= 3',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'initial',
        answer: 'int i = 0',
        replacement: 'int i = 1',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'conditionType',
        answer: 'i < 3',
        replacement: 'i + 3',
        bugKind: 'syntax',
        blank: false,
      },
    ],
  },
  {
    id: 'whileCountdown',
    title: '残り回数で描く道',
    lectureIndex: 2,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(1, 2);
        亀.右を向く();
        int remaining = 4;
        while (remaining > 0) {
            亀.前に進む();
            remaining--;
        }
    }
}`,
    finalBoard: '.......\n.......\n.#####.\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
    variants: [
      {
        id: 'bound',
        answer: 'remaining > 0',
        replacement: 'remaining > 1',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'update',
        answer: 'remaining--;',
        replacement: 'remaining -= 2;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'conditionType',
        answer: 'remaining > 0',
        replacement: 'remaining',
        bugKind: 'syntax',
        blank: true,
        blankAnswer: 'int remaining = 4;',
      },
    ],
  },
  {
    id: 'loopStairs',
    title: '繰り返す階段',
    lectureIndex: 2,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(1, 1);
        for (int step = 0; step < 3; step++) {
            亀.前に進む();
            亀.右を向く();
            亀.前に進む();
            亀.左を向く();
        }
    }
}`,
    finalBoard: '.......\n.#.....\n.##....\n..##...\n...##..\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'stride',
        answer: 'step++',
        replacement: 'step += 2',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'bound',
        answer: 'step < 3',
        replacement: 'step <= 3',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'heading',
        answer: '亀.左を向く();',
        replacement: '亀.右を向く();',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'whileCorner',
    title: '二つの直線をつなぐ',
    lectureIndex: 2,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(1, 1);
        int i = 0;
        while (i < 2) {
            亀.前に進む();
            i++;
        }
        亀.右を向く();
        i = 0;
        while (i < 3) {
            亀.前に進む();
            i++;
        }
    }
}`,
    finalBoard: '.......\n.#.....\n.#.....\n.####..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
    variants: [
      {
        id: 'firstBound',
        answer: 'i < 2',
        replacement: 'i <= 2',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'reset',
        answer: '亀.右を向く();\n        i = 0;',
        replacement: '亀.右を向く();\n        i = 2;',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'secondBound',
        answer: 'i < 3',
        replacement: 'i < 2',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'nestedRectangle',
    title: '二重ループで描く四角',
    lectureIndex: 3,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 2);
        for (int side = 0; side < 4; side++) {
            for (int step = 0; step < 2; step++) {
                亀.前に進む();
            }
            亀.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n..###..\n..#.#..\n..###..\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'outerBound',
        answer: 'side < 4',
        replacement: 'side < 3',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'innerBound',
        answer: 'step < 2',
        replacement: 'step < 1',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'innerCondition',
        answer: 'step < 2',
        replacement: 'step + 2',
        bugKind: 'syntax',
        blank: false,
      },
    ],
  },
  {
    id: 'branchStair',
    title: '条件に合わせて曲がる道',
    lectureIndex: 3,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        for (int i = 0; i < 4; i++) {
            亀.前に進む();
            if (i == 1) {
                亀.右を向く();
            }
        }
    }
}`,
    finalBoard: '.......\n..#....\n..#....\n..###..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
    variants: [
      {
        id: 'branchCondition',
        answer: 'i == 1',
        replacement: 'i == 2',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'comparison',
        answer: 'i == 1',
        replacement: 'i = 1',
        bugKind: 'syntax',
        blank: true,
        blankAnswer: 'int i = 0',
      },
      {
        id: 'turn',
        answer: '亀.右を向く();',
        replacement: '亀.左を向く();',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'nestedStairs',
    title: '段ごとに長さが変わる道',
    lectureIndex: 3,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(1, 1);
        for (int row = 1; row <= 2; row++) {
            for (int step = 0; step < row; step++) {
                亀.前に進む();
            }
            亀.右を向く();
            亀.前に進む();
            亀.左を向く();
        }
    }
}`,
    finalBoard: '.......\n.#.....\n.##....\n..#....\n..##...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'dependentBound',
        answer: 'step < row',
        replacement: 'step < 1',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'outerBound',
        answer: 'row <= 2',
        replacement: 'row < 2',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'innerUpdate',
        answer: 'step++',
        replacement: 'step += 2',
        bugKind: 'logical',
        blank: true,
      },
    ],
  },
  {
    id: 'alternatingTurn',
    title: '交互に曲がる道',
    lectureIndex: 3,
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        for (int i = 0; i < 4; i++) {
            亀.前に進む();
            if (i % 2 == 0) {
                亀.右を向く();
            }
            if (i % 2 == 1) {
                亀.左を向く();
            }
        }
    }
}`,
    finalBoard: '.......\n..#....\n..##...\n...##..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
    variants: [
      {
        id: 'firstCondition',
        answer: 'i % 2 == 0',
        replacement: 'i % 2 == 1',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'secondCondition',
        answer: 'i % 2 == 1',
        replacement: 'i % 2 == 0',
        bugKind: 'logical',
        blank: true,
      },
      {
        id: 'booleanType',
        answer: 'i % 2 == 0',
        replacement: 'i % 2',
        bugKind: 'syntax',
        blank: true,
        blankAnswer: 'i < 4',
      },
    ],
  },
];

export const beginner1Early: Record<string, JavaChallengeDefinition> = Object.fromEntries(
  models.flatMap((model) =>
    model.variants.flatMap((variant, index) => {
      const common = {
        title: `${model.title}（${index + 1}）`,
        courseId: 'tuBeginner1' as const,
        lectureIndex: model.lectureIndex,
        correctProgram: model.correctProgram,
        finalBoard: model.finalBoard,
        finalTurtles: model.finalTurtles,
      };
      const id = `javaI${model.lectureIndex + 1}${model.id[0].toUpperCase()}${model.id.slice(1)}${variant.id[0].toUpperCase()}${variant.id.slice(1)}`;
      const bug: [string, JavaChallengeDefinition] = [
        `${id}Bug`,
        {
          ...common,
          problemFormat: 'bugFix',
          starterProgram: model.correctProgram.replace(variant.answer, variant.replacement),
          bugKind: variant.bugKind,
        },
      ];
      if (!variant.blank) return [bug];
      const blankAnswer = variant.blankAnswer ?? variant.answer;
      const blank: [string, JavaChallengeDefinition] = [
        `${id}Blank`,
        {
          ...common,
          problemFormat: 'fillInBlank',
          starterProgram: model.correctProgram.replace(blankAnswer, `@[${blankAnswer}]@`),
        },
      ];
      return [blank, bug];
    })
  )
);
