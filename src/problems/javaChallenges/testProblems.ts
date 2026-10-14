import type { JavaChallengeDefinition } from './types';

const turnProgram = `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(3, 3);
        亀.前に進む();
        亀.右を向く();
        亀.前に進む();
    }
}`;
const forProgram = `public class Main {
    public static void main(String[] args) {
        Turtle 亀 = new Turtle(2, 1);
        for (int i = 0; i < 3; i++) {
            亀.前に進む();
        }
    }
}`;

export const testProblems: Record<string, JavaChallengeDefinition> = {
  testTurnBug: {
    title: 'バグ修正：亀の向き',
    courseId: 'test',
    lectureIndex: 0,
    problemFormat: 'bugFix',
    bugKind: 'logical',
    correctProgram: turnProgram,
    starterProgram: turnProgram.replace('亀.右を向く();', '亀.左を向く();'),
    finalBoard: '.......\n.......\n.......\n...#...\n...##..\n.......\n.......',
    finalTurtles: [{ x: 4, y: 4, color: '#', dir: 'E' }],
  },
  testForConditionBug: {
    title: 'バグ修正：for文の条件',
    courseId: 'test',
    lectureIndex: 0,
    problemFormat: 'bugFix',
    bugKind: 'syntax',
    correctProgram: forProgram,
    starterProgram: forProgram.replace('i < 3', 'i + 3'),
    finalBoard: '.......\n..#....\n..#....\n..#....\n..#....\n.......\n.......',
    finalTurtles: [{ x: 2, y: 4, color: '#', dir: 'N' }],
  },
};
