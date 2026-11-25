import type { FileHandle, OutputChannel, TextReader } from '../interpreter/programIo';
import { createUtf8Decoder } from './utf8';

/**
 * What a descriptor refers to: standard input, standard output or error, or a file the program opened. Each owns the
 * uses it is open for, whether it was closed, whether a read has met its end, and the decoder that holds the bytes of
 * a partly written character, so every descriptor follows the same rules.
 */
export abstract class Stream {
  closed = false;
  /** Whether a read has met the end, which is when Zig's `File.Reader` learns the size. */
  sawEnd = false;

  constructor(readonly mode: { readonly read: boolean; readonly write: boolean }) {}

  /** Up to `limit` bytes, none at the end, or `undefined` when a read fails as the OS's fails. */
  read(limit: number, spend: (cost: number) => void): Uint8Array | undefined {
    const bytes = this.readBytes(limit, spend);
    if (bytes?.length === 0 && limit > 0) this.sawEnd = true;
    return bytes;
  }

  /** Whether reading would give no more bytes. */
  atEnd(): boolean {
    return true;
  }

  write(bytes: readonly number[]): void {
    void bytes;
  }

  /** Writes what the decoder holds, at close or when the program ends. */
  finish(): void {}

  protected readBytes(limit: number, spend: (cost: number) => void): Uint8Array | undefined {
    void limit;
    void spend;
    return undefined;
  }
}

/** Standard input, read as UTF-8 bytes of the run's input text. */
export class InputStream extends Stream {
  private bytes: Uint8Array | undefined;
  private position = 0;

  constructor(private readonly reader: TextReader) {
    super({ read: true, write: false });
  }

  override atEnd(): boolean {
    return this.position >= this.content().length;
  }

  protected override readBytes(limit: number, spend: (cost: number) => void): Uint8Array {
    const bytes = this.content().subarray(this.position, this.position + limit);
    this.position += bytes.length;
    spend(Math.ceil((bytes.length + 1) / 64));
    return bytes;
  }

  private content(): Uint8Array {
    this.bytes ??= new TextEncoder().encode(this.reader.readRest());
    return this.bytes;
  }
}

/** Standard output or error, whose bytes are written as the text they decode to. */
export class OutputStream extends Stream {
  private readonly decoder = createUtf8Decoder();

  constructor(private readonly sink: OutputChannel) {
    super({ read: false, write: true });
  }

  override write(bytes: readonly number[]): void {
    this.sink.write(this.decoder.decode(new Uint8Array(bytes), { stream: true }));
  }

  override finish(): void {
    this.sink.write(this.decoder.decode());
  }
}

/** A file that the program opened, which reads the file's text as UTF-8 bytes and writes the text its bytes decode to. */
export interface OpenFile {
  /** The text of the file the descriptor refers to, which follows the file after a rename or a deletion. */
  content: () => string;
  read?: () => string;
  /** Whether the descriptor refers to a directory, which opens for reading but fails each read, as the OS's do. */
  readonly directory?: boolean;
  write?: FileHandle;
}

/**
 * An open file. The run's files hold text, so bytes that are not UTF-8 end the program, through `onInvalidText`,
 * instead of turning into U+FFFD.
 */
export class FileStream extends Stream {
  /** How many bytes of the file reading has passed. */
  private position = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  constructor(
    readonly file: OpenFile,
    private readonly onInvalidText: () => never
  ) {
    super({ read: file.read !== undefined || file.directory === true, write: file.write !== undefined });
  }

  override atEnd(): boolean {
    return this.position >= this.bytes().length;
  }

  override write(bytes: readonly number[]): void {
    this.writeText(() => this.decoder.decode(new Uint8Array(bytes), { stream: true }));
  }

  override finish(): void {
    this.writeText(() => this.decoder.decode());
  }

  protected override readBytes(limit: number, spend: (cost: number) => void): Uint8Array | undefined {
    if (this.file.directory) return undefined;
    const content = this.bytes();
    const bytes = content.subarray(this.position, this.position + limit);
    this.position += bytes.length;
    spend(Math.ceil((content.length + 1) / 64));
    return bytes;
  }

  private bytes(): Uint8Array {
    return new TextEncoder().encode(this.file.read?.() ?? '');
  }

  private writeText(decode: () => string): void {
    if (!this.file.write) return;
    let text: string;
    try {
      text = decode();
    } catch {
      return this.onInvalidText();
    }
    this.file.write.write(text);
  }
}
