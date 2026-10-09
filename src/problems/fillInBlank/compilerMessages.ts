export const genericCompilerMessage =
  'コードを実行する準備ができませんでした。書き方や、使っている名前・値を確認してください。';
export const delimiterCompilerMessage =
  '「(」と「)」、「{」と「}」などが対応しているか確認してください。コード全体で、括弧や記号の抜けがないか見てみましょう。';

export const fixedCompilerMessages: Record<string, string> = {
  "';' expected": 'この付近に「;」が必要です。この行や直前のコードを確認してください。',
  "')' expected": 'この付近に「)」が必要です。「(」との対応や、直前のコードを確認してください。',
  "'}' expected": 'この付近に「}」が必要です。「{」との対応や、直前のコードを確認してください。',
  "']' expected": 'この付近に「]」が必要です。「[」との対応や、直前のコードを確認してください。',
  "'(' expected": 'この付近に「(」が必要です。丸括弧を使う部分と、直前のコードを確認してください。',
  "'{' expected": 'この付近に「{」が必要です。処理を囲む部分と、直前のコードを確認してください。',
  'reached end of file while parsing': delimiterCompilerMessage,
  'illegal start of expression':
    'この付近の書き方を Java のコードとして読み取れません。記号の抜けや、値・処理を書く位置を確認してください。',
  'illegal start of type':
    'この付近の書き方を Java のコードとして読み取れません。記号の抜けや、変数・メソッドを書く位置を確認してください。',
  'not a statement':
    'この部分を処理として実行する書き方になっていません。代入やメソッドの呼び出し方、前後の記号を確認してください。',
  'unclosed string literal': '文字列を囲む「"」が閉じられていません。文字列の始まりと終わりを確認してください。',
  'unclosed character literal':
    '文字を囲む「\'」の書き方を確認してください。複数の文字を文字列として書く場合は「"」で囲みます。',
  'empty character literal':
    '「\'」の間に文字がありません。1文字を入れるか、空の文字列なら「""」を使うかを確認してください。',
  'unclosed comment': '「/*」で始めたコメントが閉じられていません。終わりの「*/」を確認してください。',
  'missing return statement': '値を返さずに終わる場合があります。return で値を返す処理と条件分岐を確認してください。',
  'unreachable statement':
    'この処理にはたどり着けません。直前の return や break、繰り返しなど、処理の順番を確認してください。',
  'illegal escape character':
    '文字列や文字の中で、改行などを表す記号の書き方が合っていません。記号に続く文字を確認してください。',
  'incompatible types: missing return value':
    'ここでは return で値を返す必要があります。メソッドで返す値の種類と、return の後に書く値を確認してください。',
  'incompatible types: unexpected return value':
    'このメソッドは値を返さない書き方になっています。メソッドの定義と、return の後の値を確認してください。',
  "'else' without 'if'": 'この else に対応する if が見つかりません。直前の「;」や「{」「}」の位置を確認してください。',
  'break outside switch or loop':
    'この場所では break を使えません。抜けたい繰り返しや switch の中に書かれているか、括弧の対応も確認してください。',
  'continue outside of loop':
    'この場所では continue を使えません。次の回に進めたい繰り返しの中に書かれているか、括弧の対応も確認してください。',
  'array dimension missing':
    '作る配列の要素数か、配列に入れる値が必要です。new の後の「[]」と「{}」の書き方を確認してください。',
  'for-each not applicable to expression type':
    'この繰り返し方では、複数の値を順番に取り出せる配列などが必要です。「:」の右側に書いた値を確認してください。',
  'duplicate case label': '同じ値の case が重なっています。switch の各 case に書いた値を確認してください。',
  'duplicate default label':
    '1つの switch に default が複数あります。どの case にも当てはまらないときの処理を確認してください。',
  "'try' without 'catch', 'finally' or resource declarations":
    'この try に続く処理の書き方が足りません。catch や finally などの書き方と、括弧の対応を確認してください。',
  "'catch' without 'try'":
    'この catch に対応する try が見つかりません。try と catch の並び方や、括弧の対応を確認してください。',
};

