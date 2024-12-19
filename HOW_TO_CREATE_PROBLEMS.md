## 新問題の作問手順

1. `problemIds` に問題IDを追加する。例: `test9`
2. `problemIdToName` に追加した問題IDの問題名を追加する。例: `test9: 'テスト問題(9)'`
3. `courseIdToLectureIndexToProblemIds` に問題IDを追加する。例: `test9`
4. `problemIdToLanguageIdToProgram` に空のコードを追加する。`.trim()`は不要。例:

```js
test9: {
  instrumented: ``,
  java: ``,
}
```

5. `java`側を埋める。既にインポート済みの問題を参考にして、オリジナルの類題を作る。例:

```js
test9: {
  instrumented: ``,
  java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle();
    Settings.speed = 2;
    t1.moveForward();

    MyTurtle t2 = new MyTurtle2(2, 2);
    Settings.increaseSpeed();
    t1.moveForward();
    t2.moveForward();
  }
}

class Settings {
  static public int speed;

  public increaseSpeed() {
    speed++;
  }
}

class MyTurtle {
  private Turtle t = new Turtle();

  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) {
      t.前に進む();
    }
  }
}

class MyTurtle2 {
  private Turtle t;

  MyTurtle2(int x, int y) {
    t = new Turtle(x, y);
  }
  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) {
      t.前に進む();
    }
  }
}
`,
}
```

6. `java`側でステップ実行で止めたい箇所に `// step` を付け、さらに、関数呼び出しの中に入りたい場合（ステップインしたい場合）は、 `// caller` を付ける。例:

```js
test9: {
  instrumented: ``,
  java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller
    Settings.speed = 2; // step
    t1.moveForward(); // caller

    MyTurtle t2 = new MyTurtle2(2, 2); // caller
    Settings.increaseSpeed(); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}

class Settings {
  static public int speed;

  public increaseSpeed() {
    speed++; // step
  }
}

class MyTurtle {
  private Turtle t = new Turtle(); // step

  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // step
      t.前に進む(); // step
    }
  }
}

class MyTurtle2 {
  private Turtle t;

  MyTurtle2(int x, int y) {
    t = new Turtle(x, y); // step
  }
  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // step
      t.前に進む(); // step
    }
  }
}
`,
}
```

- 注意1: `// step` と `// caller` の両方を付けられない！
- 注意2: `for` 文にも `// step` を付けること！

7. Cursorで `test9` の定義全体を選択して、Ctrl/Command + K を押して、以下のようなプロンプトを入力する。

