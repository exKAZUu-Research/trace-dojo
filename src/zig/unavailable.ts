/** Something this grader does not run, and the words its diagnostic names it by. */
interface Unavailable {
  readonly what: string;
}

/**
 * The builtins, by name, the syntax, by a `syntax:` key, and the operations of a run, by an `io:` key, that this grader
 * rejects with the 「使えません」 diagnostic; the declarations of Zig's library it leaves out are listed by publicMembers.ts instead.
 */
export const UNAVAILABLE: ReadonlyMap<string, Unavailable> = new Map<string, Unavailable>([
  ['@cImport', { what: 'C との連携（@cImport）' }],
  ['@cInclude', { what: 'C との連携（@cInclude）' }],
  ['@cDefine', { what: 'C との連携（@cDefine）' }],
  ['@cUndef', { what: 'C との連携（@cUndef）' }],
  ['@embedFile', { what: '@embedFile（ファイルの読み込み）' }],
  ['@extern', { what: '@extern' }],
  ['@export', { what: '@export' }],
  ['@ptrCast', { what: '@ptrCast（メモリの表現に依存する変換）' }],
  ['@intFromPtr', { what: '@intFromPtr（メモリの表現に依存する変換）' }],
  ['@ptrFromInt', { what: '@ptrFromInt（メモリの表現に依存する変換）' }],
  ['@fieldParentPtr', { what: '@fieldParentPtr（メモリの表現に依存する変換）' }],
  ['@alignCast', { what: '@alignCast' }],
  ['@addrSpaceCast', { what: '@addrSpaceCast' }],
  ['@atomicLoad', { what: 'アトミック操作（@atomicLoad）' }],
  ['@atomicStore', { what: 'アトミック操作（@atomicStore）' }],
  ['@atomicRmw', { what: 'アトミック操作（@atomicRmw）' }],
  ['@cmpxchgStrong', { what: 'アトミック操作（@cmpxchgStrong）' }],
  ['@cmpxchgWeak', { what: 'アトミック操作（@cmpxchgWeak）' }],
  ['@frameAddress', { what: '@frameAddress' }],
  ['@returnAddress', { what: '@returnAddress' }],
  ['@breakpoint', { what: '@breakpoint' }],
  ['@trap', { what: '@trap' }],
  ['@wasmMemorySize', { what: 'WebAssembly の組み込み関数' }],
  ['@wasmMemoryGrow', { what: 'WebAssembly の組み込み関数' }],
  ['@workGroupId', { what: 'GPU の組み込み関数' }],
  ['@workGroupSize', { what: 'GPU の組み込み関数' }],
  ['@workItemId', { what: 'GPU の組み込み関数' }],
  ['@SpirvType', { what: 'GPU の組み込み関数' }],
  ['@cVaArg', { what: '可変個の引数' }],
  ['@cVaCopy', { what: '可変個の引数' }],
  ['@cVaEnd', { what: '可変個の引数' }],
  ['@cVaStart', { what: '可変個の引数' }],
  ['@intFromError', { what: '@intFromError（エラーの番号）' }],
  ['@errorFromInt', { what: '@errorFromInt（エラーの番号）' }],
  ['@errorReturnTrace', { what: '@errorReturnTrace' }],
  ['@Pointer', { what: '@Pointer（型の操作）' }],
  ['@Fn', { what: '@Fn（型の操作）' }],
  ['@Struct', { what: '@Struct（型の操作）' }],
  ['@Union', { what: '@Union（型の操作）' }],
  ['@Enum', { what: '@Enum（型の操作）' }],
  ['@bitCast', { what: '@bitCast（メモリの表現に依存する変換）' }],
  ['@sizeOf', { what: '@sizeOf（メモリの表現）' }],
  ['@bitSizeOf', { what: '@bitSizeOf（メモリの表現）' }],
  ['@alignOf', { what: '@alignOf（メモリの表現）' }],
  ['@offsetOf', { what: '@offsetOf（メモリの表現）' }],
  ['@bitOffsetOf', { what: '@bitOffsetOf（メモリの表現）' }],
  ['@backingInt', { what: '@backingInt（メモリの表現に依存する変換）' }],
  ['@fromBackingInt', { what: '@fromBackingInt（メモリの表現に依存する変換）' }],
  ['@typeInfo:opaque', { what: 'opaque 型の @typeInfo' }],
  ['@typeInfo:genericFn', { what: 'generic な関数の型の @typeInfo' }],
  ['@Vector', { what: 'ベクトル（@Vector）' }],
  ['@reduce', { what: 'ベクトル（@reduce）' }],
  ['@shuffle', { what: 'ベクトル（@shuffle）' }],
  ['@select', { what: 'ベクトル（@select）' }],
  ['io:nonAsciiDelimiter', { what: 'ASCII 以外のバイトでの区切り' }],
  ['io:nonUtf8File', { what: 'UTF-8 として正しくないバイトのファイルへの書き込み' }],
  ['@setRuntimeSafety(false)', { what: '@setRuntimeSafety(false)（実行時の検査を外す指定）' }],
  ['@inComptime', { what: '@inComptime（コンパイルのときかどうかの判定）' }],
  ['syntax:extern', { what: 'extern（外部で定義する関数・変数の宣言）' }],
  ['syntax:linksection', { what: 'linksection（OS ごとに書き方が異なるセクションの指定）' }],
  ['syntax:fnTypeAlign', { what: '関数の型の align' }],
  ['syntax:fnTypeAddrspace', { what: '関数の型の addrspace' }],
  ['syntax:asm', { what: 'インラインアセンブリ（asm）' }],
  ['syntax:packedFieldPointer', { what: 'packed struct のフィールドへのポインタの型（align(a:b:c)）' }],
  ['syntax:addrspace', { what: 'generic 以外のアドレス空間（CPU ごとに異なるもの）' }],
  ['syntax:callconv', { what: 'callconv' }],
  ['syntax:export', { what: 'export' }],
]);

/** The 「使えません」 diagnostic for an entry of `UNAVAILABLE`. */
export function unavailableMessage(key: string): string {
  const entry = UNAVAILABLE.get(key);
  if (!entry) throw new Error(`${key} is not listed as unavailable`);
  return `${entry.what}は、この採点環境では使えません。`;
}
