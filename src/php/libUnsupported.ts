import { defineClass, defineFunction } from './native';
import { UnsupportedFeatureError } from './unsupported';
import { unsupportedClasses } from './unsupportedCatalog';

/** The builtin functions this grader rejects, grouped by what learners would call them. */
const UNSUPPORTED_FUNCTIONS: [string, string[]][] = [
  ['標準入力の読み込み', ['readline_add_history']],
  [
    'ファイルの読み書き',
    [
      'tempnam',
      'sys_get_temp_dir',
      'filemtime',
      'fileperms',
      'chmod',
      'parse_ini_file',
      'fstat',
      'stat',
      'disk_free_space',
    ],
  ],
  ['日付と時刻', ['strftime', 'gmstrftime']],
  [
    '外部コマンドの実行',
    ['exec', 'system', 'shell_exec', 'passthru', 'proc_open', 'popen', 'pclose', 'proc_close', 'pcntl_fork'],
  ],
  [
    'ネットワーク',
    [
      'fsockopen',
      'curl_init',
      'curl_exec',
      'curl_setopt',
      'socket_create',
      'stream_socket_client',
      'gethostbyname',
      'mail',
      'header',
      'setcookie',
      'http_response_code',
    ],
  ],
  ['セッション', ['session_start', 'session_destroy', 'session_id']],
  ['環境変数', ['getenv', 'putenv']],
  ['リクエストの入力の検査', ['filter_input', 'filter_input_array']],
  [
    '実行環境の情報と設定',
    ['phpinfo', 'get_defined_functions', 'get_defined_constants', 'get_declared_classes', 'debug_zval_dump'],
  ],
];

for (const [what, names] of UNSUPPORTED_FUNCTIONS) {
  for (const name of names) {
    defineFunction(`${name}(mixed &~...$args): mixed`, () => {
      throw new UnsupportedFeatureError(`${what}（${name}）`);
    });
  }
}

/** The builtin classes this grader rejects when a program creates or uses them. */
const UNSUPPORTED_CLASSES: [string, string[]][] = [
  ['ファイルの読み書き', ['DirectoryIterator', 'FilesystemIterator', 'RecursiveDirectoryIterator']],
  [
    'リフレクション',
    [
      'ReflectionClass',
      'ReflectionObject',
      'ReflectionMethod',
      'ReflectionFunction',
      'ReflectionProperty',
      'ReflectionNamedType',
      'ReflectionEnum',
    ],
  ],
  ['Fiber', ['Fiber']],
  ['弱い参照の表（WeakMap）', ['WeakMap']],
  ['データベース', ['PDO', 'mysqli', 'SQLite3']],
];

for (const [what, names] of UNSUPPORTED_CLASSES) {
  for (const name of names) {
    unsupportedClasses.set(name.toLowerCase(), `${what}（${name}）`);
    defineClass({
      name,
      methods: [
        {
          signature: '__construct(mixed &~...$args)',
          impl: () => {
            throw new UnsupportedFeatureError(`${what}（${name}）`);
          },
        },
      ],
      createInternal: () => {
        throw new UnsupportedFeatureError(`${what}（${name}）`);
      },
    });
  }
}
