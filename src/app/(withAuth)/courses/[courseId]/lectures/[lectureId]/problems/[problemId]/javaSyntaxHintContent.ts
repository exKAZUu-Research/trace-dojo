export interface JavaSyntaxHintContent {
  meaning: string;
  syntax: string;
  example: string;
  explanation: string;
}

const hints: Record<string, JavaSyntaxHintContent> = {
  '=': {
    meaning: '右側の値を左側の変数などに入れます。',
    syntax: '変数 = 値;',
    example: 'int 個数 = 3;',
    explanation: '個数に 3 が入ります。等しいかを比べる == とは別です。',
  },
  '+=': {
    meaning: '右側の値を足した結果を左側に入れます。',
    syntax: '変数 += 値;',
    example: `int 個数 = 3;
個数 += 2;`,
    explanation: '個数は 5 になります。文字列では文字をつなげます。',
  },
  '-=': {
    meaning: '右側の値を引いた結果を左側に入れます。',
    syntax: '変数 -= 値;',
    example: `int 個数 = 3;
個数 -= 2;`,
    explanation: '個数は 1 になります。',
  },
  '*=': {
    meaning: '右側の値で掛けた結果を左側に入れます。',
    syntax: '変数 *= 値;',
    example: `int 個数 = 3;
個数 *= 2;`,
    explanation: '個数は 6 になります。',
  },
  '/=': {
    meaning: '右側の値で割った結果を左側に入れます。',
    syntax: '変数 /= 値;',
    example: `int 個数 = 7;
個数 /= 2;`,
    explanation: '個数は 3 になります。整数同士では小数部分を除きます。',
  },
  '%=': {
    meaning: '右側の値で割った余りを左側に入れます。',
    syntax: '変数 %= 値;',
    example: `int 個数 = 7;
個数 %= 3;`,
    explanation: '個数は 1 になります。',
  },
  '+': {
    meaning: '数を足すときなどに使います。',
    syntax: '数 + 数',
    example: '2 + 3',
    explanation: '結果は 5 です。文字列同士なら文字をつなげます。',
  },
  '-': {
    meaning: '数を引いたり、数の符号を反転したりします。',
    syntax: '数 - 数',
    example: '5 - 2',
    explanation: '結果は 3 です。-5 のように負の数も表せます。',
  },
  '*': {
    meaning: '数を掛けます。',
    syntax: '数 * 数',
    example: '3 * 2',
    explanation: '結果は 6 です。',
  },
  '/': {
    meaning: '数を割ります。',
    syntax: '数 / 数',
    example: '7 / 2',
    explanation: '結果は 3 です。整数同士では小数部分を除きます（-7 / 2 は -3）。',
  },
  '%': {
    meaning: '割り算の余りを求めます。',
    syntax: '数 % 数',
    example: '7 % 3',
    explanation: '余りは 1 です。左側が負の数なら、余りも負か 0 になります。',
  },
  '++': {
    meaning: '変数などの値を 1 増やします。',
    syntax: '変数++;',
    example: `int 個数 = 3;
個数++;`,
    explanation: '個数は 4 になります。式の中では、後ろに付けると変更前、前に付けると変更後の値を使います。',
  },
  '--': {
    meaning: '変数などの値を 1 減らします。',
    syntax: '変数--;',
    example: `int 個数 = 3;
個数--;`,
    explanation: '個数は 2 になります。式の中では、後ろに付けると変更前、前に付けると変更後の値を使います。',
  },
  '==': {
    meaning: '左右の値が等しいかを調べます。',
    syntax: '値 == 値',
    example: '3 == 3',
    explanation:
      'この比較の結果は true です。オブジェクトでは同じものを指すかを比べます。文字列の内容は通常 equals で比べます。',
  },
  '!=': {
    meaning: '左右の値が等しくないかを調べます。',
    syntax: '値 != 値',
    example: '3 != 2',
    explanation:
      'この比較の結果は true です。オブジェクトでは同じものを指すかを比べます。文字列の内容は通常 equals で比べます。',
  },
  '<': {
    meaning: '左側が右側より小さいかを調べます。',
    syntax: '値 < 値',
    example: '2 < 3',
    explanation: 'この比較の結果は true です。成り立たないときは false です。',
  },
  '<=': {
    meaning: '左側が右側以下であるかを調べます。',
    syntax: '値 <= 値',
    example: '3 <= 3',
    explanation: 'この比較の結果は true です。成り立たないときは false です。',
  },
  '>': {
    meaning: '左側が右側より大きいかを調べます。',
    syntax: '値 > 値',
    example: '3 > 2',
    explanation: 'この比較の結果は true です。成り立たないときは false です。',
  },
  '>=': {
    meaning: '左側が右側以上であるかを調べます。',
    syntax: '値 >= 値',
    example: '3 >= 3',
    explanation: 'この比較の結果は true です。成り立たないときは false です。',
  },
  '&&': {
    meaning: '両方の条件が成り立つかを調べます。',
    syntax: '条件 && 条件',
    example: '3 > 0 && 3 < 5',
    explanation: '結果は true です。左側が false なら右側は調べません。',
  },
  '||': {
    meaning: 'どちらかの条件が成り立つかを調べます。',
    syntax: '条件 || 条件',
    example: '3 < 0 || 3 < 5',
    explanation: '結果は true です。左側が true なら右側は調べません。',
  },
  '!': {
    meaning: '条件の true と false を逆にします。',
    syntax: '!条件',
    example: '!true',
    explanation: '結果は false です。',
  },
  '&': {
    meaning: '整数を 2 進数で見て、両方が 1 の桁を 1 にします。',
    syntax: '整数 & 整数',
    example: '6 & 3',
    explanation: '結果は 2 です。真偽値では両方が true かを調べます。&& と違い両側を調べます。',
  },
  '|': {
    meaning: '整数を 2 進数で見て、片方以上が 1 の桁を 1 にします。',
    syntax: '整数 | 整数',
    example: '6 | 3',
    explanation: '結果は 7 です。真偽値では片方以上が true かを調べます。|| と違い両側を調べます。',
  },
  '^': {
    meaning: '整数を 2 進数で見て、片方だけが 1 の桁を 1 にします。',
    syntax: '整数 ^ 整数',
    example: '6 ^ 3',
    explanation: '結果は 5 です。真偽値では片方だけが true かを調べます。',
  },
  '~': {
    meaning: '整数を 2 進数で見て、各桁の 0 と 1 を逆にします。',
    syntax: '~整数',
    example: '~0',
    explanation: '結果は -1 です。符号を表す桁も逆になります。',
  },
  '<<': {
    meaning: '整数の 2 進数の桁を左にずらし、空いた右側を 0 で埋めます。',
    syntax: '整数 << ずらす桁数',
    example: '3 << 1',
    explanation: '1 桁ずらした結果は 6 です。',
  },
  '>>': {
    meaning: '整数の 2 進数の桁を右にずらし、空いた左側を符号の桁で埋めます。',
    syntax: '整数 >> ずらす桁数',
    example: '-4 >> 1',
    explanation: '1 桁ずらした結果は -2 です。',
  },
  '>>>': {
    meaning: '整数の 2 進数の桁を右にずらし、空いた左側を 0 で埋めます。',
    syntax: '整数 >>> ずらす桁数',
    example: '-1 >>> 1',
    explanation: '1 桁ずらした結果は 2147483647 です。',
  },
  '&=': {
    meaning: '& で計算した結果を左側に入れます。',
    syntax: '変数 &= 値;',
    example: `int 数 = 6;
数 &= 3;`,
    explanation: '数は 2 になります。真偽値にも使えます。',
  },
  '|=': {
    meaning: '| で計算した結果を左側に入れます。',
    syntax: '変数 |= 値;',
    example: `int 数 = 6;
数 |= 3;`,
    explanation: '数は 7 になります。真偽値にも使えます。',
  },
  '^=': {
    meaning: '^ で計算した結果を左側に入れます。',
    syntax: '変数 ^= 値;',
    example: `int 数 = 6;
数 ^= 3;`,
    explanation: '数は 5 になります。真偽値にも使えます。',
  },
  '<<=': {
    meaning: '<< で桁をずらした結果を左側に入れます。',
    syntax: '変数 <<= ずらす桁数;',
    example: `int 数 = 3;
数 <<= 1;`,
    explanation: '1 桁ずらして、数は 6 になります。',
  },
  '>>=': {
    meaning: '>> で桁をずらした結果を左側に入れます。',
    syntax: '変数 >>= ずらす桁数;',
    example: `int 数 = -4;
数 >>= 1;`,
    explanation: '1 桁ずらして、数は -2 になります。',
  },
  '>>>=': {
    meaning: '>>> で桁をずらした結果を左側に入れます。',
    syntax: '変数 >>>= ずらす桁数;',
    example: `int 数 = -1;
数 >>>= 1;`,
    explanation: '1 桁ずらして、数は 2147483647 になります。',
  },
  int: {
    meaning: '整数を入れる変数を作るときなどに使います。',
    syntax: 'int 名前 = 値;',
    example: 'int 個数 = 3;',
    explanation: '整数を入れる変数「個数」を作り、3 を入れます。',
  },
  byte: {
    meaning: '-128 から 127 までの整数を入れる変数を作るときなどに使います。',
    syntax: 'byte 名前 = 値;',
    example: 'byte 値 = 3;',
    explanation: '変数「値」に 3 を入れます。',
  },
  short: {
    meaning: '-32768 から 32767 までの整数を入れる変数を作るときなどに使います。',
    syntax: 'short 名前 = 値;',
    example: 'short 値 = 3;',
    explanation: '変数「値」に 3 を入れます。',
  },
  long: {
    meaning: 'int より広い範囲の整数を入れる変数を作るときなどに使います。',
    syntax: 'long 名前 = 値;',
    example: 'long 値 = 3000000000L;',
    explanation: '変数「値」に 3000000000L を入れます。末尾の L は long の数を表します。',
  },
  float: {
    meaning: '小数を含む数を入れる変数を作るときなどに使います。',
    syntax: 'float 名前 = 値;',
    example: 'float 値 = 1.5f;',
    explanation: '変数「値」に 1.5f を入れます。末尾の f は float の数を表します。小数は近似して扱います。',
  },
  double: {
    meaning: 'float より高い精度の小数を含む数を入れる変数を作るときなどに使います。',
    syntax: 'double 名前 = 値;',
    example: 'double 値 = 1.5;',
    explanation: '変数「値」に 1.5 を入れます。小数は近似して扱います。',
  },
  boolean: {
    meaning: 'true または falseを入れる変数を作るときなどに使います。',
    syntax: 'boolean 名前 = 値;',
    example: 'boolean 値 = true;',
    explanation: '変数「値」に true を入れます。',
  },
  char: {
    meaning: '文字を表す値を入れる変数を作るときなどに使います。',
    syntax: 'char 名前 = 値;',
    example: "char 値 = 'A';",
    explanation:
      "変数「値」に 'A' を入れます。文字は単一引用符で囲みます。絵文字など、char が 2 つ必要な文字もあります。",
  },
  var: {
    meaning: '変数を作るとき、入れる値から型を決めます。',
    syntax: 'var 名前 = 初期値;',
    example: 'var 個数 = 3;',
    explanation: 'メソッド内などで使います。個数の型は int になり、後から別の型には変わりません。',
  },
  void: {
    meaning: 'メソッドが値を返さないことを表します。',
    syntax: `void メソッド名() {
  処理
}`,
    example: `void 挨拶() {
  System.out.println("こんにちは");
}`,
    explanation: 'クラスの中で宣言します。呼び出すと「こんにちは」と表示し、値は返しません。',
  },
  final: {
    meaning: '変数では、一度入れた値を入れ直せなくします。',
    syntax: 'final 型 名前 = 値;',
    example: 'final int 上限 = 3;',
    explanation: '上限に別の値は代入できません。オブジェクトの中身まで固定する指定ではありません。',
  },
  if: {
    meaning: '条件が成り立つときに処理を実行します。',
    syntax: `if (条件) {
  処理
}`,
    example: `int 点数 = 80;
if (点数 >= 80) {
  System.out.println("合格");
}`,
    explanation: '点数が 80 以上なので「合格」と表示します。',
  },
  else: {
    meaning: 'if の条件が成り立たないときの処理を書きます。',
    syntax: `if (条件) {
  処理
} else {
  別の処理
}`,
    example: `if (3 < 2) {
  System.out.println("はい");
} else {
  System.out.println("いいえ");
}`,
    explanation: '条件が成り立たないので「いいえ」と表示します。',
  },
  for: {
    meaning: '回数などの条件を決めて処理を繰り返します。',
    syntax: `for (最初の準備; 条件; 毎回の更新) {
  処理
}`,
    example: `for (int i = 0; i < 3; i++) {
  System.out.println("こんにちは");
}`,
    explanation: 'i が 0、1、2 の間に実行し、「こんにちは」と 3 回表示します。',
  },
  while: {
    meaning: '条件が成り立つ間、処理を繰り返します。',
    syntax: `while (条件) {
  処理
}`,
    example: `int 個数 = 2;
while (個数 > 0) {
  個数--;
}`,
    explanation: '個数を 2 回減らし、0 になると繰り返しを終えます。',
  },
  do: {
    meaning: '処理を一度行い、その後で繰り返すかを調べます。',
    syntax: `do {
  処理
} while (条件);`,
    example: `int 個数 = 0;
do {
  個数++;
} while (個数 < 2);`,
    explanation: '個数が 2 になるまで繰り返します。条件にかかわらず最初の 1 回は実行します。',
  },
  switch: {
    meaning: '値に合わせて実行する処理を選びます。',
    syntax: `switch (値) {
  case 定数: 処理; break;
}`,
    example: `switch (2) {
  case 2:
    System.out.println("二");
    break;
}`,
    explanation: '値が 2 なので「二」と表示し、break で switch を抜けます。',
  },
  case: {
    meaning: 'switch で、どの値のときに処理するかを示します。',
    syntax: `case 定数:
  処理
  break;`,
    example: `switch (2) {
  case 2:
    System.out.println("二");
    break;
}`,
    explanation: '値が case の 2 と一致するので「二」と表示します。',
  },
  default: {
    meaning: 'switch では、ほかの case に当てはまらないときの処理を示します。',
    syntax: `default:
  処理`,
    example: `switch (2) {
  default:
    System.out.println("その他");
}`,
    explanation: '当てはまる case がないので「その他」と表示します。',
  },
  break: {
    meaning: '繰り返しや switch を途中で抜けます。',
    syntax: 'break;',
    example: `while (true) {
  System.out.println("一度だけ");
  break;
}`,
    explanation: '「一度だけ」と表示して繰り返しを終えます。',
  },
  continue: {
    meaning: '繰り返しの今回の残りを飛ばして次の回へ進みます。',
    syntax: 'continue;',
    example: `for (int i = 0; i < 3; i++) {
  if (i == 1) continue;
  System.out.println(i);
}`,
    explanation: '1 の回は表示を飛ばし、0 と 2 を表示します。for の更新は行います。',
  },
  return: {
    meaning: 'メソッドの処理を終えて、呼び出した場所に戻ります。',
    syntax: `return 値;
return;`,
    example: `int 個数() {
  return 3;
}`,
    explanation: 'クラスの中で宣言します。呼び出すと 3 を返します。void のメソッドでは return; と書きます。',
  },
  class: {
    meaning: 'データや処理をまとめるクラスを作るときなどに使います。',
    syntax: `class 名前 {
  データや処理
}`,
    example: `class 箱 {
  int 大きさ = 3;
}`,
    explanation: '「大きさ」というデータを持つクラス「箱」を作ります。',
  },
  new: {
    meaning: 'オブジェクトや配列を新しく作ります。',
    syntax: `new クラス名(引数)
new 型[長さ]`,
    example: 'int[] 数列 = new int[3];',
    explanation: '整数を 3 つ入れられる配列を作ります。最初はすべて 0 です。',
  },
  this: {
    meaning: '今のオブジェクト自身を指すときなどに使います。',
    syntax: 'this.変数名',
    example: `class 箱 {
  int 大きさ;
  箱(int 大きさ) {
    this.大きさ = 大きさ;
  }
}`,
    explanation: '受け取った値を、この箱の「大きさ」に入れます。',
  },
  public: {
    meaning: 'ほかのクラスからも使えるようにする指定です。',
    syntax: 'public 型 名前 = 値;',
    example: `class 箱 {
  public int 大きさ = 3;
}`,
    explanation: 'クラス自体も利用できる場所なら、大きさを外から使えます。',
  },
  private: {
    meaning: '宣言したクラスの内部だけで使うための指定です。',
    syntax: 'private 型 名前 = 値;',
    example: `class 箱 {
  private int 大きさ = 3;
}`,
    explanation: '大きさは、このクラスの内部で使うデータになります。',
  },
  protected: {
    meaning: '同じパッケージや継承先から使えるようにする指定です。',
    syntax: 'protected 型 名前 = 値;',
    example: `class 箱 {
  protected int 大きさ = 3;
}`,
    explanation: '大きさを同じパッケージや継承先で使えます。別パッケージの継承先では使い方に制限があります。',
  },
  static: {
    meaning: 'オブジェクトごとではなく、クラスに属するものを表します。',
    syntax: 'static 型 名前 = 値;',
    example: `class 箱 {
  static int 個数 = 3;
}`,
    explanation: '個数は箱ごとに作られず、箱.個数 で使える共通のデータになります。',
  },
};

export const getJavaSyntaxHint = (text: string, classes: readonly string[]): JavaSyntaxHintContent | undefined => {
  if (classes.includes('import') && text === '*') return undefined;
  if (classes.includes('generics') && (classes.includes('operator') || ['<', '>', '?'].includes(text))) {
    return undefined;
  }
  if (!classes.some((name) => ['keyword', 'operator'].includes(name))) {
    return undefined;
  }
  return Object.hasOwn(hints, text) ? hints[text] : undefined;
};
