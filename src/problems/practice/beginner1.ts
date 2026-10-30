import type { PracticeDefinition } from './types';

export const beginner1PracticeDefinitions = [
  {
    id: 'practiceBeginner1L1A',
    lectureIndex: 0,
    title: '折れ道を戻る',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}
`,
      instrumented: `
const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.forward();
t.backward();
t.turnLeft();
t.forward();
`,
    },
  },
  {
    id: 'practiceBeginner1L1B',
    lectureIndex: 0,
    title: '向きを変えて戻る',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
    }
}
`,
      instrumented: `
const t = new Turtle(); registerDisplayRef('t', () => t); // step
t.forward();
t.turnRight();
t.turnRight();
t.backward();
t.turnLeft();
t.forward();
t.turnLeft();
`,
    },
  },
  {
    id: 'practiceBeginner1L2A',
    lectureIndex: 1,
    title: '座標と移動の記録',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        int north = 1; // step
        int east = north + 1; // step
        Turtle t = new Turtle(east, north); // step
        t.前に進む(); // step
        north = north + 1; // step
        t.右を向く(); // step
        t.前に進む(); // step
        east = east + 1; // step
        t.後に戻る(); // step
        east = east - 1; // step
    }
}
`,
      instrumented: `
s.set('north', 1);
s.set('east', s.get('north') + 1);
const t = new Turtle(s.get('east'), s.get('north')); registerDisplayRef('t', () => t); // step
t.forward();
s.set('north', s.get('north') + 1);
t.turnRight();
t.forward();
s.set('east', s.get('east') + 1);
t.backward();
s.set('east', s.get('east') - 1);
`,
    },
  },
  {
    id: 'practiceBeginner1L2B',
    lectureIndex: 1,
    title: '二つの値の交換',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        int x = 1; // step
        int y = 3; // step
        int saved = x; // step
        x = y; // step
        y = saved; // step
        y += x - 1; // step
        Turtle t = new Turtle(x, y); // step
        t.右を向く(); // step
        t.後に戻る(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        x = y - saved; // step
    }
}
`,
      instrumented: `
s.set('x', 1);
s.set('y', 3);
s.set('saved', s.get('x'));
s.set('x', s.get('y'));
s.set('y', s.get('saved'));
s.set('y', s.get('y') + s.get('x') - 1);
const t = new Turtle(s.get('x'), s.get('y')); registerDisplayRef('t', () => t); // step
t.turnRight();
t.backward();
t.turnLeft();
t.forward();
s.set('x', s.get('y') - s.get('saved'));
`,
    },
  },
  {
    id: 'practiceBeginner1L3A',
    lectureIndex: 2,
    title: '残りの回数を減らす',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int remaining = 6; // step
        int used = 1; // step
        while (remaining > used) {
            t.前に進む(); // step
            remaining = remaining - used; // step
            used++; // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('remaining', 6);
s.set('used', 1);
while (s.get('remaining') > s.get('used')) {
  t.forward();
  s.set('remaining', s.get('remaining') - s.get('used'));
  s.set('used', s.get('used') + 1);
}
t.turnRight();
t.forward();
`,
    },
  },
  {
    id: 'practiceBeginner1L3B',
    lectureIndex: 2,
    title: '増える間隔と合計',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int stride = 1; // step
        int total = 0; // step
        for (int count = 0; count < 3; count += stride) { // step
            total += count + stride; // step
            t.前に進む(); // step
            stride++; // step
        }
        t.右を向く(); // step
        for (int rest = total - stride; rest > 0; rest--) { // step
            t.前に進む(); // step
        }
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('stride', 1);
s.set('total', 0);
for (s.set('count', 0); s.get('count') < 3; s.set('count', s.get('count') + s.get('stride'))) {
  s.set('total', s.get('total') + s.get('count') + s.get('stride'));
  t.forward();
  s.set('stride', s.get('stride') + 1);
}
delete s.vars['count'];
t.turnRight();
for (s.set('rest', s.get('total') - s.get('stride')); s.get('rest') > 0; s.set('rest', s.get('rest') - 1)) {
  t.forward();
}
delete s.vars['rest'];
`,
    },
  },
  {
    id: 'practiceBeginner1L4A',
    lectureIndex: 3,
    title: '行ごとに折り返す',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        for (int row = 1; row <= 2; row++) { // step
            for (int column = 0; column < row; column++) { // step
                t.前に進む(); // step
                if (column == 0) {
                    t.右を向く(); // step
                }
            }
            t.左を向く(); // step
            t.後に戻る(); // step
        }
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
for (s.set('row', 1); s.get('row') <= 2; s.set('row', s.get('row') + 1)) {
  for (s.set('column', 0); s.get('column') < s.get('row'); s.set('column', s.get('column') + 1)) {
    t.forward();
    if (s.get('column') === 0) {
      t.turnRight();
    }
  }
  delete s.vars['column'];
  t.turnLeft();
  t.backward();
}
delete s.vars['row'];
`,
    },
  },
  {
    id: 'practiceBeginner1L4B',
    lectureIndex: 3,
    title: '前の値で向きを選ぶ',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int pending = 0; // step
        for (int round = 0; round < 3; round++) { // step
            if (pending > 1) {
                t.右を向く(); // step
                pending = 0; // step
            }
            t.前に進む(); // step
            pending += round + 1; // step
        }
        if (pending == 3) {
            t.後に戻る(); // step
        }
    }
}
`,
      instrumented: `
const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('pending', 0);
for (s.set('round', 0); s.get('round') < 3; s.set('round', s.get('round') + 1)) {
  if (s.get('pending') > 1) {
    t.turnRight();
    s.set('pending', 0);
  }
  t.forward();
  s.set('pending', s.get('pending') + s.get('round') + 1);
}
delete s.vars['round'];
if (s.get('pending') === 3) {
  t.backward();
}
`,
    },
  },
  {
    id: 'practiceBeginner1L5A',
    lectureIndex: 4,
    title: '残量で進路を選ぶ',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int reserve = 5; // step
        while (reserve > 0) {
            if (reserve > 3) {
                t.前に進む(); // step
                reserve -= 2; // step
            } else if (reserve == 3) {
                t.右を向く(); // step
                reserve--; // step
            } else {
                t.後に戻る(); // step
                reserve--; // step
            }
        }
    }
}
`,
      instrumented: `
