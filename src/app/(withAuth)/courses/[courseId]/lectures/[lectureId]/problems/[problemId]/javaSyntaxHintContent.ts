const hints: Record<string, string> = {
  '=': '代入です。右側の値を左側の変数や配列の要素などに保存します。等しいかを比べる == とは異なります。例: int count = 3;',
  '+=': '右側の値を足して左側に保存します。文字列の場合はつなげて保存します。結果は左側の型に変換されます。例: int count = 3; count += 2;',
  '-=': '右側の値を引いて左側に保存します。結果は左側の型に変換されます。例: int count = 3; count -= 2;',
  '*=': '右側の値を掛けて左側に保存します。結果は左側の型に変換されます。例: int count = 3; count *= 2;',
  '/=': '右側の値で割って左側に保存します。整数同士の割り算では小数部分を切り捨てます。結果は左側の型に変換されます。例: int count = -7; count /= 2; では count は -3。',
  '%=': '右側の値で割った余りを、左側に保存します。結果は左側の型に変換されます。例: int count = 7; count %= 3; では count は 1。',
  '+': '数値の足し算や正の符号に使います。文字列と組み合わせると文字列をつなげます。例: 2 + 3 は 5、"a" + 2 は "a2"。',
  '-': '引き算、または数値の符号を反転する演算です。例: 5 - 2 は 3、-5 は負の数。',
  '*': '数値の掛け算です。例: 3 * 2 は 6。',
  '/': '数値の割り算です。整数同士では小数部分を切り捨てます（負の結果も 0 に近づく方向）。小数を扱う型では小数部分も計算します。例: -7 / 2 は -3、7.0 / 2 は 3.5。',
  '%': '割り算の余りを求めます。0 でない余りの符号は左側の数と同じです。例: -7 % 3 は -1。',
  '++': '変数などの値を 1 増やします。式の中では、前に付けると更新後、後ろに付けると更新前の値を使います。例: int count = 3; int before = count++; では before は 3、count は 4。',
  '--': '変数などの値を 1 減らします。式の中では、前に付けると更新後、後ろに付けると更新前の値を使います。例: int count = 3; int after = --count; では after も count も 2。',
  '==': '等しいかを比べ、true または false を返します。オブジェクトでは同じ参照かを比べます。文字列の内容の比較には通常 equals を使います。例: 3 == 3 は true。',
  '!=': '等しくないかを比べ、true または false を返します。オブジェクトでは参照を比べます。例: 3 != 2 は true。',
  '<': '左側が右側より小さいかを比べ、true または false を返します。例: 2 < 3 は true。',
  '<=': '左側が右側以下かを比べ、true または false を返します。例: 3 <= 3 は true。',
  '>': '左側が右側より大きいかを比べ、true または false を返します。例: 3 > 2 は true。',
  '>=': '左側が右側以上かを比べ、true または false を返します。例: 3 >= 3 は true。',
  '&&': '両方の条件が true のとき true です。左側が false なら右側は評価しません。例: int n = 0; boolean ok = n != 0 && 6 / n > 1; では右側の割り算を行いません。',
  '||': '少なくとも一方の条件が true なら true です。左側が true なら右側は評価しません。例: int n = 0; boolean ok = n == 0 || 6 / n > 1; では右側の割り算を行いません。',
  '!': 'true と false を反転します。例: !true は false。',
  '&': '整数では各ビットの AND、真偽値では両方が true かを求めます。&& と違い両側を評価します。例: 6 & 3 は 2。',
  '|': '整数では各ビットの OR、真偽値では少なくとも一方が true かを求めます。|| と違い両側を評価します。例: 6 | 3 は 7。',
  '^': '整数では各ビットの XOR、真偽値では一方だけが true かを求めます。例: 6 ^ 3 は 5。',
  '~': '整数の各ビットを反転します。例: ~0 は -1。',
  '<<': '整数のビットを左にずらし、空いた下位ビットを 0 にします。例: 3 << 1 は 6。',
  '>>': '整数のビットを右にずらし、空いた上位ビットを符号のビットで埋めます。例: -4 >> 1 は -2。',
  '>>>': '整数のビットを右にずらし、空いた上位ビットを 0 にします。例: -1 >>> 1 は 2147483647。',
  '&=': 'AND 演算の結果を左側に保存します。整数ではビットごと、真偽値では両方が true かを求めます。結果は左側の型に変換されます。例: int bits = 6; bits &= 3; では bits は 2。',
  '|=': 'OR 演算の結果を左側に保存します。整数ではビットごと、真偽値では少なくとも一方が true かを求めます。結果は左側の型に変換されます。例: int bits = 6; bits |= 3; では bits は 7。',
  '^=': 'XOR 演算の結果を左側に保存します。整数ではビットごと、真偽値では一方だけが true かを求めます。結果は左側の型に変換されます。例: int bits = 6; bits ^= 3; では bits は 5。',
  '<<=':
    '整数のビットを左にずらし、その結果を左側に保存します。結果は左側の型に変換されます。例: int bits = 3; bits <<= 1; では bits は 6。',
  '>>=':
    '整数のビットを符号を保ちながら右にずらし、その結果を左側に保存します。結果は左側の型に変換されます。例: int bits = -4; bits >>= 1; では bits は -2。',
  '>>>=':
    '整数のビットを右にずらして上位を 0 で埋め、その結果を左側に保存します。結果は左側の型に変換されます。例: int bits = -1; bits >>>= 1; では bits は 2147483647。',
  int: '整数を扱う型です。変数・引数・戻り値・型変換などに使います。構文: int 名前 = 初期値; 例: int value = 3;',
  byte: '小さな範囲の整数を扱う型です。変数・引数・戻り値・型変換などに使います。構文: byte 名前 = 初期値; 例: byte value = 3;',
  short:
    'int より狭い範囲の整数を扱う型です。変数・引数・戻り値・型変換などに使います。構文: short 名前 = 初期値; 例: short value = 3;',
  long: 'int より広い範囲の整数を扱う型です。変数・引数・戻り値・型変換などに使います。構文: long 名前 = 初期値; 例: long value = 3L;',
  float:
    '小数を含む数値を近似して扱う型です。変数・引数・戻り値・型変換などに使います。構文: float 名前 = 初期値; 例: float value = 1.5f;',
  double:
    '小数を含む数値を float より高い精度で近似して扱う型です。変数・引数・戻り値・型変換などに使います。構文: double 名前 = 初期値; 例: double value = 1.5;',
  boolean:
    'true または false を扱う型です。変数・引数・戻り値・型変換などに使います。構文: boolean 名前 = 初期値; 例: boolean value = true;',
  char: "UTF-16 の 1 コード単位を扱う型です。変数・引数・戻り値・型変換などに使います。構文: char 名前 = 初期値; 例: char value = 'A'; 文字によっては char が 2 つ必要です。",
  var: 'ローカル変数の宣言で、初期値から型を決めます。後から別の型に変わるわけではありません。構文: var 名前 = 初期値; 例: var count = 3;',
  void: 'メソッドが値を返さないことを表します。構文: void メソッド名() { 処理 } 例: class Printer { void print() { System.out.println("hello"); } }',
  final:
    '変数では、一度代入した値を再代入できなくします。参照先の中身は変えられる場合があります。メソッドやクラスでは継承時の制限を表します。構文: final 型 名前 = 初期値; 例: final int limit = 3;',
  if: '条件が true のときに処理を実行します。構文: if (条件) { 処理 } 例: if (3 > 2) { System.out.println("yes"); }',
  else: '対応する if の条件が false のときに実行する処理です。構文: if (条件) { 処理 } else { 別の処理 } 例: if (3 < 2) { System.out.println("yes"); } else { System.out.println("no"); }',
  for: '繰り返しです。初期化・継続条件・更新を書く形式や、配列などの要素を順番に取り出す形式があります。構文: for (初期化; 条件; 更新) { 処理 } または for (型 名前 : 配列など) { 処理 } 例: for (int i = 0; i < 3; i++) { System.out.println(i); }',
  while:
    '条件が true の間、処理を繰り返します。do と組み合わせる場合は処理の後に条件を確認します。構文: while (条件) { 処理 } 例: int n = 2; while (n > 0) { n--; }',
  do: 'まず処理を実行し、その後の while の条件が true なら繰り返します。最低 1 回は実行します。構文: do { 処理 } while (条件); 例: int n = 2; do { n--; } while (n > 0);',
  switch:
    '値に応じて case などの処理を選びます。値を返す式として使う形式もあります。構文: switch (値) { case 定数: 処理; break; default: 処理; } 例: switch (2) { case 2: System.out.println("two"); break; default: break; }',
  case: 'switch で選ぶ値やパターンを指定します。構文: switch (値) { case 定数: 処理; break; } 例: switch (2) { case 2: System.out.println("two"); break; }',
  default:
    'switch では、ほかの case に当てはまらない場合を表します。インターフェースでは実装を持つメソッドにも使います。構文: switch (値) { default: 処理; } 例: switch (2) { default: System.out.println("other"); }',
  break:
    '繰り返しや switch を抜けます。ラベルを付けると、指定した文を抜けます。構文: break; または break ラベル; 例: while (true) { break; }',
  continue:
    '繰り返しの今回の残りを飛ばし、次の回へ進みます。for の更新や条件の確認は行います。構文: continue; または continue ラベル; 例: for (int i = 0; i < 3; i++) { if (i == 1) { continue; } System.out.println(i); }',
  return:
    'メソッドの処理を終え、呼び出した場所に戻ります。戻り値がある場合は値も返します。構文: return 値; または return; 例: class Counter { int count() { return 3; } }',
  class:
    'クラスの宣言に使い、データや処理をまとめる型を定義します。型名.class（例: String.class）という形では、その型を表す Class オブジェクトを取得します。構文: class 名前 { メンバー } または 型名.class 例: class Box { int size = 3; } または String.class',
  new: 'オブジェクトや配列を新しく作ります。構文: new クラス名(引数) または new 型[長さ] 例: int[] values = new int[3];',
  this: '現在のオブジェクトを指します。this(...) は同じクラスの別のコンストラクタを呼び出します。構文: this.メンバー または this(引数); 例: class Box { int size; Box(int size) { this.size = size; } }',
  public:
    'ほかのクラスなどから利用できるようにするアクセス修飾子です。構文: public 宣言 例: class Box { public int size = 3; }',
  private:
    '宣言したクラスの内部に利用を制限するアクセス修飾子です。構文: private 宣言 例: class Box { private int size = 3; }',
  protected:
    '同じパッケージや、継承先からの利用を認めるアクセス修飾子です。継承先からの利用には制限もあります。構文: protected 宣言 例: class Box { protected int size = 3; }',
  static:
    '各オブジェクトではなくクラスに属する変数やメソッドなどを表します。構文: static メンバー宣言 例: class Box { static int count = 3; }',
};

export const getJavaSyntaxHint = (text: string, classes: readonly string[]): string | undefined => {
  if (classes.includes('import') && text === '*') return undefined;
  if (classes.includes('generics') && (classes.includes('operator') || ['<', '>', '?'].includes(text))) {
    return undefined;
  }
  if (!classes.some((name) => ['keyword', 'operator'].includes(name))) {
    return undefined;
  }
  return Object.hasOwn(hints, text) ? hints[text] : undefined;
};