export function translateCompilerMessage(original: string): string {
  const fixed = fixedCompilerMessages[original];
  if (fixed) return fixed;
  const symbol = /^cannot find symbol\nsymbol: (variable|class|method) ([^(\n]+)/.exec(original);
  if (symbol)
    return symbol[1] === 'method'
      ? `この呼び出し方に合う「${symbol[2]}」が見つかりません。名前と、呼び出す相手や渡す値を確認してください。`
      : `${symbol[1] === 'class' ? 'クラス' : '変数'}「${symbol[2]}」が見つかりません。名前のつづりと、この場所で使えるように宣言されているかを確認してください。`;
  if (original === 'cannot find symbol')
    return 'この場所で使う名前が見つかりません。名前のつづりと、使える範囲や呼び出し方を確認してください。';
  const conversion = /^incompatible types: (.+) cannot be converted to (.+)$/.exec(original);
  if (conversion)
    return bounded(
      `必要な値の種類は「${describeType(conversion[2])}」ですが、ここには「${describeType(conversion[1])}」の値が使われています。値と、受け取る側の種類（型）を確認してください。`,
      '使う値と、受け取る側で必要な値の種類（型）が合っていません。代入や呼び出し、条件の書き方を確認してください。'
    );
  const call =
    /^(?:no suitable (?:method|constructor) found for ([^ (]+)\(.*\)|(?:method|constructor) ([^ (]+) in class [^ ]+ cannot be applied to given types;)$/.exec(
      original.split('\n')[0]
    );
  if (call)
    return `「${call[1] ?? call[2]}」に渡す値の個数や種類が合っていません。丸括弧の中と、呼び出す相手の定義を確認してください。`;
  const access = /^(.+) has private access in /.exec(original);
  if (access)
    return `「${access[1]}」はこの場所から直接使えません。用意されている操作や、使える範囲を確認してください。`;
  const duplicate = /^(variable|method|class) ([^( ]+)/.exec(original);
  if (duplicate && original.includes(' is already defined in '))
    return duplicate[1] === 'method'
      ? '同じ名前で、渡す値の個数と種類も同じメソッドがすでにあります。定義を重ねて書いていないか確認してください。'
      : `この範囲では${duplicate[1] === 'class' ? 'クラス' : '変数'}「${duplicate[2]}」がすでに使われています。同じ名前で重ねて宣言していないか確認してください。`;

  if (original.startsWith('illegal character: '))
    return 'Java の記号として使えない文字があります。全角と半角の違いや、余分な記号がないか確認してください。';
  if (original.startsWith('incompatible types: possible lossy conversion from '))
    return 'この値を受け取る種類にすると、小数部分や大きな数の情報が失われる可能性があります。使う値と、受け取る側の種類（型）を確認してください。';
  const binary = /^bad operand types for binary operator '(.+)'$/.exec(original);
  if (binary) return `「${binary[1]}」では、この組み合わせの値を使えません。左右の値の種類を確認してください。`;
  const unary = /^bad operand type .+ for unary operator '(.+)'$/.exec(original);
  if (unary) return `「${unary[1]}」では、この種類の値を使えません。記号の使い方と、対象の値の種類を確認してください。`;
  if (original.startsWith('incomparable types: '))
    return 'この組み合わせの値を比べることはできません。比べる左右の値の種類を確認してください。';
  if (original.endsWith(' cannot be dereferenced'))
    return 'この値には「.」でメソッドや中の変数を指定できません。「.」の前に書いた値の種類を確認してください。';
  const final = /^cannot assign a value to final variable (.+)$/.exec(original);
  if (final)
    return `「${final[1]}」は一度決めた値を変更できない変数です。値を入れる場所と、その後の処理を確認してください。`;
  if (original === 'unexpected type\nrequired: variable\nfound: value')
    return 'ここには値を入れる先の変数などが必要です。代入の左側や、値を変更する記号の対象を確認してください。';
  if (original.startsWith('non-static '))
    return 'このメソッドや変数を使うには、使う相手のオブジェクトが必要です。呼び出す相手と、クラスやメソッドの定義を確認してください。';
  const uninitialized = /^variable (.+) might not have been initialized$/.exec(original);
  if (uninitialized)
    return `変数「${uninitialized[1]}」に値が入っていない可能性があります。使う前に値が入るよう、処理の順番や条件を確認してください。`;
  if (original.startsWith('array required, but '))
    return '「[]」で要素を取り出すには配列が必要です。「[]」の前に書いた値の種類を確認してください。';
  const duplicateClass = /^duplicate class: (.+)$/.exec(original);
  if (duplicateClass)
    return `クラス「${duplicateClass[1]}」が重ねて定義されています。クラスの名前と定義する場所を確認してください。`;
  if (original.startsWith('unreported exception '))
    return 'この処理で起こる例外への対応が必要です。try と catch で扱うか、呼び出す側に知らせるかを、メソッドの役割に合わせて確認してください。';
  if (original.includes(' cannot override '))
    return '引き継いだメソッドと書き方が合っていません。返す値の種類や、使える範囲などを、引き継ぐ元の定義と見比べてください。';
  return genericCompilerMessage;
}

function describeType(type: string): string {
  return type === 'int' ? 'int（整数）' : type === 'boolean' ? 'boolean（true または false）' : type;
}

function bounded(message: string, fallback: string): string {
  return message.length <= 240 ? message : fallback;
}
