import type { SourceJavaModel } from './sourceModels';

export const sourceI5To8Models = {
  elseIf1: {
    title: 'else if文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'elseIf1',
    authoringSeed: 'source-expansion-v1:elseIf1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 5; i++) {
            if (i < 2)
                t.前に進む();
            else if (i == 2)
                t.左を向く();
            else
                t.後に戻る();
        }
    }
}`,
    finalBoard: `#......
#......
###....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 2, color: '#', dir: 'W' }],
  },
  elseIf2: {
    title: 'else if文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'elseIf2',
    authoringSeed: 'source-expansion-v1:elseIf2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 5; i++) {
            if (i % 4 == 0)
                t.前に進む();
            else if (i % 4 == 1)
                t.右を向く();
            else if (i % 4 == 2)
                t.前に進む();
            else
                t.左を向く();
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  elseIf3: {
    title: 'else if文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'elseIf3',
    authoringSeed: 'source-expansion-v1:elseIf3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 7; i++) {
            if (i < 2)
                t.前に進む();
            else if (i == 2)
                t.左を向く();
            else if (i == 4)
                t.右を向く();
            else
                t.後に戻る();
        }
    }
}`,
    finalBoard: `##.....
##.....
##.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 0, color: '#', dir: 'N' }],
  },
  elseIf4: {
    title: 'else if文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'elseIf4',
    authoringSeed: 'source-expansion-v1:elseIf4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 6; i++) {
            if (i % 5 == 0)
                t.前に進む();
            else if (i % 5 == 1)
                t.左を向く();
            else if (i % 5 == 2)
                t.後に戻る();
            else
                t.右を向く();
        }
    }
}`,
    finalBoard: `#......
###....
.......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 1, color: '#', dir: 'E' }],
  },
  elseIf5: {
    title: 'else if文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'elseIf5',
    authoringSeed: 'source-expansion-v1:elseIf5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 7; i++) {
            if (i % 5 == 1)
                t.右を向く();
            else if (i % 5 == 3)
                t.左を向く();
            else
                t.前に進む();
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.#.....
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 3, color: '#', dir: 'E' }],
  },
  switch1: {
    title: 'switch文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'switch1',
    authoringSeed: 'source-expansion-v1:switch1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 6; i++) {
            switch (i) {
                case 0: case 1:
                    t.前に進む(); break;
                case 2:
                    t.左を向く(); break;
                default:
                    t.後に戻る(); break;
            }
        }
    }
}`,
    finalBoard: `#......
#......
####...
.......
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 2, color: '#', dir: 'W' }],
  },
  switch2: {
    title: 'switch文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'switch2',
    authoringSeed: 'source-expansion-v1:switch2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 6; i++) {
            switch (i % 4) {
                case 1:
                    t.右を向く(); break;
                case 3:
                    t.左を向く(); break;
                default:
                    t.前に進む(); break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'E' }],
  },
  switch3: {
    title: 'switch文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'switch3',
    authoringSeed: 'source-expansion-v1:switch3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2);
        for (int i = 0; i < 6; i++) {
            switch (i) {
                case 0:
                case 1:
                    t.前に進む();
                    break;
                case 2:
                    t.左を向く();
                    break;
                case 4:
                case 5:
                    t.右を向く();
                    break;
                default:
                    t.後に戻る();
            }
        }
    }
}`,
    finalBoard: `.......
.......
..#....
..#....
..##...
.......
.......`,
    finalTurtles: [{ x: 3, y: 4, color: '#', dir: 'E' }],
  },
  switch4: {
    title: 'switch文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'switch4',
    authoringSeed: 'source-expansion-v1:switch4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 7; i++) {
            switch (i % 5) {
                case 0:
                    t.左を向く();
                    break;
                case 1:
                    t.後に戻る();
                    break;
                case 2:
                    t.右を向く();
                    break;
                default:
                    t.前に進む();
            }
        }
    }
}`,
    finalBoard: `##.....
.#.....
.##....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 2, color: '#', dir: 'W' }],
  },
  switch5: {
    title: 'switch文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 4,
    sourceProblemId: 'switch5',
    authoringSeed: 'source-expansion-v1:switch5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 9; i++) {
            switch (i % 6) {
                case 0:
                    t.左を向く();
                    break;
                case 1:
                case 2:
                    t.後に戻る();
                    break;
                case 3:
                    t.右を向く();
                    break;
                default:
                    t.前に進む();
            }
        }
    }
}`,
    finalBoard: `###....
..#....
..###..
.......
.......
.......
.......`,
    finalTurtles: [{ x: 4, y: 2, color: '#', dir: 'W' }],
  },
  break1: {
    title: 'break文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'break1',
    authoringSeed: 'source-expansion-v1:break1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む();
        }
    }
}`,
    finalBoard: `#......
