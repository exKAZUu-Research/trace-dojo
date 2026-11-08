import type { CorrectProblem } from '../types';

export const lecture1: CorrectProblem[] = [
  {
    id: 'challengeI1ForkReturn',
    title: '枝から戻る道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.後に戻る();\n        t.後に戻る();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1BackwardEast',
    title: '後ろ向きの横道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.左を向く();\n        t.後に戻る();\n        t.後に戻る();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1OpenArch',
    title: 'アーチを横切る道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.後に戻る();\n        t.後に戻る();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeI1OffsetNotch',
    title: 'くぼみのある道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1CrossbarRetreat',
    title: '横棒と帰り道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.後に戻る();\n        t.後に戻る();\n        t.後に戻る();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1ReverseHook',
    title: '逆向きに出るフック',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.後に戻る();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1StairRollback',
    title: '階段を一歩戻る',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.後に戻る();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1BracketBranch',
    title: '折り返して分かれる道',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.後に戻る();\n        t.左を向く();\n        t.後に戻る();\n        t.右を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1OpposedArms',
    title: '反対向きの枝',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.前に進む();\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.後に戻る();\n        t.後に戻る();\n        t.右を向く();\n        t.右を向く();\n        t.後に戻る();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeI1BackwardCorner',
    title: '後ろ歩きの角',
    courseId: 'tuBeginner1',
    lectureIndex: 0,
    java: 'public class Main {\n    public static void main(String[] args) {\n        Turtle t = new Turtle();\n        t.右を向く();\n        t.前に進む();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n        t.左を向く();\n        t.後に戻る();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.後に戻る();\n    }\n}',
  },
];
