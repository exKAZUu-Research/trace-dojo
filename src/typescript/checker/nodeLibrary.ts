import {
  UNAVAILABLE_FS_MEMBERS,
  UNAVAILABLE_STREAM_MEMBERS,
  UNAVAILABLE_UNTYPED_PROCESS_MEMBERS,
} from '../../javascript/unavailableNodeMembers';

// Declarations of the Node.js features this interpreter runs, as @types/node declares them, which a program reads
// standard input and files with. Derived from DefinitelyTyped's @types/node 26.6.7 (MIT License), whose other members of
// `process`, its streams, and `fs` are declared too, only so that a program using one is told it is unavailable. Data
// written is a string only, as typed arrays are unavailable here.

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

const FS_VALUE_EXPORTS = new Set([
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'existsSync',
  'mkdirSync',
  'readdirSync',
  'unlinkSync',
  'rmdirSync',
  'renameSync',
  ...UNAVAILABLE_FS_MEMBERS,
]);

const FS_TYPE_EXPORTS = new Set([
  'PathLike',
  'PathOrFileDescriptor',
  'Mode',
  'WriteFileOptions',
  'ObjectEncodingOptions',
  'MakeDirectoryOptions',
  ...[...UNAVAILABLE_FS_MEMBERS].filter((member) => /^[A-Z]/.test(member)),
]);

/** Which symbol spaces (`value`, `type`) an export of `"fs"` or `"node:fs"` inhabits, or undefined for an unknown name. */
export function fsImportMeanings(
  moduleName: string,
  exportName: string
): { value: boolean; type: boolean } | undefined {
  if (moduleName !== 'fs' && moduleName !== 'node:fs') return undefined;
  if (exportName === '*' || exportName === 'default') return { value: true, type: false };
  const value = FS_VALUE_EXPORTS.has(exportName);
  const type = FS_TYPE_EXPORTS.has(exportName);
  return value || type ? { value, type } : undefined;
}

// oxfmt-ignore
export const NODE_LIBRARY = `
type BufferEncoding = "ascii" | "utf8" | "utf-8" | "utf16le" | "utf-16le" | "ucs2" | "ucs-2" | "base64" | "base64url" | "latin1" | "binary" | "hex";
interface Buffer extends Uint8Array {
    toString(encoding?: BufferEncoding, start?: number, end?: number): string;
}
declare var Buffer: any;
declare namespace NodeJS {
    interface ErrnoException extends Error {
        errno?: number;
        code?: string;
        path?: string;
        syscall?: string;
    }
    interface WritableStream {
        write(buffer: string, cb?: (err?: Error | null) => void): boolean;
        write(str: string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
    }
    interface WriteStream extends WritableStream {
${[...UNAVAILABLE_STREAM_MEMBERS].map((name) => `        ${name}: any;`).join('\n')}
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
${UNAVAILABLE_UNTYPED_PROCESS_MEMBERS.map((name) => `        ${name}: any;`).join('\n')}
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
