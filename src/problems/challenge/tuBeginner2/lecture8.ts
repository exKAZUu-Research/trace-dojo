import type { ChallengeBase } from '../types';

export const lecture8: ChallengeBase[] = [
  {
    id: 'challengeII8SelectedRowSum',
    title: '選んだ行の合計',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] grid = {{1, 2}, {2, 2}};
        int sum = 0;
        for (int j = 0; j < grid[1].length; j++) {
            sum += grid[1][j];
        }
        Turtle t = new Turtle(sum, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {2, 2}};`,
        after: `        int[][] grid = {{1, 2}, {@[2]@, 2}};`,
      },
      {
        id: 'Value2',
        before: `        int sum = 0;`,
        after: `        int sum = @[0]@;`,
      },
      {
        id: 'Value3',
        before: `        for (int j = 0; j < grid[1].length; j++) {`,
        after: `        for (int j = @[0]@; j < grid[1].length; j++) {`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {2, 2}};`,
        after: `        int[][] grid = {{1, 2}, {3, 2}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int sum = 0;`,
        after: `        int sum = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int j = 0; j < grid[1].length; j++) {`,
        after: `        for (int j = 1; j < grid[1].length; j++) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8ColumnSum',
    title: '列をたどる合計',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] grid = {{1, 2}, {3, 1}};
        int sum = 0;
        for (int i = 0; i < grid.length; i++) {
            sum += grid[i][1];
        }
        Turtle t = new Turtle(sum, 2);
        t.前に進む();
        t.右を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < grid.length; i++) {`,
        after: `        for (int i = 0; i @[<]@ grid.length; i++) {`,
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}};`,
        after: `        int[][] grid = {{1, @[2]@}, {3, 1}};`,
      },
      {
        id: 'Value2',
        before: `        int sum = 0;`,
        after: `        int sum = @[0]@;`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < grid.length; i++) {`,
        after: `        for (int i = 0; i > grid.length; i++) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}};`,
        after: `        int[][] grid = {{1, 3}, {3, 1}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int sum = 0;`,
        after: `        int sum = 1;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8DiagonalComparison',
    title: '対角の値を比べる',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] grid = {{1, 2}, {3, 4}};
        int x = grid[0][1];
        int y = grid[1][0];
        Turtle t = new Turtle(x, y);
        if (grid[0][0] < grid[1][1]) {
            t.右を向く();
        } else {
            t.左を向く();
        }
        t.前に進む();
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Condition5',
        before: `        if (grid[0][0] < grid[1][1]) {`,
        after: `        if (grid[0][0] @[<]@ grid[1][1]) {`,
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 4}};`,
        after: `        int[][] grid = {{1, @[2]@}, {3, 4}};`,
      },
      {
        id: 'Value2',
        before: `        int x = grid[0][1];`,
        after: `        int x = grid[@[0]@][1];`,
      },
    ],
    bugs: [
      {
        id: 'Condition5',
        before: `        if (grid[0][0] < grid[1][1]) {`,
        after: `        if (grid[0][0] > grid[1][1]) {`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 4}};`,
        after: `        int[][] grid = {{1, 3}, {3, 4}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = grid[0][1];`,
        after: `        int x = grid[1][1];`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8RaggedRows',
    title: '長さの違う行',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] rows = {{2}, {1, 2}};
        int total = 0;
        for (int i = 0; i < rows.length; i++) {
            for (int j = 0; j < rows[i].length; j++) {
                total += rows[i][j];
            }
        }
        Turtle t = new Turtle(total, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][] rows = {{2}, {1, 2}};`,
        after: `        int[][] rows = {{@[2]@}, {1, 2}};`,
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = @[0]@;`,
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < rows.length; i++) {`,
        after: `        for (int i = @[0]@; i < rows.length; i++) {`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][] rows = {{2}, {1, 2}};`,
        after: `        int[][] rows = {{3}, {1, 2}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < rows.length; i++) {`,
        after: `        for (int i = 1; i < rows.length; i++) {`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8MatrixDependency',
    title: '書き換えたセルを使う',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] grid = {{1, 2}, {3, 1}};
        grid[1][0] = grid[0][1] + 2;
        int x = grid[1][0];
        int y = grid[0][0] + 1;
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
        t.右を向く();
    }
}`,
    blanks: [
      {
        id: 'Update4',
        before: `        int y = grid[0][0] + 1;`,
        after: `        int y = grid[0][0] @[+]@ 1;`,
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}};`,
        after: `        int[][] grid = {{@[1]@, 2}, {3, 1}};`,
      },
      {
        id: 'Value2',
        before: `        grid[1][0] = grid[0][1] + 2;`,
        after: `        grid[@[1]@][0] = grid[0][1] + 2;`,
      },
    ],
    bugs: [
      {
        id: 'Update4',
        before: `        int y = grid[0][0] + 1;`,
        after: `        int y = grid[0][0] - 1;`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}};`,
        after: `        int[][] grid = {{2, 2}, {3, 1}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        grid[1][0] = grid[0][1] + 2;`,
        after: `        grid[0][0] = grid[0][1] + 2;`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8AliasedRow',
    title: '行を指す別名',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] grid = {{1, 2}, {3, 1}};
        int[] row = grid[0];
        row[0] = row[1] + 1;
        int x = grid[0][0];
        int y = grid[1][1];
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}};`,
        after: `        int[][] grid = {{1, @[2]@}, {3, 1}};`,
      },
      {
        id: 'Value3',
        before: `        row[0] = row[1] + 1;`,
        after: `        row[0] = row[@[1]@] + 1;`,
      },
      {
        id: 'Value4',
        before: `        int x = grid[0][0];`,
        after: `        int x = grid[0][@[0]@];`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}};`,
        after: `        int[][] grid = {{1, 3}, {3, 1}};`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        row[0] = row[1] + 1;`,
        after: `        row[0] = row[0] + 1;`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        int x = grid[0][0];`,
        after: `        int x = grid[0][1];`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8LayerSelection',
    title: '三次元配列の層を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][][] layers = {{{1, 2}}, {{3, 1}}};
        int layer = 0;
        layer++;
        int x = layers[layer][0][0];
        int y = layers[layer][0][1];
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}};`,
        after: `        int[][][] layers = {{{1, 2}}, {{@[3]@, 1}}};`,
      },
      {
        id: 'Value4',
        before: `        int x = layers[layer][0][0];`,
        after: `        int x = layers[layer][0][@[0]@];`,
      },
      {
        id: 'Value5',
        before: `        int y = layers[layer][0][1];`,
        after: `        int y = layers[layer][0][@[1]@];`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}};`,
        after: `        int[][][] layers = {{{1, 2}}, {{4, 1}}};`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        int x = layers[layer][0][0];`,
        after: `        int x = layers[layer][0][1];`,
        kind: 'logical',
      },
      {
        id: 'Value5',
        before: `        int y = layers[layer][0][1];`,
        after: `        int y = layers[layer][0][0];`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8CrossLayerSum',
    title: '層をまたいで足す',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][][] layers = {{{1, 2}}, {{2, 1}}};
        int x = layers[0][0][0] + layers[1][0][0];
        int y = layers[0][0][1] - layers[1][0][1];
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.右を向く();
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Update3',
        before: `        int y = layers[0][0][1] - layers[1][0][1];`,
        after: `        int y = layers[0][0][1] @[-]@ layers[1][0][1];`,
      },
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{2, 1}}};`,
        after: `        int[][][] layers = {{{@[1]@, 2}}, {{2, 1}}};`,
      },
      {
        id: 'Value2',
        before: `        int x = layers[0][0][0] + layers[1][0][0];`,
        after: `        int x = layers[@[0]@][0][0] + layers[1][0][0];`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        int y = layers[0][0][1] - layers[1][0][1];`,
        after: `        int y = layers[0][0][1] + layers[1][0][1];`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{2, 1}}};`,
        after: `        int[][][] layers = {{{2, 2}}, {{2, 1}}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = layers[0][0][0] + layers[1][0][0];`,
        after: `        int x = layers[1][0][0] + layers[1][0][0];`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8ReplaceNestedRow',
    title: '層の中の行を交換',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][][] layers = {{{1, 2}}, {{3, 1}}};
        int[] saved = layers[0][0];
        layers[0][0] = layers[1][0];
        int x = layers[0][0][0];
        int y = saved[1];
        Turtle t = new Turtle(x, y);
        t.前に進む();
        t.左を向く();
        t.前に進む();
        t.後に戻る();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}};`,
        after: `        int[][][] layers = {{{1, @[2]@}}, {{3, 1}}};`,
      },
      {
        id: 'Value2',
        before: `        int[] saved = layers[0][0];`,
        after: `        int[] saved = layers[@[0]@][0];`,
      },
      {
        id: 'Value3',
        before: `        layers[0][0] = layers[1][0];`,
        after: `        layers[@[0]@][0] = layers[1][0];`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}};`,
        after: `        int[][][] layers = {{{1, 3}}, {{3, 1}}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int[] saved = layers[0][0];`,
        after: `        int[] saved = layers[1][0];`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        layers[0][0] = layers[1][0];`,
        after: `        layers[1][0] = layers[1][0];`,
        kind: 'logical',
      },
    ],
  },
  {
    id: 'challengeII8RaggedVolume',
    title: '三次元の長さをたどる',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][][] layers = {{{1}, {1}}, {{1}}};
        int total = 0;
        for (int i = 0; i < layers.length; i++) {
            for (int j = 0; j < layers[i].length; j++) {
                for (int k = 0; k < layers[i][j].length; k++) {
                    total += layers[i][j][k];
                }
            }
        }
        Turtle t = new Turtle(total, 1);
        t.前に進む();
        t.左を向く();
        t.前に進む();
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1}, {1}}, {{1}}};`,
        after: `        int[][][] layers = {{{@[1]@}, {1}}, {{1}}};`,
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = @[0]@;`,
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < layers.length; i++) {`,
        after: `        for (int i = @[0]@; i < layers.length; i++) {`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1}, {1}}, {{1}}};`,
        after: `        int[][][] layers = {{{2}, {1}}, {{1}}};`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0;`,
        after: `        int total = 1;`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < layers.length; i++) {`,
        after: `        for (int i = 1; i < layers.length; i++) {`,
        kind: 'logical',
      },
    ],
  },
];
