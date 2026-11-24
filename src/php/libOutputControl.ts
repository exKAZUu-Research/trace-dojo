// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
import { callableClosureName, explainCallable } from './callables';
import { notice, warn } from './errors';
import { defineConstant, defineFunction } from './native';
import {
  bufferStatus,
  cleanBuffer,
  flushBuffer,
  HANDLER_CLEANABLE,
  HANDLER_DISABLED,
  HANDLER_FLUSHABLE,
  HANDLER_PROCESSED,
  HANDLER_REMOVABLE,
  HANDLER_STARTED,
  HANDLER_STDFLAGS,
  OUTPUT_CLEAN,
  OUTPUT_FINAL,
  OUTPUT_FLUSH,
  OUTPUT_START,
  OUTPUT_WRITE,
  type OutputBuffer,
  popBuffer,
  runOperation,
  startBuffer,
} from './outputControl';
import { rt } from './runtime';
import { isClosure, PhpArray, PhpObject, type Value } from './values';

const outputConstants: [string, number][] = [
  ['PHP_OUTPUT_HANDLER_START', OUTPUT_START],
  ['PHP_OUTPUT_HANDLER_WRITE', OUTPUT_WRITE],
  ['PHP_OUTPUT_HANDLER_FLUSH', OUTPUT_FLUSH],
  ['PHP_OUTPUT_HANDLER_CLEAN', OUTPUT_CLEAN],
  ['PHP_OUTPUT_HANDLER_FINAL', OUTPUT_FINAL],
  ['PHP_OUTPUT_HANDLER_CONT', OUTPUT_WRITE],
  ['PHP_OUTPUT_HANDLER_END', OUTPUT_FINAL],
  ['PHP_OUTPUT_HANDLER_CLEANABLE', HANDLER_CLEANABLE],
  ['PHP_OUTPUT_HANDLER_FLUSHABLE', HANDLER_FLUSHABLE],
  ['PHP_OUTPUT_HANDLER_REMOVABLE', HANDLER_REMOVABLE],
  ['PHP_OUTPUT_HANDLER_STDFLAGS', HANDLER_STDFLAGS],
  ['PHP_OUTPUT_HANDLER_STARTED', HANDLER_STARTED],
  ['PHP_OUTPUT_HANDLER_DISABLED', HANDLER_DISABLED],
  ['PHP_OUTPUT_HANDLER_PROCESSED', HANDLER_PROCESSED],
];
for (const [name, value] of outputConstants) defineConstant(name, BigInt(value));

const DEFAULT_HANDLER_NAME = 'default output handler';

defineFunction(
  'ob_start($callback = null, int $chunk_size = 0, int $flags = PHP_OUTPUT_HANDLER_STDFLAGS): bool',
  ({ args }) => {
    const runtime = rt();
    const handler = args[0] ?? null;
    const chunkSize = Math.max(Number(args[1] ?? 0n), 0);
    const flags = Number(args[2] ?? BigInt(HANDLER_STDFLAGS));
    if (handler !== null) {
      const problem = explainCallable(handler);
      if (problem) {
        warn(`ob_start(): ${problem}`);
        notice('ob_start(): Failed to create buffer');
        return false;
      }
    }
    runOperation(() =>
      startBuffer(
        runtime,
        handler === null ? DEFAULT_HANDLER_NAME : handlerName(handler),
        handler ?? undefined,
        chunkSize,
        flags
      )
    );
    return true;
  }
);

/** The name PHP gives a callable in `ob_list_handlers` and its messages. */
function handlerName(handler: Value): string {
  if (typeof handler === 'string') return handler;
  if (handler instanceof PhpObject)
    return isClosure(handler) ? callableClosureName(handler) : `${handler.cls.fullName}::__invoke`;
  if (handler instanceof PhpArray) {
    const owner = handler.get(0n);
    const method = handler.get(1n) as string;
    return `${typeof owner === 'string' ? owner : (owner as PhpObject).cls.fullName}::${method}`;
  }
  return '';
}

