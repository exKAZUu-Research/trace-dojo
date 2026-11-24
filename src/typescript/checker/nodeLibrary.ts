// Declarations of the Node.js features this interpreter runs, as @types/node declares them, which a program reads
// standard input and files with. Derived from DefinitelyTyped's @types/node (MIT License).
// oxfmt-ignore
export const NODE_LIBRARY = `
type BufferEncoding = "ascii" | "utf8" | "utf-8" | "utf16le" | "utf-16le" | "ucs2" | "ucs-2" | "base64" | "base64url" | "latin1" | "binary" | "hex";
interface Buffer extends Uint8Array {
    toString(encoding?: BufferEncoding, start?: number, end?: number): string;
}
declare var Buffer: any;
declare namespace NodeJS {
    interface WritableStream {
        write(buffer: Uint8Array | string, cb?: (err?: Error | null) => void): boolean;
        write(str: string, encoding?: BufferEncoding, cb?: (err?: Error | null) => void): boolean;
    }
    interface WriteStream extends WritableStream {}
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
    interface RmDirOptions {
        maxRetries?: number | undefined;
        recursive?: boolean | undefined;
        retryDelay?: number | undefined;
    }
    function readFileSync(path: PathOrFileDescriptor, options?: { encoding?: null | undefined; flag?: string | undefined } | null): Buffer;
    function readFileSync(path: PathOrFileDescriptor, options: { encoding: BufferEncoding; flag?: string | undefined } | BufferEncoding): string;
    function readFileSync(path: PathOrFileDescriptor, options?: (ObjectEncodingOptions & { flag?: string | undefined }) | BufferEncoding | null): string | Buffer;
    function writeFileSync(file: PathOrFileDescriptor, data: string | ArrayBufferView, options?: WriteFileOptions): void;
    function appendFileSync(path: PathOrFileDescriptor, data: string | Uint8Array, options?: WriteFileOptions): void;
    function existsSync(path: PathLike): boolean;
    function mkdirSync(path: PathLike, options: MakeDirectoryOptions & { recursive: true }): string | undefined;
    function mkdirSync(path: PathLike, options?: Mode | (MakeDirectoryOptions & { recursive?: false | undefined }) | null): void;
    function mkdirSync(path: PathLike, options?: Mode | MakeDirectoryOptions | null): string | undefined;
    function readdirSync(path: PathLike, options?: { encoding: BufferEncoding | null; withFileTypes?: false | undefined; recursive?: boolean | undefined } | BufferEncoding | null): string[];
    function unlinkSync(path: PathLike): void;
    function rmdirSync(path: PathLike, options?: RmDirOptions): void;
    function renameSync(oldPath: PathLike, newPath: PathLike): void;
}`).join('\n')}
`;
