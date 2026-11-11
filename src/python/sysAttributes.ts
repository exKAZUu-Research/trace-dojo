/** The attributes of sys that belong to the environment a program runs in, which this grader does not provide. */
export const UNSUPPORTED_SYS_ATTRIBUTES: Record<string, string> = {
  argv: 'コマンドライン引数（sys.argv）',
  orig_argv: 'コマンドライン引数（sys.orig_argv）',
  stdin: '標準入力（sys.stdin）',
  path: 'モジュールの検索パス（sys.path）',
  executable: 'Python の実行ファイルのパス（sys.executable）',
  prefix: 'Python のインストール先のパス（sys.prefix）',
  base_prefix: 'Python のインストール先のパス（sys.base_prefix）',
  exec_prefix: 'Python のインストール先のパス（sys.exec_prefix）',
  base_exec_prefix: 'Python のインストール先のパス（sys.base_exec_prefix）',
  platlibdir: 'Python のライブラリのディレクトリ（sys.platlibdir）',
  getrefcount: '参照カウント（sys.getrefcount()）',
  settrace: 'トレース関数（sys.settrace()）',
  setprofile: 'プロファイル関数（sys.setprofile()）',
  excepthook: 'sys.excepthook',
  addaudithook: 'CPython の内部が起こす監査イベントを受け取るフック（sys.addaudithook()）',
};