#......
#......
#......
#......
#......
#......`,
    finalTurtles: [{ x: 0, y: 6, color: '#', dir: 'N' }],
  },
  break2: {
    title: 'break文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'break2',
    authoringSeed: 'source-expansion-v1:break2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 3);
        while (true) {
            if (!t.前に進めるか()) break;
            t.前に進む();
            t.右を向く();

            if (!t.前に進めるか()) break;
            t.前に進む();
            t.左を向く();
        }
    }
}`,
    finalBoard: `.......
.......
.......
...#...
...##..
....##.
.....##`,
    finalTurtles: [{ x: 6, y: 6, color: '#', dir: 'N' }],
  },
  break3: {
    title: 'break文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'break3',
    authoringSeed: 'source-expansion-v1:break3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(4, 5);
        for (int i = 0; i < 4; i++) {
            for (;;) {
                t.前に進む();
                if (!t.前に進めるか()) break;
            }
            t.右を向く();
        }
    }
}`,
    finalBoard: `#######
......#
......#
......#
......#
....#.#
....###`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'N' }],
  },
  break4: {
    title: 'break文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'break4',
    authoringSeed: 'source-expansion-v1:break4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(3, 4);
        for (int i = 0; i < 3; i++) {
            while (true) {
                if (!t.前に進めるか()) break;
                t.前に進む();
            }
            t.左を向く();
        }
    }
}`,
    finalBoard: `#......
#......
#......
#......
#..#...
#..#...
####...`,
    finalTurtles: [{ x: 0, y: 0, color: '#', dir: 'E' }],
  },
  break5: {
    title: 'break文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'break5',
    authoringSeed: 'source-expansion-v1:break5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(5, 5);
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 6; j++) {
                if (!t.前に進めるか()) break;
                t.前に進む();
                if (j % 3 == 0) {
                    t.左を向く();
                } else {
                    t.右を向く();
                }
            }
            t.右を向く();
        }
    }
}`,
    finalBoard: `.......
.......
.......
.......
.......
.....#.
....###`,
    finalTurtles: [{ x: 6, y: 6, color: '#', dir: 'E' }],
  },
  continue1: {
    title: 'continue文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'continue1',
    authoringSeed: 'source-expansion-v1:continue1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 4; i++) {
            if (i == 0) {
                continue;
            }
            t.前に進む();
        }
    }
}`,
    finalBoard: `#......
#......
#......
#......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 3, color: '#', dir: 'N' }],
  },
  continue2: {
    title: 'continue文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'continue2',
    authoringSeed: 'source-expansion-v1:continue2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 5; i++) {
            if (i % 2 == 1) {
                t.右を向く();
                continue;
            }
            t.前に進む();
        }
    }
}`,
    finalBoard: `##.....
##.....
.......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 0, color: '#', dir: 'S' }],
  },
  continue3: {
    title: 'continue文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'continue3',
    authoringSeed: 'source-expansion-v1:continue3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 2; i++) {
            for (int j = i * 4; j < 8; j++) {
                if (j % 4 == 1) {
                    t.右を向く(); continue;
                } else if (j % 4 == 3) {
                    t.左を向く(); continue;
                }
                t.前に進む();
            }
            t.左を向く();
        }
    }
}`,
    finalBoard: `#......
##.....
.##....
.#.....
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 3, color: '#', dir: 'S' }],
  },
  continue4: {
    title: 'continue文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'continue4',
    authoringSeed: 'source-expansion-v1:continue4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = i; j < 6; j++) {
                if (j % 2 == 0) {
                    t.右を向く(); continue;
                }
                if (t.前に進めるか()) {
                    t.前に進む();
                }
            }
            t.左を向く();
        }
    }
}`,
    finalBoard: `##.....
#......
##.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  continue5: {
    title: 'continue文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 5,
    sourceProblemId: 'continue5',
    authoringSeed: 'source-expansion-v1:continue5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = i + 1; j < 6; j++) {
                if (j % 4 == 0) {
                    t.左を向く(); continue;
                } else if (j % 3 == 2) {
                    t.右を向く(); continue;
                }
                if (t.前に進めるか()) {
                    t.前に進む();
                }
            }
        }
    }
}`,
    finalBoard: `##.....
##.....
.......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 0, color: '#', dir: 'S' }],
  },
  method1: {
    title: 'メソッドを使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'method1',
    authoringSeed: 'source-expansion-v1:method1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        二歩前に進める(t);
        t.右を向く();
        三歩前に進める(t);
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static void 三歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
        t.前に進む();
    }
}`,
    finalBoard: `#......
#......
####...
.......
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 2, color: '#', dir: 'E' }],
  },
  method2: {
    title: 'メソッドを使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'method2',
    authoringSeed: 'source-expansion-v1:method2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        二歩前に進める(t);
        後ろを向く(t);
        t.前に進む();
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static void 後ろを向く(Turtle t) {
        t.右を向く();
        t.右を向く();
    }
}`,
    finalBoard: `#......
