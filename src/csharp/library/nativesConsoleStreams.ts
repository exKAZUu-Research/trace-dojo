import type { OutputChannel, TextReader } from '../../interpreter/programIo';
import { defineNatives, type NativeCall } from '../natives';
import { CsObject } from '../values';
import type { StreamState } from './nativesStreams';
import { fail, libraryType } from './support';

/**
 * The streams of `Console.OpenStandardOutput`, `OpenStandardError`, and `OpenStandardInput`, which write their bytes
 * to the console as they come, decoded as UTF-8, and read standard input's text as its UTF-8 bytes. They cannot seek.
 */

const NOT_SEEKABLE = 'Stream does not support seeking.';

class ConsoleStreamState implements StreamState {
  readonly name = 'ConsoleStream';
  readonly canSeek = false;
  isClosed = false;
  private readonly decoder = new TextDecoder('utf-8');
  /** The bytes of standard input's text read ahead and not yet handed out. */
  private unread = new Uint8Array(0);

  constructor(
    private readonly channel: OutputChannel | undefined,
    private readonly input: TextReader | undefined
  ) {}

  get canRead(): boolean {
    return this.input !== undefined;
  }

  get canWrite(): boolean {
    return this.channel !== undefined;
  }

  get length(): number {
    return fail('System.NotSupportedException', NOT_SEEKABLE);
  }

  get position(): number {
    return fail('System.NotSupportedException', NOT_SEEKABLE);
  }

  set position(_value: number) {
    fail('System.NotSupportedException', NOT_SEEKABLE);
  }

  read(_call: NativeCall, count: number): Uint8Array {
    const input = this.input as TextReader;
    if (this.unread.length === 0 && !input.isAtEnd) {
      this.unread = new TextEncoder().encode(input.text.slice(input.position));
      input.position = input.text.length;
    }
    const read = this.unread.subarray(0, count);
    this.unread = this.unread.subarray(read.length);
    return read;
  }

  write(_call: NativeCall, bytes: readonly number[]): void {
    const text = this.decoder.decode(Uint8Array.from(bytes), { stream: true });
    if (text !== '') this.channel?.write(text);
  }

  writeByte(call: NativeCall, byte: number): void {
    this.write(call, [byte]);
  }

  flush(): void {}

  seek(): number {
    return fail('System.NotSupportedException', NOT_SEEKABLE);
  }

  close(): void {
    this.isClosed = true;
  }
}

function consoleStream(call: NativeCall, state: ConsoleStreamState): CsObject {
  const stream = new CsObject(libraryType(call, 'System.IO.Stream'), []);
  stream.native = state;
  return stream;
}

defineNatives({
  'System.Console.OpenStandardOutput': (call) =>
    consoleStream(call, new ConsoleStreamState(call.frame.runtime.io.stdout, undefined)),
  'System.Console.OpenStandardError': (call) =>
    consoleStream(call, new ConsoleStreamState(call.frame.runtime.io.stderr, undefined)),
  'System.Console.OpenStandardInput': (call) =>
    consoleStream(call, new ConsoleStreamState(undefined, call.frame.runtime.io.stdin.reader)),
});
