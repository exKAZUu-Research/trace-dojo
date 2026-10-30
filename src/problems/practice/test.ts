import type { PracticeDefinition } from './types';

export const testPracticeDefinitions = [
  {
    id: 'practiceTestL1A',
    lectureIndex: 0,
    title: '値の更新と折り返し',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        int start = 2; // step
        Turtle t = new Turtle(start, start - 1); // step
        start += 2; // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        start -= 1; // step
        t.左を向く(); // step
    }
}
`,
      instrumented: `
s.set('start', 2);
const t = new Turtle(s.get('start'), s.get('start') - 1); registerDisplayRef('t', () => t); // step
s.set('start', s.get('start') + 2);
t.forward();
t.turnRight();
t.backward();
s.set('start', s.get('start') - 1);
t.turnLeft();
`,
    },
  },
  {
    id: 'practiceTestL1B',
    lectureIndex: 0,
    title: '参照を戻して動かす',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle first = new Turtle(1, 2); // step
        Turtle second = new Turtle(4, 1); // step
        Turtle cursor = second; // step
        cursor.右を向く(); // step
        cursor.後に戻る(); // step
        cursor = first; // step
        cursor.後に戻る(); // step
        second = cursor; // step
        second.左を向く(); // step
        first.後に戻る(); // step
    }
}
`,
      instrumented: `
const first = new Turtle(1, 2); registerDisplayRef('first', () => first); // step
let second = new Turtle(4, 1); registerDisplayRef('second', () => second); // step
let cursor = second; registerDisplayRef('cursor', () => cursor); // step
cursor.turnRight();
cursor.backward();
cursor = first; // step
cursor.backward();
second = cursor; // step
second.turnLeft();
first.backward();
`,
    },
  },
] satisfies PracticeDefinition[];
