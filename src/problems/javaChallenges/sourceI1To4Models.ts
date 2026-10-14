import type { SourceJavaModel } from './sourceModels';

export const sourceI1To4Models = {
  straight: {
    title: '線を描こう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'straight',
    authoringSeed: 'source-expansion-v1:straight',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n#......\n#......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  straight2: {
    title: '線を描こう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'straight2',
    authoringSeed: 'source-expansion-v1:straight2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n#......\n#......\n#......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  stepBack: {
    title: '線を描こう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'stepBack',
    authoringSeed: 'source-expansion-v1:stepBack',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.後に戻る();
    }
}`,
    finalBoard: '#......\n#......\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 0,
        color: '#',
        dir: 'N',
      },
    ],
  },
  stepBack2: {
    title: '線を描こう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'stepBack2',
    authoringSeed: 'source-expansion-v1:stepBack2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.後に戻る();
        亀.前に進む();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n#......\n#......\n#......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  turnRight: {
    title: '線を描こう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'turnRight',
    authoringSeed: 'source-expansion-v1:turnRight',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 1,
        color: '#',
        dir: 'E',
      },
    ],
  },
  turnRight2: {
    title: '線を描こう(6)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'turnRight2',
    authoringSeed: 'source-expansion-v1:turnRight2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n#......\n###....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'E',
      },
    ],
  },
  turnLeftAndRight: {
    title: '線を描こう(7)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'turnLeftAndRight',
    authoringSeed: 'source-expansion-v1:turnLeftAndRight',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '##.....\n.#.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 1,
        color: '#',
        dir: 'N',
      },
    ],
  },
  turnLeftAndRight2: {
    title: '線を描こう(8)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'turnLeftAndRight2',
    authoringSeed: 'source-expansion-v1:turnLeftAndRight2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n##.....\n.#.....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  turnLeftAndRight3: {
    title: '線を描こう(9)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'turnLeftAndRight3',
    authoringSeed: 'source-expansion-v1:turnLeftAndRight3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.右を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '##.....\n.##....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 1,
        color: '#',
        dir: 'E',
      },
    ],
  },
  turnLeftAndRight4: {
    title: '線を描こう(10)',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    sourceProblemId: 'turnLeftAndRight4',
    authoringSeed: 'source-expansion-v1:turnLeftAndRight4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.前に進む();
    }
}`,
    finalBoard: '#......\n#......\n###....\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  square1: {
    title: '図形を描こう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'square1',
    authoringSeed: 'source-expansion-v1:square1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '##.....\n##.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 0,
        color: '#',
        dir: 'S',
      },
    ],
  },
  square2: {
    title: '図形を描こう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'square2',
    authoringSeed: 'source-expansion-v1:square2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n..##...\n..##...\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  square3: {
    title: '図形を描こう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'square3',
    authoringSeed: 'source-expansion-v1:square3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 3);
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
        亀.左を向く();
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n.##....\n.##....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'E',
      },
    ],
  },
  square4: {
    title: '図形を描こう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'square4',
    authoringSeed: 'source-expansion-v1:square4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
        亀.前に進む();
    }
}`,
    finalBoard: '###....\n#.#....\n###....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 0,
        color: '#',
        dir: 'W',
      },
    ],
  },
  variable: {
    title: '変数を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable',
    authoringSeed: 'source-expansion-v1:variable',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        Turtle 亀 = new Turtle(x, 3);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n.#.....\n.#.....\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable2: {
    title: '変数を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable2',
    authoringSeed: 'source-expansion-v1:variable2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int a = 4;
        a = a - 1;
        Turtle 亀 = new Turtle(2, a);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n..#....\n..#....\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable3: {
    title: '変数を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable3',
    authoringSeed: 'source-expansion-v1:variable3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 3;
        x = x + 1;
        int y = x + 1;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n.......\n.......\n....#..\n....#..',
    finalTurtles: [
      {
        x: 4,
        y: 6,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable4: {
    title: '変数を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable4',
    authoringSeed: 'source-expansion-v1:variable4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int b = 3;
        b = b + 1;
        int a = b - 2;
        Turtle 亀 = new Turtle(a + 1, b);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n.......\n...#...\n...#...\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 5,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable5: {
    title: '変数を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable5',
    authoringSeed: 'source-expansion-v1:variable5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 1;
        x--;
        int y = x * 2;
        y /= 3;
        Turtle 亀 = new Turtle(x + 1, y + 1);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.#.....\n.#.....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable6: {
    title: '変数を使おう(6)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable6',
    authoringSeed: 'source-expansion-v1:variable6',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int a = 1;
        int b = a * 2;
        int c = b - 2;
        Turtle 亀 = new Turtle(c, b);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n#......\n#......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable7: {
    title: '変数を使おう(7)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable7',
    authoringSeed: 'source-expansion-v1:variable7',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 0;
        int y = (x * 2) + 1;
        int z = (y * 2) + (x / 2);
        x = z / 3;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n#......\n#......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable8: {
    title: '変数を使おう(8)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable8',
    authoringSeed: 'source-expansion-v1:variable8',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 0;
        int y = (x * 3) + 2;
        int z = (y * 2) - (x * 3);
        x = (z / 4) % 7;
        y = (x + y) % 7;
        Turtle 亀 = new Turtle(x, y);
        亀.後に戻る();
    }
}`,
    finalBoard: '.......\n.......\n.#.....\n.#.....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable9: {
    title: '変数を使おう(9)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable9',
    authoringSeed: 'source-expansion-v1:variable9',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 0;
        int y = (x * 4) + 3;
        int z = (y * 3) - (x * 2);
        x = ((z / 5) + x) % 7;
        y = ((x * 2) + y) % 7;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n.......\n.......\n.......\n.#.....\n.#.....',
    finalTurtles: [
      {
        x: 1,
        y: 6,
        color: '#',
        dir: 'N',
      },
    ],
  },
  variable10: {
    title: '変数を使おう(10)',
    courseId: 'tuBeginner1',
    lectureIndex: 1,
    sourceProblemId: 'variable10',
    authoringSeed: 'source-expansion-v1:variable10',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 0;
        int y = (x * 5) + 4;
        int z = (y * 2) - (x * 3);
        int w = (z + x) % 5;
        x = ((z / 6) + w) % 7;
        y = ((x * 3) + y) % 7;
        Turtle 亀 = new Turtle(x, y);
        亀.前に進む();
    }
}`,
    finalBoard: '.......\n.......\n....#..\n....#..\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  while1: {
    title: 'while文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'while1',
    authoringSeed: 'source-expansion-v1:while1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 0;
        while (i < 4) {
            亀.前に進む();
            i++;
        }
    }
}`,
    finalBoard: '#......\n#......\n#......\n#......\n#......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 4,
        color: '#',
        dir: 'N',
      },
    ],
  },
  while2: {
    title: 'while文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'while2',
    authoringSeed: 'source-expansion-v1:while2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(0, 0);
        int i = 1;
        while (i < 4) {
            亀.前に進む();
            i++;
        }
    }
}`,
    finalBoard: '#......\n#......\n#......\n#......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  while3: {
    title: 'while文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'while3',
    authoringSeed: 'source-expansion-v1:while3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 0;
        while (i < 2) {
            i++;
            亀.前に進む();
            亀.右を向く();
        }
    }
}`,
    finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  while4: {
    title: 'while文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'while4',
    authoringSeed: 'source-expansion-v1:while4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(0, 0);
        亀.右を向く();
        int i = 1;
        while (i < 4) {
            亀.前に進む();
            亀.前に進む();
            亀.左を向く();
            i++;
        }
    }
}`,
    finalBoard: '###....\n..#....\n###....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  while5: {
    title: 'while文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'while5',
    authoringSeed: 'source-expansion-v1:while5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 1;
        while (i < 3) {
            亀.前に進む();
            亀.右を向く();
            亀.前に進む();
            亀.左を向く();
            i++;
        }
    }
}`,
    finalBoard: '#......\n##.....\n.##....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  for1: {
    title: 'for文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for1',
    authoringSeed: 'source-expansion-v1:for1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        for (int i = 0; i < 3; i++) {
            亀.前に進む();
        }
    }
}`,
    finalBoard: '#......\n#......\n#......\n#......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
  for2: {
    title: 'for文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for2',
    authoringSeed: 'source-expansion-v1:for2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(1, 1);
        for (int i = 1; i < 5; i++) {
            亀.前に進む();
        }
    }
}`,
    finalBoard: '.......\n.#.....\n.#.....\n.#.....\n.#.....\n.#.....\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 5,
        color: '#',
        dir: 'N',
      },
    ],
  },
  for3: {
    title: 'for文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for3',
    authoringSeed: 'source-expansion-v1:for3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle();
        int i = 0;
        for (; i < 2;) {
            亀.前に進む();
            亀.右を向く();
            i++;
        }
    }
}`,
    finalBoard: '#......\n##.....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 1,
        y: 1,
        color: '#',
        dir: 'S',
      },
    ],
  },
  for4: {
    title: 'for文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for4',
    authoringSeed: 'source-expansion-v1:for4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(1, 1);
        int i = 1;
        for (; i < 3;) {
            亀.前に進む();
            亀.右を向く();
            i++;
        }
        亀.後に戻る();
    }
}`,
    finalBoard: '.......\n.#.....\n.##....\n..#....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 3,
        color: '#',
        dir: 'S',
      },
    ],
  },
  for5: {
    title: 'for文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for5',
    authoringSeed: 'source-expansion-v1:for5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int x = 0;
        for (int i = 2; i <= 4; i++) {
            x += i;
        }
        x /= 3;
        Turtle 亀 = new Turtle(x + 1, 0);
        亀.前に進む();
    }
}`,
    finalBoard: '....#..\n....#..\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 4,
        y: 1,
        color: '#',
        dir: 'N',
      },
    ],
  },
  for6: {
    title: 'for文を使おう(6)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for6',
    authoringSeed: 'source-expansion-v1:for6',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        int a = 0;
        int b = 100;
        for (int i = 4; i > 0; i--) {
            a += i;
            b -= i;
        }
        a /= 4;
        b /= 5;
        Turtle 亀 = new Turtle(a % 6, b % 6);
        亀.前に進む();
    }
}`,
    finalBoard: '..#....\n..#....\n.......\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 1,
        color: '#',
        dir: 'N',
      },
    ],
  },
  for7: {
    title: 'for文を使おう(7)',
    courseId: 'tuBeginner1',
    lectureIndex: 2,
    sourceProblemId: 'for7',
    authoringSeed: 'source-expansion-v1:for7',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        int sum = 0;
        for (int i = 1; i <= 4; i++) {
            sum += i;
            亀.前に進む();
            亀.左を向く();
        }
        for (int i = sum / 4; i >= 0; i--) {
            亀.前に進む();
            亀.前に進む();
            亀.右を向く();
        }
    }
}`,
    finalBoard: '.......\n.......\n.......\n..##.#.\n..##.#.\n...###.\n.......',
    finalTurtles: [
      {
        x: 5,
        y: 3,
        color: '#',
        dir: 'W',
      },
    ],
  },
  doubleLoop1: {
    title: '二重ループ(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'doubleLoop1',
    authoringSeed: 'source-expansion-v1:doubleLoop1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                t.前に進む();
            }
            t.右を向く();
        }
    }
}`,
    finalBoard: '#......\n#......\n###....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  doubleLoop2: {
    title: '二重ループ(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'doubleLoop2',
    authoringSeed: 'source-expansion-v1:doubleLoop2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        t.右を向く();
        for (int i = 0; i < 2; i++) {
            for (int j = 0; j < 2; j++) {
                t.前に進む();
            }
            t.左を向く();
        }
    }
}`,
    finalBoard: '###....\n..#....\n..#....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  doubleLoop3: {
    title: '二重ループ(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'doubleLoop3',
    authoringSeed: 'source-expansion-v1:doubleLoop3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 3; i > 0; i--) {
            for (int j = 0; j < i; j++) {
                t.前に進む();
            }
            t.右を向く();
        }
    }
}`,
    finalBoard: '#......\n#......\n#.#....\n###....\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  doubleLoop4: {
    title: '二重ループ(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'doubleLoop4',
    authoringSeed: 'source-expansion-v1:doubleLoop4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 3; i > 0; i--) {
            int j = i;
            while (j >= 0) {
                t.前に進む();
                j--;
            }
            t.右を向く();
        }
    }
}`,
    finalBoard: '#......\n#......\n#..#...\n#..#...\n####...\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'W',
      },
    ],
  },
  doubleLoop5: {
    title: '二重ループ(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'doubleLoop5',
    authoringSeed: 'source-expansion-v1:doubleLoop5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j <= i; j++) {
                t.前に進む();
            }
            t.右を向く();
            for (int k = 0; k < i; k++) {
                t.前に進む();
            }
            t.左を向く();
        }
    }
}`,
    finalBoard: '#......\n#......\n#......\n##.....\n.#.....\n.#.....\n.###...',
    finalTurtles: [
      {
        x: 3,
        y: 6,
        color: '#',
        dir: 'N',
      },
    ],
  },
  if1: {
    title: 'if文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'if1',
    authoringSeed: 'source-expansion-v1:if1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 7; i++) {
            t.前に進む();
            if (i % 3 == 2) {
                t.右を向く();
            }
        }
    }
}`,
    finalBoard: '#......\n#......\n#..#...\n####...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 2,
        color: '#',
        dir: 'S',
      },
    ],
  },
  if2: {
    title: 'if文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'if2',
    authoringSeed: 'source-expansion-v1:if2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1);
        t.右を向く();
        for (int i = 0; i < 8; i++) {
            t.前に進む();
            if (i % 3 == 1) {
                t.左を向く();
            }
        }
    }
}`,
    finalBoard: '.......\n.###...\n...#...\n...#...\n####...\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 4,
        color: '#',
        dir: 'S',
      },
    ],
  },
  if3: {
    title: 'if文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'if3',
    authoringSeed: 'source-expansion-v1:if3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 4; i++) {
            t.前に進む();
            if (i % 2 == 0) {
                t.右を向く();
            } else {
                t.左を向く();
            }
        }
    }
}`,
    finalBoard: '#......\n##.....\n.##....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 2,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  if4: {
    title: 'if文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'if4',
    authoringSeed: 'source-expansion-v1:if4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 4; i++) {
            t.前に進む();
            if (i % 3 == 0) {
                t.右を向く();
            } else {
                t.左を向く();
            }
        }
    }
}`,
    finalBoard: '#......\n##.....\n##.....\n.......\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 0,
        y: 2,
        color: '#',
        dir: 'N',
      },
    ],
  },
  if5: {
    title: 'if文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 3,
    sourceProblemId: 'if5',
    authoringSeed: 'source-expansion-v1:if5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 2; j++) {
                if (j % 2 == 0) {
                    t.前に進む();
                } else {
                    t.右を向く();
                }
            }
            t.前に進む();
            t.左を向く();
        }
    }
}`,
    finalBoard: '#......\n##.....\n.##....\n..##...\n.......\n.......\n.......',
    finalTurtles: [
      {
        x: 3,
        y: 3,
        color: '#',
        dir: 'N',
      },
    ],
  },
} satisfies Record<string, SourceJavaModel>;
