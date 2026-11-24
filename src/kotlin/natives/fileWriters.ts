import type { FileHandle } from '../../interpreter/programIo';
import type { Frame } from '../runtime';

/**
 * The size of `BufferedWriter`'s buffer and the largest buffer of the encoder of `OutputStreamWriter`, as in the Java
 * interpreter's `java.io` writers, whose rules these follow for the text that Kotlin's writers write.
 */
const BUFFER_SIZE = 8192;

/** The buffer that the encoder of `OutputStreamWriter` starts with. */
const ENCODER_START = 512;

/**
 * The writer that `File.bufferedWriter()` builds, and that `File.printWriter()` wraps: a `BufferedWriter` over an
 * `OutputStreamWriter` over the file. Text reaches the file only when a buffer overflows, or at `flush` and `close`,
 * so a program that never closes its writer loses what it wrote, as on the JVM.
 */
export class BufferedFileWriter {
  private buffered = '';
  private encoded = '';
  private encoderCapacity = ENCODER_START;
  private closed = false;

  constructor(private readonly handle: FileHandle) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** `BufferedWriter.write(String)`, which fills its buffer and passes it on each time it is full. */
  write(frame: Frame, text: string): void {
    for (let offset = 0; offset < text.length;) {
      const end = offset + BUFFER_SIZE - this.buffered.length;
      this.buffer(frame, text.slice(offset, end));
      offset = end;
      if (this.buffered.length >= BUFFER_SIZE) this.passOnBuffered(frame);
    }
  }

  flush(frame: Frame): void {
    this.passOnBuffered(frame);
    this.passOnEncoded();
  }

  close(frame: Frame): void {
    if (this.closed) return;
    try {
      this.flush(frame);
    } finally {
      this.closed = true;
    }
  }

  private buffer(frame: Frame, text: string): void {
    frame.runtime.allocateString(frame, this.buffered.length + text.length, text.length);
    this.buffered += text;
  }

  /** OpenJDK's `StreamEncoder`, whose buffer grows, after passing on what it holds, when a write may encode to more. */
  private passOnBuffered(frame: Frame): void {
    const text = this.buffered;
    if (text === '') return;
    this.buffered = '';
    const wanted = Math.min(text.length * 3, BUFFER_SIZE);
    if (wanted > this.encoderCapacity) {
      this.passOnEncoded();
      this.encoderCapacity = wanted;
    }
    for (let offset = 0; offset < text.length;) {
      if (this.encoded.length >= this.encoderCapacity) this.passOnEncoded();
      const end = offset + this.encoderCapacity - this.encoded.length;
      frame.runtime.allocateString(frame, this.encoded.length + end - offset, end - offset);
      this.encoded += text.slice(offset, end);
      offset = end;
    }
  }

  private passOnEncoded(): void {
    if (this.encoded === '') return;
    this.handle.write(this.encoded);
    this.encoded = '';
  }
}
