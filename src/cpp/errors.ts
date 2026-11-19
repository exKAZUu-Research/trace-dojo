import { CompileError } from '../interpreter/diagnostics';
import type { Type } from './types';
import { Box, endLifetime, Ptr, type Value } from './values';

const MESSAGES = {
  nullAccess: 'nullptr（NULL）のポインタの指す先を読み書きしました。',
  outOfBounds: '配列の範囲の外を読み書きしました。',
  deadVariable: '有効期間が終わった変数（またはオブジェクト）を読み書きしました。',
  useAfterDelete: 'delete で解放したオブジェクトを読み書きしました。',
  uninitialized: '値を入れていない変数（または要素）の値を読みました。',
  divisionByZero: '0 で割りました。',
  shiftCount: 'シフトする量が、負の数か、型のビット数以上です。',
  floatToInt: '浮動小数点数を整数にした値が、整数の型の範囲を超えています。',
  doubleDelete: '同じオブジェクトを2回 delete しました。',
  invalidDelete: 'new で作ったものではないもの（または new と new[] の取り違え）を delete しました。',
  stackOverflow: '関数の呼び出しが深すぎます（スタックオーバーフロー）。',
  missingReturn: '値を返す関数が、return で値を返さずに終わりました。',
  pointerDifference: '別々の配列を指す2つのポインタの差を求めました。',
  pointerOutOfRange: 'ポインタの足し算・引き算の結果が、配列の範囲の外を指しました。',
  pointerComparison: '別々の配列を指す2つのポインタの大小を比べました。',
  invalidIterator: '使えなくなったイテレータ（または範囲の外を指すイテレータ）を使いました。',
  emptyContainer: '空のコンテナの要素を読み書きしました。',
  formatArgumentMissing: '書式（%d など）に対応する引数が足りません。',
  formatArgumentType: '書式（%d など）と引数の型が合いません。',
  stringLiteralWrite: '文字列リテラルは書き換えられません。',
  unterminatedString: String.raw`文字列の終わり（\0）がないまま、配列の範囲の外まで読みました。`,
  invalidRange: 'アルゴリズムに渡した範囲（先頭と末尾のイテレータ）が正しくありません。',
  invalidComparator: '比較の関数が、狭義の弱順序になっていません（a < a が true など）。',
} as const;

export type RuntimeErrorKind = keyof typeof MESSAGES;

/** Stops a program at undefined behavior, which the interpreter reports instead of reproducing. */
export class CppRuntimeError extends Error {
  constructor(
    readonly kind: RuntimeErrorKind | 'custom',
    detail?: string
  ) {
    super(kind === 'custom' ? (detail ?? '') : (detail ?? MESSAGES[kind]));
    this.name = 'CppRuntimeError';
  }
}

export function overflowError(typeName: string): CppRuntimeError {
  return new CppRuntimeError(
    'custom',
    `${typeName} の計算の結果が、${typeName} の範囲を超えました（オーバーフロー）。`
  );
}

/** Ends the program as `std::exit` does, running no more of it. */
export class ProgramExit extends Error {
  constructor(readonly status: number) {
    super(`exit(${status})`);
    this.name = 'ProgramExit';
  }
}

/** Ends the program as `std::terminate` and `std::abort` do, with the message libc++ writes to standard error. */
export class ProgramAbort extends Error {
  constructor(readonly description: string) {
    super(description);
    this.name = 'ProgramAbort';
  }
}

export class NarrowingConversionError extends CompileError {}

export function compileError(row: number, message: string): never {
  throw new CompileError([{ row, message }]);
}

/** Rejects a feature that the interpreter leaves out, before the program runs. */
export function unsupported(row: number, feature: string): never {
  throw new CompileError([{ row, message: unsupportedMessage(feature) }]);
}

export function unsupportedMessage(feature: string): string {
  return `${feature}は、この採点環境では使えません。`;
}

/** A C++ exception in flight: the exception object and the type `throw` gave it. */
export class CppException extends Error {
  private box?: Box;
  /** The number of handlers running for the exception, nested ones included. */
  handlerCount = 0;
  isDestroyed = false;

  constructor(
    readonly value: Value,
    readonly type: Type
  ) {
    super('C++ exception');
    this.name = 'CppException';
  }

  /** The location of the exception object, which handlers that catch by reference refer to. */
  location(): Ptr {
    this.box ??= new Box(this.value);
    return new Ptr(this.box, 0);
  }

  endLifetime(): void {
    endLifetime(this.box ?? this.value);
  }
}
