/** The attributes of sys that belong to the environment a program runs in, which this grader does not provide. */
export const UNSUPPORTED_SYS_ATTRIBUTES: Record<string, string> = {
  argv: 'コマンドライン引数（sys.argv）',
  stdin: '標準入力（sys.stdin）',
  path: 'モジュールの検索パス（sys.path）',
  modules: 'sys.modules',
  setrecursionlimit: 'sys.setrecursionlimit()',
  getrecursionlimit: 'sys.getrecursionlimit()',
  version: 'sys.version',
  version_info: 'sys.version_info',
  platform: 'sys.platform',
};
