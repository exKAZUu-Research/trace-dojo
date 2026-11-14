const MESSAGES = {
  nullAccess: 'NULL ポインタの指す先を読み書きしました。',
  outOfBounds: '配列や確保した領域の範囲の外を読み書きしました。',
  deadStack: '有効期間が終わった変数を読み書きしました。',
  useAfterFree: 'free で解放した領域を読み書きしました。',
  uninitialized: '値を入れていない変数（または領域）の値を読みました。',
  readOnly: '文字列リテラルは書き換えられません。',
  divisionByZero: '0 で割りました。',
  shiftCount: 'シフトする量が、負の数か、型のビット数以上です。',
  floatToInt: '浮動小数点数を整数にした値が、整数の型の範囲を超えています。',
  doubleFree: '同じ領域を2回 free しました。',
  invalidFree: 'malloc などで確保した領域の先頭ではないアドレスを free しました。',
  stackOverflow: '関数の呼び出しが深すぎます（スタックオーバーフロー）。',
  badFunctionPointer: '関数を指していないポインタで、関数を呼び出しました。',
  missingReturn: '値を返さずに終わった関数の戻り値を使いました。',
  formatArgumentMissing: '書式（%d など）に対応する引数が足りません。',
  formatArgumentType: '書式（%d など）と引数の型が合いません。',
  pointerDifference: '別々の配列や領域を指す2つのポインタの差を求めました。',
  pointerOutOfRange: 'ポインタの足し算・引き算の結果が、配列や確保した領域の外を指しました。',
  overlappingCopy: 'コピー元とコピー先の領域が重なっています（memmove を使ってください）。',
  nullArgument: 'NULL ポインタを、NULL を受け付けない関数に渡しました。',
  unterminatedString: String.raw`文字列の終わり（\0）がないまま、配列や確保した領域の外まで読みました。`,
} as const;

export type RuntimeErrorKind = keyof typeof MESSAGES;

/** Stops a program at undefined behavior or another error that ends a C program, with a message for learners. */
export class CRuntimeError extends Error {
  constructor(
    readonly kind: RuntimeErrorKind | 'custom',
    detail?: string
  ) {
    super(kind === 'custom' ? (detail ?? '') : (detail ?? MESSAGES[kind]));
    this.name = 'CRuntimeError';
  }
}

export function overflowError(typeName: string): CRuntimeError {
  return new CRuntimeError('custom', `${typeName} の計算の結果が、${typeName} の範囲を超えました（オーバーフロー）。`);
}

/** Ends the program as `exit` does, running no more of it. */
export class ProgramExit extends Error {
  constructor(readonly status: number) {
    super(`exit(${status})`);
    this.name = 'ProgramExit';
  }
}

/** Ends the program as `abort` does, with how the program ended. */
export class ProgramAbort extends Error {
  constructor(readonly description: string) {
    super(description);
    this.name = 'ProgramAbort';
  }
}
