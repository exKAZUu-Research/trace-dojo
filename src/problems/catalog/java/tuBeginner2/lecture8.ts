import type { CorrectProblem } from '../types';

export const lecture8: CorrectProblem[] = [
  {
    id: 'challengeII8SelectedRowSum',
    title: '選んだ行の合計',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][] grid = {{1, 2}, {2, 2}};\n        int sum = 0;\n        for (int j = 0; j < grid[1].length; j++) {\n            sum += grid[1][j];\n        }\n        Turtle t = new Turtle(sum, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeII8ColumnSum',
    title: '列をたどる合計',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][] grid = {{1, 2}, {3, 1}};\n        int sum = 0;\n        for (int i = 0; i < grid.length; i++) {\n            sum += grid[i][1];\n        }\n        Turtle t = new Turtle(sum, 2);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeII8DiagonalComparison',
    title: '対角の値を比べる',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][] grid = {{1, 2}, {3, 4}};\n        int x = grid[0][1];\n        int y = grid[1][0];\n        Turtle t = new Turtle(x, y);\n        if (grid[0][0] < grid[1][1]) {\n            t.右を向く();\n        } else {\n            t.左を向く();\n        }\n        t.前に進む();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeII8RaggedRows',
    title: '長さの違う行',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][] rows = {{2}, {1, 2}};\n        int total = 0;\n        for (int i = 0; i < rows.length; i++) {\n            for (int j = 0; j < rows[i].length; j++) {\n                total += rows[i][j];\n            }\n        }\n        Turtle t = new Turtle(total, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeII8MatrixDependency',
    title: '書き換えたセルを使う',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][] grid = {{1, 2}, {3, 1}};\n        grid[1][0] = grid[0][1] + 2;\n        int x = grid[1][0];\n        int y = grid[0][0] + 1;\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n        t.右を向く();\n    }\n}',
  },
  {
    id: 'challengeII8AliasedRow',
    title: '行を指す別名',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][] grid = {{1, 2}, {3, 1}};\n        int[] row = grid[0];\n        row[0] = row[1] + 1;\n        int x = grid[0][0];\n        int y = grid[1][1];\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.前に進む();\n    }\n}',
  },
  {
    id: 'challengeII8LayerSelection',
    title: '三次元配列の層を選ぶ',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][][] layers = {{{1, 2}}, {{3, 1}}};\n        int layer = 0;\n        layer++;\n        int x = layers[layer][0][0];\n        int y = layers[layer][0][1];\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n    }\n}',
  },
  {
    id: 'challengeII8CrossLayerSum',
    title: '層をまたいで足す',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][][] layers = {{{1, 2}}, {{2, 1}}};\n        int x = layers[0][0][0] + layers[1][0][0];\n        int y = layers[0][0][1] - layers[1][0][1];\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.右を向く();\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeII8ReplaceNestedRow',
    title: '層の中の行を交換',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][][] layers = {{{1, 2}}, {{3, 1}}};\n        int[] saved = layers[0][0];\n        layers[0][0] = layers[1][0];\n        int x = layers[0][0][0];\n        int y = saved[1];\n        Turtle t = new Turtle(x, y);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n        t.後に戻る();\n    }\n}',
  },
  {
    id: 'challengeII8RaggedVolume',
    title: '三次元の長さをたどる',
    courseId: 'tuBeginner2',
    lectureIndex: 7,
    java: 'public class Main {\n    public static void main(String[] args) {\n        int[][][] layers = {{{1}, {1}}, {{1}}};\n        int total = 0;\n        for (int i = 0; i < layers.length; i++) {\n            for (int j = 0; j < layers[i].length; j++) {\n                for (int k = 0; k < layers[i][j].length; k++) {\n                    total += layers[i][j][k];\n                }\n            }\n        }\n        Turtle t = new Turtle(total, 1);\n        t.前に進む();\n        t.左を向く();\n        t.前に進む();\n    }\n}',
  },
];
