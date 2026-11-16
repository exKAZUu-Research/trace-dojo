import { defineClass, defineFunction } from './native';
import { UnsupportedFeatureError } from './unsupported';

/** The builtin functions this grader rejects, grouped by what learners would call them. */
const UNSUPPORTED_FUNCTIONS: [string, string[]][] = [
  [
    '標準入力の読み込み',
    ['readline', 'readline_add_history', 'fscanf', 'stream_get_line', 'stream_get_contents'],
  ],
  [
    'ファイルの読み書き',
    [
      'fopen',
      'fclose',
      'fgets',
      'fgetc',
      'fgetcsv',
      'fputcsv',
      'fread',
      'feof',
      'fflush',
      'fseek',
      'ftell',
      'rewind',
      'ftruncate',
      'flock',
      'file',
      'file_get_contents',
      'file_put_contents',
      'file_exists',
      'is_file',
      'is_dir',
      'is_readable',
      'is_writable',
      'is_writeable',
      'mkdir',
      'rmdir',
      'unlink',
      'rename',
      'copy',
      'touch',
      'glob',
      'scandir',
      'opendir',
      'readdir',
      'closedir',
      'tempnam',
      'tmpfile',
      'realpath',
      'getcwd',
      'chdir',
      'filesize',
      'filemtime',
      'fileperms',
      'chmod',
      'readfile',
      'parse_ini_file',
      'fstat',
      'stat',
      'disk_free_space',
      'sys_get_temp_dir',
    ],
  ],
  ['日付と時刻', ['date', 'time', 'mktime', 'gmmktime', 'strtotime', 'checkdate', 'gmdate', 'idate', 'getdate', 'localtime', 'microtime', 'hrtime', 'date_default_timezone_set', 'date_default_timezone_get', 'date_create', 'date_diff', 'strftime', 'gmstrftime', 'cal_days_in_month']],
  ['外部コマンドの実行', ['exec', 'system', 'shell_exec', 'passthru', 'proc_open', 'popen', 'pclose', 'proc_close', 'pcntl_fork']],
  ['ネットワーク', ['fsockopen', 'curl_init', 'curl_exec', 'curl_setopt', 'socket_create', 'stream_socket_client', 'gethostbyname', 'mail', 'header', 'setcookie', 'http_response_code']],
  ['セッション', ['session_start', 'session_destroy', 'session_id']],
  ['環境変数', ['getenv', 'putenv']],
  ['実行環境の情報と設定', ['ini_set', 'ini_get', 'set_time_limit', 'memory_get_usage', 'memory_get_peak_usage', 'getmypid', 'php_uname', 'phpinfo', 'get_defined_functions', 'get_defined_constants', 'get_declared_classes', 'debug_zval_dump', 'register_shutdown_function', 'register_tick_function', 'spl_autoload_register', 'class_alias']],
  ['直列化', ['serialize', 'unserialize']],
  ['乱数の種によらない一意の値', ['uniqid', 'password_hash', 'password_verify', 'random_bytes']],
  ['出力のバッファ', ['ob_start', 'ob_get_clean', 'ob_get_contents', 'ob_end_clean', 'ob_end_flush']],
];

for (const [what, names] of UNSUPPORTED_FUNCTIONS) {
  for (const name of names) {
    defineFunction(`${name}(mixed ...$args): mixed`, () => {
      throw new UnsupportedFeatureError(`${what}（${name}）`);
    });
  }
}

/** The builtin classes this grader rejects when a program creates or uses them. */
const UNSUPPORTED_CLASSES: [string, string[]][] = [
  ['ファイルの読み書き', ['SplFileObject', 'SplFileInfo', 'SplTempFileObject', 'DirectoryIterator', 'FilesystemIterator', 'RecursiveDirectoryIterator']],
  ['日付と時刻', ['DateTime', 'DateTimeImmutable', 'DateInterval', 'DatePeriod', 'DateTimeZone']],
  ['リフレクション', ['ReflectionClass', 'ReflectionObject', 'ReflectionMethod', 'ReflectionFunction', 'ReflectionProperty', 'ReflectionNamedType', 'ReflectionEnum']],
  ['Fiber', ['Fiber']],
  ['ジェネレータ', ['Generator']],
  ['弱い参照', ['WeakReference', 'WeakMap']],
  ['データベース', ['PDO', 'mysqli', 'SQLite3']],
];

for (const [what, names] of UNSUPPORTED_CLASSES) {
  for (const name of names) {
    defineClass({
      name,
      methods: [
        {
          signature: '__construct(mixed ...$args)',
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
