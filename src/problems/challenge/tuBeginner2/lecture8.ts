import type { ChallengeBase } from '../types';

export const lecture8: ChallengeBase[] = [
  {
    id: 'challengeII8SelectedRowSum',
    title: '選んだ行の合計',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: `public class Main {
    public static void main(String[] args) {
        int[][] grid = {{1, 2}, {2, 2}}; // step
        int sum = 0; // step
        for (int j = 0; j < grid[1].length; j++) { // step
            sum += grid[1][j]; // step
        }
        Turtle t = new Turtle(sum, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {2, 2}}; // step`,
        after: `        int[][] grid = {{1, 2}, {@[2]@, 2}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int sum = 0; // step`,
        after: `        int sum = @[0]@; // step`,
      },
      {
        id: 'Value3',
        before: `        for (int j = 0; j < grid[1].length; j++) { // step`,
        after: `        for (int j = @[0]@; j < grid[1].length; j++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {2, 2}}; // step`,
        after: `        int[][] grid = {{1, 2}, {3, 2}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int sum = 0; // step`,
        after: `        int sum = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int j = 0; j < grid[1].length; j++) { // step`,
        after: `        for (int j = 1; j < grid[1].length; j++) { // step`,
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
        int[][] grid = {{1, 2}, {3, 1}}; // step
        int sum = 0; // step
        for (int i = 0; i < grid.length; i++) { // step
            sum += grid[i][1]; // step
        }
        Turtle t = new Turtle(sum, 2); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < grid.length; i++) { // step`,
        after: `        for (int i = 0; i @[<]@ grid.length; i++) { // step`,
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}}; // step`,
        after: `        int[][] grid = {{1, @[2]@}, {3, 1}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int sum = 0; // step`,
        after: `        int sum = @[0]@; // step`,
      },
    ],
    bugs: [
      {
        id: 'Condition3',
        before: `        for (int i = 0; i < grid.length; i++) { // step`,
        after: `        for (int i = 0; i > grid.length; i++) { // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}}; // step`,
        after: `        int[][] grid = {{1, 3}, {3, 1}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int sum = 0; // step`,
        after: `        int sum = 1; // step`,
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
        int[][] grid = {{1, 2}, {3, 4}}; // step
        int x = grid[0][1]; // step
        int y = grid[1][0]; // step
        Turtle t = new Turtle(x, y); // step
        if (grid[0][0] < grid[1][1]) {
            t.右を向く(); // step
        } else {
            t.左を向く(); // step
        }
        t.前に進む(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
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
        before: `        int[][] grid = {{1, 2}, {3, 4}}; // step`,
        after: `        int[][] grid = {{1, @[2]@}, {3, 4}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int x = grid[0][1]; // step`,
        after: `        int x = grid[@[0]@][1]; // step`,
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
        before: `        int[][] grid = {{1, 2}, {3, 4}}; // step`,
        after: `        int[][] grid = {{1, 3}, {3, 4}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = grid[0][1]; // step`,
        after: `        int x = grid[1][1]; // step`,
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
        int[][] rows = {{2}, {1, 2}}; // step
        int total = 0; // step
        for (int i = 0; i < rows.length; i++) { // step
            for (int j = 0; j < rows[i].length; j++) { // step
                total += rows[i][j]; // step
            }
        }
        Turtle t = new Turtle(total, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][] rows = {{2}, {1, 2}}; // step`,
        after: `        int[][] rows = {{@[2]@}, {1, 2}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = @[0]@; // step`,
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < rows.length; i++) { // step`,
        after: `        for (int i = @[0]@; i < rows.length; i++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][] rows = {{2}, {1, 2}}; // step`,
        after: `        int[][] rows = {{3}, {1, 2}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < rows.length; i++) { // step`,
        after: `        for (int i = 1; i < rows.length; i++) { // step`,
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
        int[][] grid = {{1, 2}, {3, 1}}; // step
        grid[1][0] = grid[0][1] + 2; // step
        int x = grid[1][0]; // step
        int y = grid[0][0] + 1; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
        t.右を向く(); // step
    }
}`,
    blanks: [
      {
        id: 'Update4',
        before: `        int y = grid[0][0] + 1; // step`,
        after: `        int y = grid[0][0] @[+]@ 1; // step`,
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}}; // step`,
        after: `        int[][] grid = {{@[1]@, 2}, {3, 1}}; // step`,
      },
      {
        id: 'Value2',
        before: `        grid[1][0] = grid[0][1] + 2; // step`,
        after: `        grid[@[1]@][0] = grid[0][1] + 2; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update4',
        before: `        int y = grid[0][0] + 1; // step`,
        after: `        int y = grid[0][0] - 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}}; // step`,
        after: `        int[][] grid = {{2, 2}, {3, 1}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        grid[1][0] = grid[0][1] + 2; // step`,
        after: `        grid[0][0] = grid[0][1] + 2; // step`,
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
        int[][] grid = {{1, 2}, {3, 1}}; // step
        int[] row = grid[0]; // step
        row[0] = row[1] + 1; // step
        int x = grid[0][0]; // step
        int y = grid[1][1]; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}}; // step`,
        after: `        int[][] grid = {{1, @[2]@}, {3, 1}}; // step`,
      },
      {
        id: 'Value3',
        before: `        row[0] = row[1] + 1; // step`,
        after: `        row[0] = row[@[1]@] + 1; // step`,
      },
      {
        id: 'Value4',
        before: `        int x = grid[0][0]; // step`,
        after: `        int x = grid[0][@[0]@]; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][] grid = {{1, 2}, {3, 1}}; // step`,
        after: `        int[][] grid = {{1, 3}, {3, 1}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        row[0] = row[1] + 1; // step`,
        after: `        row[0] = row[0] + 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        int x = grid[0][0]; // step`,
        after: `        int x = grid[0][1]; // step`,
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
        int[][][] layers = {{{1, 2}}, {{3, 1}}}; // step
        int layer = 0; // step
        layer++; // step
        int x = layers[layer][0][0]; // step
        int y = layers[layer][0][1]; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}}; // step`,
        after: `        int[][][] layers = {{{1, 2}}, {{@[3]@, 1}}}; // step`,
      },
      {
        id: 'Value4',
        before: `        int x = layers[layer][0][0]; // step`,
        after: `        int x = layers[layer][0][@[0]@]; // step`,
      },
      {
        id: 'Value5',
        before: `        int y = layers[layer][0][1]; // step`,
        after: `        int y = layers[layer][0][@[1]@]; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}}; // step`,
        after: `        int[][][] layers = {{{1, 2}}, {{4, 1}}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value4',
        before: `        int x = layers[layer][0][0]; // step`,
        after: `        int x = layers[layer][0][1]; // step`,
        kind: 'logical',
      },
      {
        id: 'Value5',
        before: `        int y = layers[layer][0][1]; // step`,
        after: `        int y = layers[layer][0][0]; // step`,
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
        int[][][] layers = {{{1, 2}}, {{2, 1}}}; // step
        int x = layers[0][0][0] + layers[1][0][0]; // step
        int y = layers[0][0][1] - layers[1][0][1]; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.右を向く(); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Update3',
        before: `        int y = layers[0][0][1] - layers[1][0][1]; // step`,
        after: `        int y = layers[0][0][1] @[-]@ layers[1][0][1]; // step`,
      },
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{2, 1}}}; // step`,
        after: `        int[][][] layers = {{{@[1]@, 2}}, {{2, 1}}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int x = layers[0][0][0] + layers[1][0][0]; // step`,
        after: `        int x = layers[@[0]@][0][0] + layers[1][0][0]; // step`,
      },
    ],
    bugs: [
      {
        id: 'Update3',
        before: `        int y = layers[0][0][1] - layers[1][0][1]; // step`,
        after: `        int y = layers[0][0][1] + layers[1][0][1]; // step`,
        kind: 'logical',
      },
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{2, 1}}}; // step`,
        after: `        int[][][] layers = {{{2, 2}}, {{2, 1}}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int x = layers[0][0][0] + layers[1][0][0]; // step`,
        after: `        int x = layers[1][0][0] + layers[1][0][0]; // step`,
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
        int[][][] layers = {{{1, 2}}, {{3, 1}}}; // step
        int[] saved = layers[0][0]; // step
        layers[0][0] = layers[1][0]; // step
        int x = layers[0][0][0]; // step
        int y = saved[1]; // step
        Turtle t = new Turtle(x, y); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
        t.後に戻る(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}}; // step`,
        after: `        int[][][] layers = {{{1, @[2]@}}, {{3, 1}}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int[] saved = layers[0][0]; // step`,
        after: `        int[] saved = layers[@[0]@][0]; // step`,
      },
      {
        id: 'Value3',
        before: `        layers[0][0] = layers[1][0]; // step`,
        after: `        layers[@[0]@][0] = layers[1][0]; // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1, 2}}, {{3, 1}}}; // step`,
        after: `        int[][][] layers = {{{1, 3}}, {{3, 1}}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int[] saved = layers[0][0]; // step`,
        after: `        int[] saved = layers[1][0]; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        layers[0][0] = layers[1][0]; // step`,
        after: `        layers[1][0] = layers[1][0]; // step`,
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
        int[][][] layers = {{{1}, {1}}, {{1}}}; // step
        int total = 0; // step
        for (int i = 0; i < layers.length; i++) { // step
            for (int j = 0; j < layers[i].length; j++) { // step
                for (int k = 0; k < layers[i][j].length; k++) { // step
                    total += layers[i][j][k]; // step
                }
            }
        }
        Turtle t = new Turtle(total, 1); // step
        t.前に進む(); // step
        t.左を向く(); // step
        t.前に進む(); // step
    }
}`,
    blanks: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1}, {1}}, {{1}}}; // step`,
        after: `        int[][][] layers = {{{@[1]@}, {1}}, {{1}}}; // step`,
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = @[0]@; // step`,
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < layers.length; i++) { // step`,
        after: `        for (int i = @[0]@; i < layers.length; i++) { // step`,
      },
    ],
    bugs: [
      {
        id: 'Value1',
        before: `        int[][][] layers = {{{1}, {1}}, {{1}}}; // step`,
        after: `        int[][][] layers = {{{2}, {1}}, {{1}}}; // step`,
        kind: 'logical',
      },
      {
        id: 'Value2',
        before: `        int total = 0; // step`,
        after: `        int total = 1; // step`,
        kind: 'logical',
      },
      {
        id: 'Value3',
        before: `        for (int i = 0; i < layers.length; i++) { // step`,
        after: `        for (int i = 1; i < layers.length; i++) { // step`,
        kind: 'logical',
      },
    ],
  },
];