#......
#......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 0, y: 1, color: '#', dir: 'S' }],
  },
  method3: {
    title: 'メソッドを使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'method3',
    authoringSeed: 'source-expansion-v1:method3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        N歩前に進める(t, 3);
        t.右を向く();
        N歩前に進める(t, 2);
    }

    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}`,
    finalBoard: `#......
#......
#......
###....
.......
.......
.......`,
    finalTurtles: [{ x: 2, y: 3, color: '#', dir: 'E' }],
  },
  method4: {
    title: 'メソッドを使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'method4',
    authoringSeed: 'source-expansion-v1:method4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        二歩前に進める(t);
        t.右を向く();
        四歩前に進める(t);
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static void 四歩前に進める(Turtle t) {
        二歩前に進める(t);
        二歩前に進める(t);
    }
}`,
    finalBoard: `#......
#......
#####..
.......
.......
.......
.......`,
    finalTurtles: [{ x: 4, y: 2, color: '#', dir: 'E' }],
  },
  method5: {
    title: 'メソッドを使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'method5',
    authoringSeed: 'source-expansion-v1:method5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        正方形を描く(t);
        t.後に戻る();
        t.後に戻る();
        正方形を描く(t);
    }
    static void 正方形を描く(Turtle t) {
        for (int i = 0; i < 3; i++) {
            t.前に進む();
            t.右を向く();
        }
    }
}`,
    finalBoard: `####...
####...
.......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 1, color: '#', dir: 'S' }],
  },
  return1: {
    title: 'return文を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'return1',
    authoringSeed: 'source-expansion-v1:return1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int x = 二倍する(2);
        N歩前に進める(t, x);
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
    static int 二倍する(int a) {
        return a * 2;
    }
}`,
    finalBoard: `#......
#......
#......
#......
#......
.......
.......`,
    finalTurtles: [{ x: 0, y: 4, color: '#', dir: 'N' }],
  },
  return2: {
    title: 'return文を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'return2',
    authoringSeed: 'source-expansion-v1:return2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int x = 二倍する(2);
        N歩前に進める(t, x);
        t.右を向く();
        x = 二倍する(x - 1);
        N歩前に進める(t, x);
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
    static int 二倍する(int a) {
        return a * 2;
    }
}`,
    finalBoard: `#......
#......
#......
#......
#######
.......
.......`,
    finalTurtles: [{ x: 6, y: 4, color: '#', dir: 'E' }],
  },
  return3: {
    title: 'return文を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'return3',
    authoringSeed: 'source-expansion-v1:return3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        N歩前に進める(t, 加算する(1, 1));
        N歩前に進める(t, 加算する(1, 2));
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
    static int 加算する(int a, int b) {
        return a + b;
    }
}`,
    finalBoard: `#......
#......
#......
#......
#......
#......
.......`,
    finalTurtles: [{ x: 0, y: 5, color: '#', dir: 'N' }],
  },
  return4: {
    title: 'return文を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'return4',
    authoringSeed: 'source-expansion-v1:return4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            if (偶数か(i)) {
                t.右を向く();
                二歩前に進める(t);
            } else {
                二歩前に進める(t);
                t.右を向く();
                t.右を向く();
            }
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static boolean 偶数か(int a) {
        return a % 2 == 0;
    }
}`,
    finalBoard: `#####..
....#..
....#..
.......
.......
.......
.......`,
    finalTurtles: [{ x: 4, y: 2, color: '#', dir: 'N' }],
  },
  return5: {
    title: 'return文を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 6,
    sourceProblemId: 'return5',
    authoringSeed: 'source-expansion-v1:return5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                if (等しいか(i, j))
                    t.右を向く();
                else
                    二歩前に進める(t);
            }
            t.左を向く();
        }
    }
    static void 二歩前に進める(Turtle t) {
        t.前に進む();
        t.前に進む();
    }
    static boolean 等しいか(int a, int b) {
        return a == b;
    }
}`,
    finalBoard: `#####..
....#..
....###
......#
......#
......#
......#`,
    finalTurtles: [{ x: 6, y: 6, color: '#', dir: 'N' }],
  },
  array1: {
    title: '配列を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'array1',
    authoringSeed: 'source-expansion-v1:array1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 2, 1, 1 };
        for (int i = 0; i < arr.length; i++) {
            N歩前に進める(t, arr[i]);
            t.右を向く();
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}`,
    finalBoard: `#......
##.....
##.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 1, color: '#', dir: 'W' }],
  },
  array2: {
    title: '配列を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'array2',
    authoringSeed: 'source-expansion-v1:array2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 4, 3, 3 };
        for (int i = 0; i < arr.length; i++) {
            N歩前に進める(t, arr[i]);
            t.右を向く();
        }
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}`,
    finalBoard: `#......
