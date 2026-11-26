// Declarations of the Node.js features this interpreter runs, as @types/node declares them, which a program reads
// standard input and files with. Derived from DefinitelyTyped's @types/node 26.6.7 (MIT License), whose other members of
// `process`, its streams, and `fs` are declared too, only so that a program using one is told it is unavailable. Data
// written is a string only, as typed arrays are unavailable here.

/** The members of @types/node's `process` other than those declared with their types. */
const unavailableProcessMembers = [
  'abort',
  'addListener',
  'addUncaughtExceptionCaptureCallback',
  'allowedNodeEnvironmentFlags',
  'arch',
  'argv0',
  'availableMemory',
  'channel',
  'chdir',
  'config',
  'connected',
  'constrainedMemory',
  'cpuUsage',
  'cwd',
  'debugPort',
  'disconnect',
  'dlopen',
  'emit',
  'emitWarning',
  'eventNames',
  'execArgv',
  'execPath',
  'execve',
  'features',
  'finalization',
  'getActiveResourcesInfo',
  'getBuiltinModule',
  'getMaxListeners',
  'getegid',
  'geteuid',
  'getgid',
  'getgroups',
  'getuid',
  'hasUncaughtExceptionCaptureCallback',
  'hrtime',
  'kill',
  'listenerCount',
  'listeners',
  'loadEnvFile',
  'mainModule',
  'memoryUsage',
  'nextTick',
  'noDeprecation',
  'off',
  'once',
  'permission',
  'pid',
  'platform',
  'ppid',
  'prependListener',
  'prependOnceListener',
  'rawListeners',
  'ref',
  'release',
  'removeAllListeners',
  'removeListener',
  'report',
  'resourceUsage',
  'send',
  'setMaxListeners',
  'setSourceMapsEnabled',
  'setUncaughtExceptionCaptureCallback',
  'setegid',
  'seteuid',
  'setgid',
  'setgroups',
  'setuid',
  'sourceMapsEnabled',
  'threadCpuUsage',
  'throwDeprecation',
  'title',
  'traceDeprecation',
  'traceProcessWarnings',
  'umask',
  'unref',
  'uptime',
  'version',
  'versions',
];

/** The members of @types/node's `process.stdout` other than `write`. */
const UNAVAILABLE_STREAM_MEMBERS = [
  '_construct',
  '_destroy',
  '_final',
  '_read',
  '_write',
  '_writev',
  'addListener',
  'address',
  'allowHalfOpen',
  'autoSelectFamilyAttemptedAddresses',
  'bufferSize',
  'bytesRead',
  'bytesWritten',
  'clearLine',
  'clearScreenDown',
  'closed',
  'columns',
  'compose',
  'connect',
  'connecting',
  'cork',
  'cursorTo',
  'destroy',
  'destroySoon',
  'destroyed',
  'drop',
  'emit',
  'end',
  'errored',
  'eventNames',
  'every',
  'fd',
  'filter',
  'find',
  'flatMap',
  'forEach',
  'getColorDepth',
  'getMaxListeners',
  'getTypeOfService',
  'getWindowSize',
  'hasColors',
  'isPaused',
  'isTTY',
  'iterator',
  'listenerCount',
  'listeners',
  'localAddress',
  'localFamily',
  'localPort',
  'map',
  'moveCursor',
  'off',
  'on',
  'once',
  'pause',
  'pending',
  'pipe',
  'prependListener',
  'prependOnceListener',
  'push',
  'rawListeners',
  'read',
  'readable',
  'readableAborted',
  'readableDidRead',
  'readableEncoding',
  'readableEnded',
  'readableFlowing',
  'readableHighWaterMark',
  'readableLength',
  'readableObjectMode',
  'readyState',
  'reduce',
  'ref',
  'remoteAddress',
  'remoteFamily',
  'remotePort',
  'removeAllListeners',
  'removeListener',
  'resetAndDestroy',
  'resume',
  'rows',
  'server',
  'setDefaultEncoding',
  'setEncoding',
  'setKeepAlive',
  'setMaxListeners',
  'setNoDelay',
  'setTimeout',
  'setTypeOfService',
  'some',
  'take',
  'timeout',
  'toArray',
  'uncork',
  'unpipe',
  'unref',
  'unshift',
  'wrap',
  'writable',
  'writableAborted',
  'writableCorked',
  'writableEnded',
  'writableFinished',
  'writableHighWaterMark',
  'writableLength',
  'writableNeedDrain',
  'writableObjectMode',
];

/** The functions and objects of @types/node's `fs` module this interpreter does not run. */
const UNAVAILABLE_FS_MEMBERS = new Set([
  'Dir',
  'Dirent',
  'ReadStream',
  'Stats',
  'StatsFs',
  'Utf8Stream',
  'WriteStream',
  'access',
  'accessSync',
  'appendFile',
  'chmod',
  'chmodSync',
  'chown',
  'chownSync',
  'close',
  'closeSync',
  'constants',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createReadStream',
  'createWriteStream',
  'exists',
  'fchmod',
  'fchmodSync',
  'fchown',
  'fchownSync',
  'fdatasync',
  'fdatasyncSync',
  'fstat',
  'fstatSync',
  'fsync',
  'fsyncSync',
  'ftruncate',
  'ftruncateSync',
  'futimes',
  'futimesSync',
  'glob',
  'globSync',
  'lchmod',
  'lchmodSync',
  'lchown',
  'lchownSync',
  'link',
  'linkSync',
  'lstat',
  'lstatSync',
  'lutimes',
  'lutimesSync',
  'mkdir',
  'mkdtemp',
  'mkdtempDisposableSync',
  'mkdtempSync',
  'open',
  'openAsBlob',
  'openSync',
  'opendir',
  'opendirSync',
  'promises',
  'read',
  'readFile',
  'readSync',
  'readdir',
  'readlink',
  'readlinkSync',
  'readv',
  'readvSync',
  'realpath',
  'realpathSync',
  'rename',
  'rm',
  'rmSync',
  'rmdir',
  'stat',
  'statSync',
  'statfs',
  'statfsSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unwatchFile',
  'utimes',
  'utimesSync',
  'watch',
  'watchFile',
  'write',
  'writeFile',
  'writeSync',
  'writev',
  'writevSync',
]);

