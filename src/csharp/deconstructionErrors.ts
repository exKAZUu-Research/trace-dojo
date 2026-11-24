/**
 * Roslyn's error for a type without a `Deconstruct` of a count: its own take other counts (CS1501), or, without one,
 * .NET's `TupleExtensions.Deconstruct` of that count, which the implicit `using System` brings, cannot infer its type
 * arguments (CS0411), up to the 21 items a `Tuple` holds.
 */
export function missingDeconstruct(
  typeName: string,
  count: number,
  hasOwn: boolean
): { code: string; message: string } {
  if (hasOwn)
    return { code: 'CS1501', message: `引数 ${count} を指定するメソッド 'Deconstruct' のオーバーロードはありません` };
  if (count < 1 || count > 21)
    return {
      code: 'CS1061',
      message: `'${typeName}' に 'Deconstruct' の定義が含まれておらず、型 '${typeName}' の最初の引数を受け付けるアクセス可能な拡張メソッド 'Deconstruct' が見つかりませんでした。using ディレクティブまたはアセンブリ参照が不足していないことを確認してください`,
    };
  const parameters = Array.from({ length: count }, (_, index) => `T${index + 1}`);
  const outs = parameters.map((name) => `out ${name}`).join(', ');
  return {
    code: 'CS0411',
    message: `メソッド 'TupleExtensions.Deconstruct<${parameters.join(', ')}>(${tupleOf(parameters)}, ${outs})' の型引数を使い方から推論することはできません。型引数を明示的に指定してください。`,
  };
}

/** A `Tuple` of type parameters, which keeps those after the seventh in a `Tuple` as its last item. */
function tupleOf(names: string[]): string {
  return names.length <= 7
    ? `Tuple<${names.join(', ')}>`
    : `Tuple<${[...names.slice(0, 7), tupleOf(names.slice(7))].join(', ')}>`;
}
