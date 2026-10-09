import { javaDiagnosticsSchema, type JavaDiagnostic } from './javaDiagnostics';
import type { JavaJudgeProgram } from './javaProgram';

const genericMessage = 'コンパイルエラーです。入力したコードを確認してください。';
const delimiterMessage = '括弧や波括弧、セミコロンなどの記号が不足していないか確認してください。';

export function normalizeCompilerDiagnostics(output: string, source: JavaJudgeProgram): JavaDiagnostic[] {
  const diagnostics: JavaDiagnostic[] = [];
  if (output.length > 65_536 || Buffer.byteLength(output, 'utf8') > 65_536) return [{ message: genericMessage }];
  const lines = output.split(/\r\n?|\n/);
  if (lines.length > 2000) return [{ message: genericMessage }];
  const seen = new Set<string>();
  for (const header of lines) {
    const match = /^(?:[^\r\n]*[/\\])?TraceDojoJudge\.java:([0-9]{1,9}): error: (.*)$/.exec(header);
    if (!match) continue;
    const generatedLine = Number(match[1]);
    const learnerLine = generatedLine - source.userStartLine + 1;
    const line = learnerLine > 0 && learnerLine <= source.userLineCount ? learnerLine : undefined;
    const category = match[2];
    let message = compilerMessage(category);
    if (line === undefined) {
      message =
        generatedLine === source.entryInvocationLine &&
        /^(cannot find symbol|method main |non-static method main)/.test(category)
          ? '開始するメソッド public static void main(String[] args) を確認してください。'
          : message === delimiterMessage
            ? delimiterMessage
            : genericMessage;
    }
    const key = `${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ message, ...(line === undefined ? {} : { line }) });
    if (diagnostics.length === 20) break;
  }
  return javaDiagnosticsSchema.parse(diagnostics.length > 0 ? diagnostics : [{ message: genericMessage }]);
}

function compilerMessage(category: string): string {
  if (
    ["';' expected", "')' expected", "'}' expected", "']' expected", "'(' expected", "'{' expected"].includes(
      category
    ) ||
    category === 'reached end of file while parsing'
  )
    return delimiterMessage;
  if (/^(illegal start of |not a statement)/.test(category)) return '式や文の書き方を確認してください。';
  if (category === 'cannot find symbol') return '変数やメソッドの名前と宣言を確認してください。';
  if (category.startsWith('incompatible types:')) return '代入する値や引数の型が合っているか確認してください。';
  if (/^(method |constructor ).* cannot be applied to given types;?$/.test(category))
    return 'メソッドやコンストラクタの引数の数と型を確認してください。';
  if (/^(variable |method |class ).* is already defined/.test(category))
    return '同じ名前の宣言が重複していないか確認してください。';
  if (category.includes(' has private access in '))
    return 'アクセスできないメンバーです。利用できるメソッドを確認してください。';
  return genericMessage;
}