/**
 * The feature a member of a Node.js object names when this interpreter does not run it, by the name of the interface or
 * module declaring it: of `process`, it provides only the standard output and error streams, which only write.
 */
export function unavailableNodeMember(
  owner: string | undefined,
  name: string,
  stream: 'stdout' | 'stderr' = 'stdout'
): string | undefined {
  if (owner === 'Process' && name !== 'stdout' && name !== 'stderr') return `process.${name}`;
  if (owner === 'WriteStream') return `process.${stream}.${name}`;
  if ((owner === '"fs"' || owner === '"node:fs"') && UNAVAILABLE_FS_MEMBERS.has(name)) return `fs.${name}`;
  return undefined;
}

// oxfmt-ignore
export const NODE_LIBRARY = `
type BufferEncoding = "ascii" | "utf8" | "utf-8" | "utf16le" | "utf-16le" | "ucs2" | "ucs-2" | "base64" | "base64url" | "latin1" | "binary" | "hex";
interface Buffer extends Uint8Array {
    toString(encoding?: BufferEncoding, start?: number, end?: number): string;
}
declare var Buffer: any;
declare namespace NodeJS {
    interface WritableStream {
        write(buffer: string, cb?: (err?: Error | null) => void): boolean;
        write(str: string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
    }
    interface WriteStream extends WritableStream {
${UNAVAILABLE_STREAM_MEMBERS.map((name) => `        ${name}: any;`).join('\n')}
    }
    interface ReadStream {}
    interface Process {
        stdout: WriteStream;
        stderr: WriteStream;
        stdin: ReadStream;
        argv: string[];
        env: { [key: string]: string | undefined };
        exitCode?: number | string | undefined;
        exit(code?: number | string | null): never;
        on(event: string, listener: (...args: any[]) => void): this;
${unavailableProcessMembers.map((name) => `        ${name}: any;`).join('\n')}
    }
    interface Require {
        (id: string): any;
    }
}
declare var process: NodeJS.Process;
declare var require: NodeJS.Require;
${['fs', 'node:fs'].map((name) => `declare module "${name}" {
    type PathLike = string | Buffer | URL;
    type PathOrFileDescriptor = PathLike | number;
    type Mode = number | string;
    type WriteFileOptions = (ObjectEncodingOptions & { mode?: Mode | undefined; flag?: string | undefined; flush?: boolean | undefined }) | BufferEncoding | null;
    interface ObjectEncodingOptions {
        encoding?: BufferEncoding | null | undefined;
    }
    interface MakeDirectoryOptions {
        recursive?: boolean | undefined;
        mode?: Mode | undefined;
    }
    function readFileSync(path: PathOrFileDescriptor, options?: { encoding?: null | undefined; flag?: string | undefined } | null): Buffer;
    function readFileSync(path: PathOrFileDescriptor, options: { encoding: BufferEncoding; flag?: string | undefined } | BufferEncoding): string;
    function readFileSync(path: PathOrFileDescriptor, options?: (ObjectEncodingOptions & { flag?: string | undefined }) | BufferEncoding | null): string | Buffer;
    function writeFileSync(file: PathOrFileDescriptor, data: string, options?: WriteFileOptions): void;
    function appendFileSync(path: PathOrFileDescriptor, data: string, options?: WriteFileOptions): void;
    function existsSync(path: PathLike): boolean;
    function mkdirSync(path: PathLike, options: MakeDirectoryOptions & { recursive: true }): string | undefined;
    function mkdirSync(path: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: false | undefined }) | null): void;
    function mkdirSync(path: PathLike, options?: Mode | MakeDirectoryOptions | null): string | undefined;
    function readdirSync(path: PathLike, options?: { encoding: BufferEncoding | null; withFileTypes?: false | undefined; recursive?: boolean | undefined } | BufferEncoding | null): string[];
    function readdirSync(path: PathLike, options: { encoding: "buffer"; withFileTypes?: false | undefined; recursive?: boolean | undefined } | "buffer"): Buffer[];
    function readdirSync(path: PathLike, options?: (ObjectEncodingOptions & { withFileTypes?: false | undefined; recursive?: boolean | undefined }) | BufferEncoding | null): string[] | Buffer[];
    function readdirSync(path: PathLike, options: ObjectEncodingOptions & { withFileTypes: true; recursive?: boolean | undefined }): any[];
    function readdirSync(path: PathLike, options: { encoding: "buffer"; withFileTypes: true; recursive?: boolean | undefined }): any[];
    function unlinkSync(path: PathLike): void;
    function rmdirSync(path: PathLike): void;
    function renameSync(oldPath: PathLike, newPath: PathLike): void;
${[...UNAVAILABLE_FS_MEMBERS].map((member) => `    function ${member}(...args: any[]): any;${/^[A-Z]/.test(member) ? ` type ${member} = any;` : ''}`).join('\n')}
}`).join('\n')}
`;