defineFunction('ob_flush(): bool', () => {
  const runtime = rt();
  const buffer = runtime.outputBuffers.at(-1);
  if (!buffer) {
    notice('ob_flush(): Failed to flush buffer. No buffer to flush');
    return false;
  }
  if (!runOperation(() => flushBuffer(runtime))) {
    notice(`ob_flush(): Failed to flush buffer of ${buffer.name} (${buffer.level})`);
    return false;
  }
  return true;
});

defineFunction('ob_clean(): bool', () => {
  const runtime = rt();
  const buffer = runtime.outputBuffers.at(-1);
  if (!buffer) {
    notice('ob_clean(): Failed to delete buffer. No buffer to delete');
    return false;
  }
  if (!runOperation(() => cleanBuffer(runtime))) {
    notice(`ob_clean(): Failed to delete buffer of ${buffer.name} (${buffer.level})`);
    return false;
  }
  return true;
});

defineFunction('ob_end_flush(): bool', () => {
  const runtime = rt();
  if (runtime.outputBuffers.length === 0) {
    notice('ob_end_flush(): Failed to delete and flush buffer. No buffer to delete or flush');
    return false;
  }
  return runOperation(() => popBuffer(runtime, { discard: false, functionName: 'ob_end_flush' }));
});

defineFunction('ob_end_clean(): bool', () => {
  const runtime = rt();
  if (runtime.outputBuffers.length === 0) {
    notice('ob_end_clean(): Failed to delete buffer. No buffer to delete');
    return false;
  }
  return runOperation(() => popBuffer(runtime, { discard: true, functionName: 'ob_end_clean' }));
});

defineFunction('ob_get_flush(): string|false', () => {
  const runtime = rt();
  const buffer = runtime.outputBuffers.at(-1);
  if (!buffer) {
    notice('ob_get_flush(): Failed to delete and flush buffer. No buffer to delete or flush');
    return false;
  }
  const contents = buffer.data;
  if (!runOperation(() => popBuffer(runtime, { discard: false, functionName: 'ob_get_flush' })))
    notice(`ob_get_flush(): Failed to delete buffer of ${buffer.name} (${buffer.level})`);
  return contents;
});

defineFunction('ob_get_clean(): string|false', () => {
  const runtime = rt();
  const buffer = runtime.outputBuffers.at(-1);
  if (!buffer) return false;
  const contents = buffer.data;
  if (!runOperation(() => popBuffer(runtime, { discard: true, functionName: 'ob_get_clean' })))
    notice(`ob_get_clean(): Failed to delete buffer of ${buffer.name} (${buffer.level})`);
  return contents;
});

defineFunction('ob_get_contents(): string|false', () => rt().outputBuffers.at(-1)?.data ?? false);

defineFunction('ob_get_level(): int', () => BigInt(rt().outputBuffers.length));

defineFunction('ob_get_length(): int|false', () => {
  const buffer = rt().outputBuffers.at(-1);
  return buffer ? BigInt(buffer.data.length) : false;
});

defineFunction('ob_list_handlers(): array', () => PhpArray.list(rt().outputBuffers.map((buffer) => buffer.name)));

defineFunction('ob_get_status(bool $full_status = false): array', ({ args }) => {
  const buffers = rt().outputBuffers;
  if (buffers.length === 0) return new PhpArray();
  if (args[0] === true) return PhpArray.list(buffers.map((buffer) => statusArray(buffer)));
  return statusArray(buffers.at(-1)!);
});

function statusArray(buffer: OutputBuffer): PhpArray {
  const array = new PhpArray();
  for (const [key, value] of bufferStatus(buffer)) array.set(key, value);
  return array;
}

// PHP's CLI flushes every write to standard output, so these change nothing the program can observe.
defineFunction('ob_implicit_flush(bool $enable = true): void', () => null);
defineFunction('flush(): void', () => null);