#..#...
#..#...
#..#...
####...
.......
.......`,
    finalTurtles: [{ x: 3, y: 1, color: '#', dir: 'W' }],
  },
  array3: {
    title: '配列を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'array3',
    authoringSeed: 'source-expansion-v1:array3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 0, 1, 0, 2, 0 };
        for (int i = 0; i < arr.length; i++) {
            switch (arr[i]) {
                case 0:
                    t.前に進む(); break;
                case 1:
                    t.右を向く(); break;
                case 2:
                    t.左を向く(); break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  array4: {
    title: '配列を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'array4',
    authoringSeed: 'source-expansion-v1:array4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 0, 1, 0, 2, 0 };
        for (int cmd : arr) {
            switch (cmd) {
                case 0:
                    t.前に進む(); break;
                case 1:
                    t.右を向く(); break;
                case 2:
                    t.左を向く(); break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  array5: {
    title: '配列を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'array5',
    authoringSeed: 'source-expansion-v1:array5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        int[] arr = { 0, 1, 0, 2, 0, 3, 0 };
        int steps = 1;
        for (int cmd : arr) {
            switch (cmd) {
                case 0:
                    for (int i = 0; i < steps; i++) {
                        t.前に進む();
                    }
                    break;
                case 1:
                    t.右を向く(); break;
                case 2:
                    t.左を向く(); break;
                case 3:
                    steps++; break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.#.....
.#.....
.......
.......`,
    finalTurtles: [{ x: 1, y: 4, color: '#', dir: 'N' }],
  },
  string1: {
    title: '文字列を使おう(1)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'string1',
    authoringSeed: 'source-expansion-v1:string1',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String s = "frflf";
        for (int i = 0; i < s.length(); i++) {
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break;
                case 'r':
                    t.右を向く(); break;
                case 'l':
                    t.左を向く(); break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  string2: {
    title: '文字列を使おう(2)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'string2',
    authoringSeed: 'source-expansion-v1:string2',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String s = "ffbrfl";
        for (int i = 0; i < s.length(); i++) {
            switch (s.charAt(i)) {
                case 'f':
                    t.前に進む(); break;
                case 'r':
                    t.右を向く(); break;
                case 'l':
                    t.左を向く(); break;
                case 'b':
                    t.後に戻る(); break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
#......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 1, color: '#', dir: 'N' }],
  },
  string3: {
    title: '文字列を使おう(3)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'string3',
    authoringSeed: 'source-expansion-v1:string3',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String s = "frflf";
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case 'f':
                    t.前に進む(); break;
                case 'r':
                    t.右を向く(); break;
                case 'l':
                    t.左を向く(); break;
            }
        }
    }
}`,
    finalBoard: `#......
##.....
.#.....
.......
.......
.......
.......`,
    finalTurtles: [{ x: 1, y: 2, color: '#', dir: 'N' }],
  },
  string4: {
    title: '文字列を使おう(4)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'string4',
    authoringSeed: 'source-expansion-v1:string4',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String[] cmds = { "ri", "aa", "fo" };
        for (String cmd : cmds) {
            t.前に進む();
            parse(t, cmd);
        }
    }
    static void parse(Turtle t, String c) {
        if (c.equals("fo"))
            t.前に進む();
        else if (c.equals("ri"))
            t.右を向く();
    }
}`,
    finalBoard: `#......
####...
.......
.......
.......
.......
.......`,
    finalTurtles: [{ x: 3, y: 1, color: '#', dir: 'E' }],
  },
  string5: {
    title: '文字列を使おう(5)',
    courseId: 'tuBeginner1',
    lectureIndex: 7,
    sourceProblemId: 'string5',
    authoringSeed: 'source-expansion-v1:string5',
    correctProgram: `public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle();
        String[] cmds = { "ri", "add", "fo", "add", "le", "fo", "fo" };
        int x = 0;
        for (String cmd : cmds) {
            parse(t, cmd, x);
            if (cmd.equals("add")) {
                x++;
            }
        }
    }
    static void parse(Turtle t, String c, int x) {
        if (c.equals("fo"))
            N歩前に進める(t, x);
        else if (c.equals("ri"))
            t.右を向く();
        else if (c.equals("le"))
            t.左を向く();
    }
    static void N歩前に進める(Turtle t, int n) {
        for (int i = 0; i < n; i++) {
            t.前に進む();
        }
    }
}`,
    finalBoard: `##.....
.#.....
.#.....
.#.....
.#.....
.......
.......`,
    finalTurtles: [{ x: 1, y: 4, color: '#', dir: 'N' }],
  },
} satisfies Record<string, SourceJavaModel>;
