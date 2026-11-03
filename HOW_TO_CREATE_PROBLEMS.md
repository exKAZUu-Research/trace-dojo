## Challenge fill-in-the-blank problems

Define Java templates in `src/problems/fillInBlank/definitions.ts` or `challengeDefinitions.ts`, following [穴埋め問題の作問手順](#穴埋め問題の作問手順): the template carries `@[model answer]@` markers, and an ID and seed reproduce the complete generated problem.

Register the name in `legacyProblemIdToName` and add the ID explicitly to `courseIdToLectureIndexToProblemIds` for ordinary lectures. Challenge mode draws its problems from `courseIdToLectureIndexToExerciseProblemIds` for the fill-in-the-blank and bug-fix challenges; outside the curriculum courses (for example `test`), the regular challenge draws from the problems without blanks in the lecture's `courseIdToLectureIndexToProblemIds` entry.

Challenge sessions persist the problem ID and seed. Displays and grading regenerate from the current definition, so editing a definition also changes an active session when it is next loaded. Challenge submissions stay in `ExerciseSession` and `ExerciseSubmission` and do not affect ordinary progress or grades.

## Curriculum challenge bank

For `tuBeginner1` and `tuBeginner2`, every challenge format comes from the independent bank, so ordinary lecture problems are never offered as challenges. Each lecture file under `src/problems/challenge/tuBeginner*/lecture*.ts` lists base programs (`id`, `title`, `courseId`, `lectureIndex`, the `java` program, and three `blanks` and three `bugs` edits). Each edit replaces one exact `before` snippet of the Java program with `after`: a blank wraps the answer in `@[...]@`, and a bug introduces a `logical` or `syntax` defect. The three blanks, and likewise the three bugs, must edit distinct positions. A base yields one regular challenge plus one fill-in-the-blank and one bug-fix challenge per edit.

After editing the bank, run `bun run gen-code` to regenerate `src/problems/challenge/metadata.ts`; unit tests fail when it is stale.

## 新問題の作問手順

問題はJavaプログラムだけで定義する。ステップ実行のトレースは、`src/java/` のインタプリタがJavaプログラムを実際に実行して生成する。

1. `legacyProblemIdToName` に問題IDと問題名を追加する。例: `test9: 'テスト問題(9)'`
2. `courseIdToLectureIndexToProblemIds` に問題IDを追加する。
3. `problemIdToProgram` に問題のJavaプログラムを追加する。`.trim()`は不要。`<1-4>` と書いた箇所は、問題ごとに1以上4未満（1から3）の乱数に置き換わる。上限は含まれない。
4. ステップ実行で止めたい文の行末に `// step` を付ける。関数呼び出しの中に入りたい場合（ステップインしたい場合）は、呼び出しの行末に `// caller` を付ける。例:

```js
test9: `
public class Main {
  public static void main(String[] args) {
    MyTurtle t1 = new MyTurtle(); // caller
    Settings.speed = 2; // step
    t1.moveForward(); // caller
  }
}

class Settings {
  public static int speed;
}

class MyTurtle {
  private Turtle t = new Turtle(); // step

  void moveForward() {
    for (int i = 0; i < Settings.speed; i++) { // step
      this.t.前に進む(); // step
    }
  }
}
`,
```

トレースは次の規則で記録される。

- `// step` の行にある文（式文・変数宣言・`return` 文・フィールドの初期化）を実行し終えるたびに、その時点の状態を1ステップとして記録する。`if (...) x = 1; // step` のように複合文と同じ行にある場合は、中の文が対象になる。
- `for` 文の行に `// step` を付けると、初期化と、各回の更新の直後を記録する。拡張 `for` 文では、各回の変数への代入の直後を記録する。
- `while` 文や `if` 文など、それ以外の文だけがある行の `// step` はコンパイルエラーになる。ループの各回で止めたい場合は、ループの中の文に `// step` を付ける。
- `// step` の番号は出現順の連番になる。`// step: 5` と書くと番号を指定でき、続く `// step` はそこから数える。
- 変数表には、実行中のメソッドの有効範囲にある局所変数、`this` のフィールド、各クラスのstaticフィールド（定数を除く）が表示される。亀・オブジェクト・配列は参照として、中のフィールドや要素を展開して表示する。
- どの変数からも参照されなくなった亀は、ガベージコレクションで消えたものとして盤面から取り除かれる。

5. `bun wb test test/unit/problemData.test.ts` を実行し、プログラムがコンパイルでき、例外で止まらずに最後まで実行されることを確認する。Javaとして誤ったプログラムはコンパイルエラーになる。例外で終わることを教える問題は、テストの `problemsEndingWithException` に追加する。トレースの内容が意図どおりかは、手順6で確認する。
6. 以下の手順で動作確認する。
   1. `bun run start` でWebサーバーを起動すると、ブラウザが勝手に立ち上がる。
   2. 右上の新規登録でTUのメアドでアカウントを作る。アカウントを作ると、 迷惑メール にメールが届くので、そこでアカウント認証を完了させる。
   3. READMEにある各回のURLを開くと、問題一覧ページが表示されるので、確認したい問題を開く。
   4. 右上の `次のステップに進む（管理者のみ）` ボタンを押して、ステップ実行される単位と、各ステップの内容を確認する。
   5. 手順4で問題がないことを確認できたら、実際にステップ実行モードで問題全体を解いてみる。

## 穴埋め問題の作問手順

空欄にしたい箇所を `@[模範解答]@` で囲む。例:

```js
fillInBlank1: `
public class Main {
  public static void main(String[] args) {
    Turtle t = new Turtle(); // step
    for (int i = 0; @[i < 4]@; i++) { // step
      t.前に進む(); // step
    }
  }
}
`,
```

`@[...]@` が含まれる問題は自動的に穴埋め問題として扱われる。学習者には空欄を `【1】` などに置き換えたJavaプログラム全体が編集可能な状態で表示され、模範解答を埋めたプログラムを実行した後の盤面と亀を見せた上で、プログラムを書き換えて提出させる。

採点では、提出されたJavaプログラム全体をWandboxで実行し、Wandboxが利用できない場合は [judge](https://github.com/WillBooster/judge) で実行する。judgeは自身のマシン上でサンドボックス化してJavaプログラムをコンパイル・実行する。実行後の最終的な盤面と亀だけを模範解答の実行結果と比較し、変数の値は比較しない。

穴埋め問題も他の問題と同様に必ず亀を使うこと。最終的な盤面と亀の状態で採点するため、亀のいないプログラムは採点できない。