const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('reserve', 5);
while (s.get('reserve') > 0) {
  if (s.get('reserve') > 3) {
    t.forward();
    s.set('reserve', s.get('reserve') - 2);
  } else if (s.get('reserve') === 3) {
    t.turnRight();
    s.set('reserve', s.get('reserve') - 1);
  } else {
    t.backward();
    s.set('reserve', s.get('reserve') - 1);
  }
}
`,
    },
  },
  {
    id: 'practiceBeginner1L5B',
    lectureIndex: 4,
    title: '次の状態を選ぶ',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 2); // step
        int state = 2; // step
        for (int round = 0; round < 3; round++) { // step
            switch (state) {
                case 2:
                    t.右を向く(); // step
                    state = 0; // step
                    break;
                case 0:
                    t.前に進む(); // step
                    state = 1; // step
                    break;
                default:
                    t.左を向く(); // step
                    state = 2; // step
                    break;
            }
            t.前に進む(); // step
        }
    }
}
`,
      instrumented: `
const t = new Turtle(2, 2); registerDisplayRef('t', () => t); // step
s.set('state', 2);
for (s.set('round', 0); s.get('round') < 3; s.set('round', s.get('round') + 1)) {
  switch (s.get('state')) {
    case 2:
      t.turnRight();
      s.set('state', 0);
      break;
    case 0:
      t.forward();
      s.set('state', 1);
      break;
    default:
      t.turnLeft();
      s.set('state', 2);
      break;
  }
  t.forward();
}
delete s.vars['round'];
`,
    },
  },
  {
    id: 'practiceBeginner1L6A',
    lectureIndex: 5,
    title: '合計が目印に届くまで',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int marker = 0; // step
        for (int step = 1; step <= 5; step++) { // step
            marker += step; // step
            if (marker >= 5) {
                break;
            }
            t.前に進む(); // step
            t.右を向く(); // step
        }
        t.後に戻る(); // step
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('marker', 0);
for (s.set('step', 1); s.get('step') <= 5; s.set('step', s.get('step') + 1)) {
  s.set('marker', s.get('marker') + s.get('step'));
  if (s.get('marker') >= 5) {
    break;
  }
  t.forward();
  t.turnRight();
}
delete s.vars['step'];
t.backward();
`,
    },
  },
  {
    id: 'practiceBeginner1L6B',
    lectureIndex: 5,
    title: '休みの回を飛ばす',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int cooldown = 0; // step
        int moved = 0; // step
        for (int round = 0; round < 5; round++) { // step
            if (cooldown > 0) {
                cooldown--; // step
                continue;
            }
            t.前に進む(); // step
            moved++; // step
            cooldown = moved; // step
        }
        t.右を向く(); // step
        t.前に進む(); // step
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('cooldown', 0);
s.set('moved', 0);
for (s.set('round', 0); s.get('round') < 5; s.set('round', s.get('round') + 1)) {
  if (s.get('cooldown') > 0) {
    s.set('cooldown', s.get('cooldown') - 1);
    continue;
  }
  t.forward();
  s.set('moved', s.get('moved') + 1);
  s.set('cooldown', s.get('moved'));
}
delete s.vars['round'];
t.turnRight();
t.forward();
`,
    },
  },
  {
    id: 'practiceBeginner1L7A',
    lectureIndex: 6,
    title: '二つの長さを渡す',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int width = 2; // step
        dogleg(t, width, width - 1); // caller
        width--; // step
        dogleg(t, width, width + 1); // caller
    }
    static void dogleg(Turtle t, int rise, int run) {
        for (int i = 0; i < rise; i++) { // step
            t.前に進む(); // step
        }
        t.右を向く(); // step
        for (int i = 0; i < run; i++) { // step
            t.前に進む(); // step
        }
        t.左を向く(); // step
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('width', 2);
call(dogleg, 't', 'rise', 'run')(t, s.get('width'), s.get('width') - 1);
s.set('width', s.get('width') - 1);
call(dogleg, 't', 'rise', 'run')(t, s.get('width'), s.get('width') + 1);

function dogleg(t, rise, run) {
  for (s.set('i', 0); s.get('i') < rise; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
  t.turnRight();
  for (s.set('i', 0); s.get('i') < run; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
  t.turnLeft();
}
`,
    },
  },
  {
    id: 'practiceBeginner1L7B',
    lectureIndex: 6,
    title: '戻り値で次の長さを決める',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int next = shorten(t, 3); // step // caller
        next = shorten(t, next); // step // caller
        t.前に進む(); // step
    }
    static int shorten(Turtle t, int length) {
        for (int i = 1; i < length; i++) { // step
            t.前に進む(); // step
        }
        t.右を向く(); // step
        return length - 1;
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('next', call(shorten, 't', 'length')(t, 3));
s.set('next', call(shorten, 't', 'length')(t, s.get('next')));
t.forward();

function shorten(t, length) {
  for (s.set('i', 1); s.get('i') < length; s.set('i', s.get('i') + 1)) {
    t.forward();
  }
  delete s.vars['i'];
  t.turnRight();
  return length - 1;
}
`,
    },
  },
  {
    id: 'practiceBeginner1L8A',
    lectureIndex: 7,
    title: '後ろから配列を更新する',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(1, 1); // step
        int[] distances = {1, 2, 1}; // step
        for (int index = distances.length - 1; index > 0; index--) { // step
            distances[index - 1] += distances[index]; // step
            for (int step = 0; step < distances[index]; step++) { // step
                t.前に進む(); // step
            }
            t.右を向く(); // step
        }
    }
}
`,
      instrumented: `
