import { javaDiagnosticsSchema, type JavaDiagnostic } from './javaDiagnostics';
import { JAVA_JUDGE_CLASS_NAME, type JavaJudgeProgram } from './javaProgram';
import { maskJavaNonCode } from './javaSource';

const genericMessage = 'コンパイルエラーです。入力したコードを確認してください。';
const delimiterMessage = '括弧や波括弧、セミコロンなどの記号が不足していないか確認してください。';
const headerPattern = /^(?:[^\r\n]*[/\\])?TraceDojoJudge\.java:([0-9]{1,9}): error: (.*)$/;
const identifierPattern = /^[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{N}\p{M}]*$/u;
const reservedNames = new Set([JAVA_JUDGE_CLASS_NAME, 'dump', 'checkBounds', 'dirIndex', 'DIRS', 'DX', 'DY']);
const knownTypes = new Set(['boolean', 'byte', 'short', 'int', 'long', 'char', 'float', 'double', 'String', 'Turtle']);
const fixedMessages = new Set([
  "';' expected",
  "')' expected",
  "'}' expected",
  "']' expected",
  "'(' expected",
  "'{' expected",
  'reached end of file while parsing',
  'illegal start of expression',
  'illegal start of type',
  'not a statement',
  'unclosed string literal',
  'unclosed character literal',
  'empty character literal',
  'unclosed comment',
  'missing return statement',
  'unreachable statement',
]);

export function normalizeCompilerDiagnostics(output: string, source: JavaJudgeProgram): JavaDiagnostic[] {
  const diagnostics: JavaDiagnostic[] = [];
  if (output.length > 65_536 || Buffer.byteLength(output, 'utf8') > 65_536) return [{ message: genericMessage }];
  const lines = output.split(/\r\n?|\n/);
  if (lines.length > 2000) return [{ message: genericMessage }];
  const learnerCode = maskJavaNonCode(
    source.program
      .split('\n')
      .slice(source.userStartLine - 1, source.userStartLine - 1 + source.userLineCount)
      .join('\n')
  );
  // Unclosed literals can leave ambiguous tokens after masking; none establish identifier provenance.
  const identifiers = new Set(
    /["']/.test(learnerCode)
      ? []
      : // oxlint-disable-next-line eslint/no-control-regex -- Java identifier-ignorable controls must preserve whole token boundaries.
        learnerCode.match(/[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{N}\p{M}\p{Cf}\u0000-\u0008\u000E-\u001B\u007F-\u009F]+/gu)
  );
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = headerPattern.exec(lines[index]);
    if (!match) continue;
    const generatedLine = Number(match[1]);
    const learnerLine = generatedLine - source.userStartLine + 1;
    const line = learnerLine > 0 && learnerLine <= source.userLineCount ? learnerLine : undefined;
    const category = match[2];
    const continuation: string[] = [];
    while (index + 1 < lines.length && !headerPattern.test(lines[index + 1])) continuation.push(lines[++index]);
    let message = compilerMessage(category, continuation, identifiers);
    if (line === undefined) {
      message =
        generatedLine === source.entryInvocationLine &&
        /^(cannot find symbol|method main |non-static method main)/.test(category)
          ? '開始するメソッド public static void main(String[] args) を確認してください。'
          : fixedMessages.has(category) &&
              (category.endsWith(' expected') || category === 'reached end of file while parsing')
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

function compilerMessage(category: string, continuation: string[], identifiers: Set<string>): string {
  if (!safeText(category)) return genericMessage;
  if (fixedMessages.has(category)) return category;
  if (category === 'cannot find symbol') {
    const symbol = uniqueField(continuation, 'symbol');
    if (!symbol) return category;
    const match = /^(variable|class) (.+)$/.exec(symbol);
    const method = /^method (.+)\((.*)\)$/.exec(symbol);
    const valid = match
      ? safeIdentifier(match[2], identifiers)
      : method && safeIdentifier(method[1], identifiers) && safeTypes(method[2], identifiers);
    return valid && `${category}\nsymbol: ${symbol}`.length <= 240 ? `${category}\nsymbol: ${symbol}` : category;
  }
  const conversion = /^incompatible types: (.+) cannot be converted to (.+)$/.exec(category);
  if (conversion && safeType(conversion[1], identifiers) && safeType(conversion[2], identifiers)) return category;
  const unsuitable = /^no suitable (method|constructor) found for (.+)\((.*)\)$/.exec(category);
  if (unsuitable && safeIdentifier(unsuitable[2], identifiers) && safeTypes(unsuitable[3], identifiers))
    return category;
  const application = /^(method|constructor) (.+) in class (.+) cannot be applied to given types;$/.exec(category);
  if (application && safeIdentifier(application[2], identifiers) && safeIdentifier(application[3], identifiers)) {
    let message = category;
    for (const field of ['required', 'found']) {
      const value = uniqueField(continuation, field);
      if (
        value &&
        (value === 'no arguments' || safeTypes(value, identifiers)) &&
        `${message}\n${field}: ${value}`.length <= 240
      )
        message += `\n${field}: ${value}`;
    }
    return message;
  }
  const access = /^(.+) has private access in (.+)$/.exec(category);
  if (access && safeIdentifier(access[1], identifiers) && safeIdentifier(access[2], identifiers)) return category;
  const duplicate = /^(variable|method|class) (.+) is already defined in (method|class) (.+)$/.exec(category);
  if (duplicate && safeSymbol(duplicate[2], identifiers) && safeSymbol(duplicate[4], identifiers)) return category;
  return genericMessage;
}

function uniqueField(lines: string[], name: string): string | undefined {
  const fields = lines.filter((line) => line.trimStart().startsWith(`${name}:`));
  if (fields.length !== 1) return undefined;
  const field = fields[0];
  if (field.length > 240 || /[\p{Cc}\p{Cf}]/u.test(field)) return undefined;
  return field
    .slice(field.indexOf(':') + 1)
    .trim()
    .replaceAll(/ +/g, ' ');
}

function safeSymbol(value: string, identifiers: Set<string>): boolean {
  const method = /^(.+)\((.*)\)$/.exec(value);
  return method
    ? safeIdentifier(method[1], identifiers) && safeTypes(method[2], identifiers)
    : safeIdentifier(value, identifiers);
}

function safeTypes(value: string, identifiers: Set<string>): boolean {
  const types = value === '' ? [] : value.split(',');
  return value.length <= 160 && types.length <= 8 && types.every((type) => safeType(type.trim(), identifiers));
}

function safeType(value: string, identifiers: Set<string>): boolean {
  const match = /^([^[\]]+)((?:\[\]){0,4})$/.exec(value);
  return Boolean(match && (knownTypes.has(match[1]) || safeIdentifier(match[1], identifiers)));
}

function safeIdentifier(value: string, identifiers: Set<string>): boolean {
  return (
    value.length <= 80 &&
    identifierPattern.test(value) &&
    !reservedNames.has(value) &&
    !value.startsWith('__TRACE_DOJO_RESULT_') &&
    identifiers.has(value)
  );
}

function safeText(value: string): boolean {
  return value.length <= 240 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
