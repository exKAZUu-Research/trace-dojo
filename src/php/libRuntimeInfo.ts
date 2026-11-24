// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { compareSync, encodeBase64, hashSync } from 'bcryptjs';

import { ExecutionLimitError } from '../interpreter/limits';
import { dec, enc } from './bytes';
import { throwError, warn } from './errors';
import { defineAlias, defineConstant, defineFunction } from './native';
import { toStr } from './operators';
import { rt, type Runtime } from './runtime';
import { UnsupportedFeatureError } from './unsupported';
import { PhpArray } from './values';

// Settings -----------------------------------------------------------------------------------------------------------

interface Setting {
  initial: string;
  /** Applies a new value, returning false when PHP rejects it. */
  apply?: (runtime: Runtime, value: string) => boolean;
}

/** Reads an integer setting as PHP's `ZEND_STRTOL` does: its leading digits, or 0. */
function leadingInt(value: string): number {
  return Number.parseInt(/^\s*[+-]?\d+/.exec(value)?.[0] ?? '0', 10);
}

/** The settings programs change, with their values in PHP's CLI without a php.ini. */
const SETTINGS = new Map<string, Setting>([
  [
    'precision',
    {
      initial: '14',
      apply: (runtime, value) => {
        runtime.precision = leadingInt(value);
        return true;
      },
    },
  ],
  [
    'serialize_precision',
    {
      initial: '-1',
      apply: (runtime, value) => {
        runtime.serializePrecision = leadingInt(value);
        return true;
      },
    },
  ],
  [
    'display_errors',
    {
      initial: '1',
      apply: (runtime, value) => {
        const lower = value.toLowerCase();
        if (lower === 'stderr') runtime.displayErrors = 'stderr';
        else
          runtime.displayErrors =
            ['on', 'yes', 'true', 'stdout'].includes(lower) || leadingInt(value) !== 0 ? 'stdout' : 'off';
        return true;
      },
    },
  ],
  [
    'error_reporting',
    {
      initial: '',
      apply: (runtime, value) => {
        runtime.errorReporting = BigInt(leadingInt(value));
        return true;
      },
    },
  ],
  ['memory_limit', { initial: '128M', apply: (_, value) => checkMemoryLimit(value) }],
  ['max_execution_time', { initial: '0' }],
  ['date.timezone', { initial: 'UTC', apply: (_, value) => checkTimezone(value) }],
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- PHP reports this canonical encoding name.
  ['default_charset', { initial: 'UTF-8' }],
]);

/** Settings PHP has whose effects this grader does not reproduce, which it rejects instead of ignoring. */
const UNMODELED_SETTINGS = new Set([
  'zend.assertions',
  'assert.active',
  'assert.exception',
  'assert.warning',
  'assert.bail',
  'assert.callback',
  'html_errors',
  'log_errors',
  'error_log',
  'error_prepend_string',
  'error_append_string',
  'output_buffering',
  'output_handler',
  'implicit_flush',
  'short_open_tag',
  'include_path',
  'auto_detect_line_endings',
  'arg_separator.output',
  'unserialize_callback_func',
  'unserialize_max_depth',
  'zend.enable_gc',
  'pcre.backtrack_limit',
  'pcre.recursion_limit',
  'pcre.jit',
  'mbstring.language',
  'mbstring.internal_encoding',
  'mbstring.substitute_character',
  'session.save_path',
  'session.name',
  'upload_max_filesize',
  'post_max_size',
  'max_input_time',
  'default_socket_timeout',
  'user_agent',
  'allow_url_fopen',
  'register_argc_argv',
]);

function settingNamed(name: string): Setting | undefined {
  if (UNMODELED_SETTINGS.has(name)) throw new UnsupportedFeatureError(`実行環境の設定（${name}）`);
  return SETTINGS.get(name);
}

function currentValue(runtime: Runtime, name: string, setting: Setting): string {
  return runtime.iniSettings.get(name) ?? setting.initial;
}

const BYTES_IN_USE = 2_097_152;

function checkMemoryLimit(value: string): boolean {
  const match = /^\s*([+-]?\d+)\s*([gkm]?)\s*$/i.exec(value);
  if (!match) {
    if (/^\s*[+-]?\d/.test(value)) throw new UnsupportedFeatureError(`memory_limit の値（${value}）`);
    warn(
      `Invalid "memory_limit" setting. Invalid quantity "${value}": no valid leading digits, interpreting as "0" for backwards compatibility`
    );
    warn(`Failed to set memory limit to 0 bytes (Current memory usage is ${BYTES_IN_USE} bytes)`);
    return false;
  }
  const bytes = Number(match[1]) * 1024 ** ' kmg'.indexOf(match[2].toLowerCase() || ' ');
  if (bytes >= 0 && bytes < BYTES_IN_USE) {
    warn(`Failed to set memory limit to ${bytes} bytes (Current memory usage is ${BYTES_IN_USE} bytes)`);
    return false;
  }
  return true;
}

function checkTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    warn(`ini_set(): Invalid date.timezone value '${value}', using 'UTC' instead`);
    return false;
  }
}

defineFunction('ini_get(string $option): string|false', ({ args }) => {
  const name = args[0] as string;
  const setting = settingNamed(name);
  return setting ? currentValue(rt(), name, setting) : false;
});

defineFunction('ini_set(string $option, string|int|float|bool|null $value): string|false', ({ args }) => {
  const runtime = rt();
  const name = args[0] as string;
  const setting = settingNamed(name);
  if (!setting) return false;
  const value = args[1] === null ? '' : toStr(args[1]);
  const previous = currentValue(runtime, name, setting);
  if (setting.apply && !setting.apply(runtime, value)) return false;
  runtime.iniSettings.set(name, value);
  return previous;
});
defineAlias('ini_alter', 'ini_set');

defineFunction('ini_restore(string $option): void', ({ args }) => {
  const runtime = rt();
  const name = args[0] as string;
  const setting = settingNamed(name);
  if (setting && runtime.iniSettings.has(name)) {
    setting.apply?.(runtime, setting.initial);
    runtime.iniSettings.delete(name);
  }
  return null;
});

defineFunction('set_time_limit(int $seconds): bool', ({ args }) => {
  rt().iniSettings.set('max_execution_time', String(args[0] as bigint));
  return true;
});

// Machine information ------------------------------------------------------------------------------------------------

// The grader stands for a typical Linux server, as values that depend on the machine have no right answer.
defineConstant('PHP_OS', 'Linux');
defineConstant('PHP_OS_FAMILY', 'Linux');

const UNAME = new Map([
  ['s', 'Linux'],
  ['n', 'localhost'],
  ['r', '6.8.0'],
  ['v', '#1 SMP PREEMPT_DYNAMIC'],
  ['m', 'x86_64'],
]);

defineFunction('php_uname(string $mode = "a"): string', ({ args }) => {
  const mode = (args[0] as string | undefined) ?? 'a';
  if (mode.length !== 1) throwError('ValueError', 'php_uname(): Argument #1 ($mode) must be a single character');
  if (mode === 'a') return [...UNAME.values()].join(' ');
  const value = UNAME.get(mode);
  if (value === undefined)
    throwError('ValueError', 'php_uname(): Argument #1 ($mode) must be one of "a", "m", "n", "r", "s", or "v"');
  return value;
});

defineFunction('getmypid(): int|false', () => 4242n);

/** About the memory PHP reports for a small script, growing with the array elements and properties allocated. */
function memoryUsage(real: boolean): bigint {
  if (real) return BigInt(BYTES_IN_USE);
  return BigInt(393_216 + rt().allocatedSlots * 32);
}

defineFunction('memory_get_usage(bool $real_usage = false): int', ({ args }) => memoryUsage(args[0] === true));
defineFunction('memory_get_peak_usage(bool $real_usage = false): int', ({ args }) => memoryUsage(args[0] === true));

// Unique and random values -------------------------------------------------------------------------------------------

/** The time `uniqid` last used, in microseconds, which the next call must pass as PHP waits for the clock to. */
const lastUniqueTimes = new WeakMap<Runtime, number>();

defineFunction('uniqid(string $prefix = "", bool $more_entropy = false): string', ({ args }) => {
  const runtime = rt();
  const now = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  const time = Math.max(now, (lastUniqueTimes.get(runtime) ?? 0) + 1);
  lastUniqueTimes.set(runtime, time);
  const seconds = Math.floor(time / 1_000_000).toString(16);
  const micros = (time % 1_000_000).toString(16);
  const id = `${(args[0] as string | undefined) ?? ''}${seconds.padStart(8, '0')}${micros.padStart(5, '0')}`;
  return args[1] === true ? `${id}${(Math.random() * 10).toFixed(8)}` : id;
});

defineFunction('random_bytes(int $length): string', ({ args }) => {
  const length = Number(args[0] as bigint);
  if (length < 1) throwError('ValueError', 'random_bytes(): Argument #1 ($length) must be greater than 0');
  rt().ensureStringFits(length);
  rt().spend(Math.ceil(length / 64));
  return String.fromCodePoint(...randomBytes(length));
});

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65,536 bytes at a time.
  for (let start = 0; start < length; start += 65_536) crypto.getRandomValues(bytes.subarray(start, start + 65_536));
  return bytes;
}