const t = new Turtle(1, 1); registerDisplayRef('t', () => t); // step
s.set('distances', [1, 2, 1]);
for (s.set('index', s.get('distances').length - 1); s.get('index') > 0; s.set('index', s.get('index') - 1)) {
  s.get('distances')[s.get('index') - 1] += s.get('distances')[s.get('index')]; // step
  for (s.set('step', 0); s.get('step') < s.get('distances')[s.get('index')]; s.set('step', s.get('step') + 1)) {
    t.forward();
  }
  delete s.vars['step'];
  t.turnRight();
}
delete s.vars['index'];
`,
    },
  },
  {
    id: 'practiceBeginner1L8B',
    lectureIndex: 7,
    title: '文字列をつなぎ直す',
    program: {
      java: `
public class Main {
    public static void main(String[] args) {
        Turtle t = new Turtle(2, 1); // step
        String word = "ab"; // step
        word = word + word.charAt(0); // step
        int limit = word.length(); // step
        for (int index = limit - 1; index >= 0; index--) { // step
            if (word.charAt(index) == word.charAt(0)) {
                t.前に進む(); // step
            } else {
                t.右を向く(); // step
            }
        }
        word = word + "b"; // step
    }
}
`,
      instrumented: `
const t = new Turtle(2, 1); registerDisplayRef('t', () => t); // step
s.set('word', 'ab');
s.set('word', s.get('word') + s.get('word').charAt(0));
s.set('limit', s.get('word').length);
for (s.set('index', s.get('limit') - 1); s.get('index') >= 0; s.set('index', s.get('index') - 1)) {
  if (s.get('word').charAt(s.get('index')) === s.get('word').charAt(0)) {
    t.forward();
  } else {
    t.turnRight();
  }
}
delete s.vars['index'];
s.set('word', s.get('word') + 'b');
`,
    },
  },
] satisfies PracticeDefinition[];