```
以下のルールに従って、`java` のコードに基づいて `instrumented` を生成してください。

1. 静的フィールド（つまり、グローバル変数）を扱う場合、 `myGlobal.<クラス名> = { <静的フィールド名>: <初期値> };` を先頭に置くこと。例: `myGlobal.Settings = { speed: 0 };`
2. `Main`クラスだけが存在する場合は、`main()`メソッドの中身をトップレベルに展開して、`main()`関数を定義しないこと。`Main`以外のクラス宣言が含まれている場合、先頭で `main` 関数を定義して、末尾で `main()` を呼び出すこと。
3. 静的メソッドは普通の関数で代替すること。
4. コード中で定義しているコンストラクタの呼び出しに `// caller` が付いていて、かつ、`// step`がついていない場合、 `call(<クラス名>, '仮引数の名前1', '仮引数の名前2', ...)(実引数1, 実引数2, ...)` に書き換えること。例: `const t2 = call(MyTurtle2, 'x', 'y')(2, 2);`
5. コード中で定義している関数の呼び出しに `// caller` が付いていて、かつ、`// step`がついていない場合、 `call(<関数名>, '仮引数の名前1', '仮引数の名前2', ...)(実引数1, 実引数2, ...)` に書き換えること。例: `call(increaseSpeed)()`
6. コード中で定義しているメソッドの呼び出しに `// caller` が付いていて、かつ、`// step`がついていない場合、 `call(<オブジェクト名>.<関数名>.bind(<オブジェクト名>), '仮引数の名前1', '仮引数の名前2', ...)(実引数1, 実引数2, ...)` に書き換えること。例: `call(t1.moveForward.bind(t1, 'speed'))(3)`
7. `// step` のコメントを増やしたり減らしたりせずに、そのままの形で `// step` のコメントを残すこと。
8. すべての `// caller` のコメントを削除すること。
9. `Turtle` 以外の値（数値・文字列・配列など）をローカル変数に代入する場合は `s.set(<変数名>, <右辺値>)` を、参照する場合は `s.get(<変数名>)` を使うこと。 例: `i++` -> `s.set('i', s.get('i') + 1)`
10. ただし、フィールド変数では `s.set` や `s.get` を使わずに、 `this.[変数名]` を使うこと。例: `this.t.前に進む();`
11. ただし、 `call()` で呼び出されない関数内のローカル変数では `s.set` や `s.get` を使わずに、 `let` や `const` を使うこと。
```

8. Cursorの生成結果を手直しして完成させる。例:

```js
test9: {
  instrumented: `
myGlobal.Settings = { speed: 0 }; // <- ルール1

function main() { // <- ルール3
  const t1 = call(MyTurtle)(); // <- ルール4
  myGlobal.Settings.speed = 2; // step
  call(t1.moveForward.bind(t1))(); // <- ルール6

  const t2 = call(MyTurtle2, 'x', 'y')(2, 2); // <- ルール4
  call(increaseSpeed)(); // <- ルール2 & 5
  call(t1.moveForward.bind(t1))(); // <- ルール6
  call(t2.moveForward.bind(t2))(); // <- ルール6
}

function increaseSpeed() {
  myGlobal.Settings.speed++; // step
}

class MyTurtle {
  constructor() {
    this.t = new Turtle(); // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step // <- ルール7
      this.t.前に進む(); // step
    }
  }
}

class MyTurtle2 {
  constructor(x, y) {
    this.t = new Turtle(x, y); // step
  }
  moveForward() {
    for (s.set('i', 0); s.get('i') < myGlobal.Settings.speed; s.set('i', s.get('i') + 1)) { // step // <- ルール7
      this.t.前に進む(); // step
    }
  }
}

main();
   `,
   java: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller
    Settings.speed = 2; // step
    t1.moveForward(); // caller

    MyTurtle t2 = new MyTurtle2(2, 2); // caller
    Settings.increaseSpeed(); // caller
    t1.moveForward(); // caller
    t2.moveForward(); // caller
  }
}

class Settings {
  static public int speed;

  public increaseSpeed() {
    speed++; // step
  }
}

class MyTurtle {
  private Turtle t = new Turtle(); // step

  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // step
      t.前に進む(); // step
    }
  }
}

class MyTurtle2 {
  private Turtle t;

  MyTurtle2(int x, int y) {
    t = new Turtle(x, y); // step
  }
  void moveForward(Turtle t) {
    for (int i = 0; i < Settings.speed; i++) { // step
      t.前に進む(); // step
    }
  }
}
`,
}
```

9. `instrumented`と`java`の`// step`の個数が一致することを確認する。
10. 以下の手順で動作確認する。
    1. `yarn start` でWebサーバーを起動すると、ブラウザが勝手に立ち上がる。
    2. 右上の新規登録でTUのメアドでアカウントを作る。アカウントを作ると、 迷惑メール にメールが届くので、そこでアカウント認証を完了させる。
    3. READMEにある各回のURLを開くと、問題一覧ページが表示されるので、確認したい問題を開く。
    4. 右上の `次のステップに進む（管理者のみ）` ボタンを押して、ステップ実行される単位と、各ステップの内容を確認する。
    5. 手順4で問題がないことを確認できたら、実際にステップ実行モードで問題全体を解いてみる。
