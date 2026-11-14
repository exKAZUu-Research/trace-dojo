// `lzma_code` of liblzma 5.8.4 (`common.c`), over the input and output buffers of a `ZStream`.
import {
  type Coder,
  LZMA_BUF_ERROR,
  LZMA_FINISH,
  LZMA_GET_CHECK,
  LZMA_MEMLIMIT_ERROR,
  LZMA_NO_CHECK,
  LZMA_OK,
  LZMA_PROG_ERROR,
  LZMA_RUN,
  LZMA_STREAM_END,
  LZMA_UNSUPPORTED_CHECK,
} from './xzCommon';
import type { TopDecoder } from './xzDecoders';
import type { ZStream } from './zlibDeflate';

const ISEQ_RUN = 0;
const ISEQ_FINISH = 3;
const ISEQ_END = 5;
const ISEQ_ERROR = 6;

/** `lzma_stream` with its `lzma_internal`, as CPython drives it: with `LZMA_RUN` and then `LZMA_FINISH` only. */
export class LzmaStream {
  private sequence = ISEQ_RUN;
  private allowBufError = false;
  private internalAvailIn = 0;

  constructor(
    readonly strm: ZStream,
    private readonly next: Coder & Partial<TopDecoder>
  ) {}

  /** `lzma_get_check`. */
  getCheck(): number {
    return this.next.getCheck?.() ?? 0;
  }

  // code-gauge-allow functionNcss 39 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  // code-gauge-allow functionCognitiveComplexity 22 -- Transcribes liblzma 5.8.4 statement by statement, keeping it comparable with the C.
  code(action: number): number {
    const { strm } = this;
    if (this.sequence === ISEQ_RUN) {
      if (action === LZMA_FINISH) this.sequence = ISEQ_FINISH;
    } else if (this.sequence === ISEQ_FINISH) {
      if (action !== LZMA_FINISH || this.internalAvailIn !== strm.availIn) return LZMA_PROG_ERROR;
    } else if (this.sequence === ISEQ_END) {
      return LZMA_STREAM_END;
    } else {
      return LZMA_PROG_ERROR;
    }
    const inPos = { value: strm.nextIn };
    const outPos = { value: strm.nextOut };
    let ret = this.next.code(
      strm.input,
      inPos,
      strm.nextIn + strm.availIn,
      strm.output,
      outPos,
      strm.nextOut + strm.availOut,
      action === LZMA_FINISH ? LZMA_FINISH : LZMA_RUN
    );
    const inUsed = inPos.value - strm.nextIn;
    const outUsed = outPos.value - strm.nextOut;
    Object.assign(strm, {
      nextIn: inPos.value,
      availIn: strm.availIn - inUsed,
      totalIn: strm.totalIn + inUsed,
      nextOut: outPos.value,
      availOut: strm.availOut - outUsed,
      totalOut: strm.totalOut + outUsed,
    });
    this.internalAvailIn = strm.availIn;
    if (ret === LZMA_OK) {
      if (outUsed === 0 && inUsed === 0) {
        if (this.allowBufError) ret = LZMA_BUF_ERROR;
        else this.allowBufError = true;
      } else {
        this.allowBufError = false;
      }
    } else if (ret === LZMA_STREAM_END) {
      this.sequence = ISEQ_END;
      this.allowBufError = false;
    } else if ([LZMA_NO_CHECK, LZMA_UNSUPPORTED_CHECK, LZMA_GET_CHECK, LZMA_MEMLIMIT_ERROR].includes(ret)) {
      this.allowBufError = false;
    } else {
      this.sequence = ISEQ_ERROR;
    }
    return ret;
  }
}