// Passwords ----------------------------------------------------------------------------------------------------------

defineConstant('PASSWORD_DEFAULT', '2y');
defineConstant('PASSWORD_BCRYPT', '2y');
defineConstant('PASSWORD_BCRYPT_DEFAULT_COST', 12n);

const DEFAULT_COST = 12;
const BCRYPT_HASH = /^\$2y\$(\d\d)\$[./A-Za-z0-9]{53}$/;

/**
 * The total bcrypt work (the sum of 2^cost) a run may do. bcrypt is slow by design, and bcryptjs takes about a second
 * for PHP's default cost 12, so its time does not count against the time limit, and this bounds it instead.
 */
const MAX_BCRYPT_WORK = 6 * 2 ** DEFAULT_COST;
const bcryptWork = new WeakMap<Runtime, number>();

function runBcrypt<T>(cost: number, work: () => T): T {
  const runtime = rt();
  const total = (bcryptWork.get(runtime) ?? 0) + 2 ** cost;
  if (total > MAX_BCRYPT_WORK) throw new ExecutionLimitError('time');
  bcryptWork.set(runtime, total);
  runtime.spend();
  return runtime.budget.excludingTime(work);
}

/** The password as bcryptjs takes it: text whose UTF-8 encoding is the password's bytes. */
function passwordText(password: string): string {
  const text = dec(password);
  if (enc(text) !== password) throw new UnsupportedFeatureError('UTF-8 として正しくないバイト列のパスワード');
  return text;
}

function isBcrypt(algo: unknown): boolean {
  return algo === null || algo === '2y' || algo === 1n;
}

defineFunction('password_hash(string $password, string|int|null $algo, array $options = []): string', ({ args }) => {
  const password = args[0] as string;
  const algo = args[1];
  if (!isBcrypt(algo)) {
    if (algo === 'argon2i' || algo === 'argon2id')
      throw new UnsupportedFeatureError(`パスワードのハッシュ方式（${algo}）`);
    throwError('ValueError', 'password_hash(): Argument #2 ($algo) must be a valid password hashing algorithm');
  }
  const options = (args[2] as PhpArray | undefined) ?? new PhpArray();
  const costOption = options.get('cost');
  const cost = costOption === undefined ? DEFAULT_COST : Number(costOption);
  if (!Number.isInteger(cost) || cost < 4 || cost > 31)
    throwError('ValueError', `Invalid bcrypt cost parameter specified: ${toStr(costOption ?? null)}`);
  if (options.get('salt') !== undefined)
    warn('password_hash(): The "salt" option has been ignored, since providing a custom salt is no longer supported');
  if (password.includes('\0')) throwError('ValueError', 'Bcrypt password must not contain null character');
  const salt = `$2y$${String(cost).padStart(2, '0')}$${encodeBase64([...randomBytes(16)], 16)}`;
  return runBcrypt(cost, () => hashSync(passwordText(password), salt));
});

defineFunction('password_verify(string $password, string $hash): bool', ({ args }) => {
  const [password, hash] = args as [string, string];
  const match = /^\$2[aby]\$(\d\d)\$[./A-Za-z0-9]{53}$/.exec(hash);
  if (!match) {
    if (/^\$(1|5|6|argon2id?|2x)\$/.test(hash)) throw new UnsupportedFeatureError('bcrypt 以外のパスワードのハッシュ');
    return false;
  }
  const cost = Number(match[1]);
  if (cost < 4 || cost > 31) return false;
  return runBcrypt(cost, () => compareSync(passwordText(password), hash));
});

defineFunction('password_get_info(string $hash): array', ({ args }) => {
  const match = BCRYPT_HASH.exec(args[0] as string);
  const info = new PhpArray();
  const options = new PhpArray();
  if (match) options.set('cost', BigInt(match[1]));
  info.set('algo', match ? '2y' : null);
  info.set('algoName', match ? 'bcrypt' : 'unknown');
  info.set('options', options);
  return info;
});

defineFunction('password_needs_rehash(string $hash, string|int|null $algo, array $options = []): bool', ({ args }) => {
  const match = BCRYPT_HASH.exec(args[0] as string);
  if (!isBcrypt(args[1]) || !match) return true;
  const cost = (args[2] as PhpArray | undefined)?.get('cost');
  return Number(match[1]) !== (cost === undefined ? DEFAULT_COST : Number(cost));
});
