import { browserReadyInterpreters } from '../browserReadyInterpreters';
import { type Interpreter, traceWith } from '../interpreter';
import { type InterpreterRequest, type InterpreterResponse, transferredErrorOf } from './protocol';

// The entry of the Web Worker that `createInterpreterRunner` drives.

globalThis.addEventListener('message', (event: MessageEvent<InterpreterRequest>) => {
  void handle(event.data);
});

async function handle(request: InterpreterRequest): Promise<void> {
  let interpreter: Interpreter | undefined;
  try {
    ({ interpreter } = await browserReadyInterpreters[request.language]());
    respond({ type: 'started' });
    respond({
      type: 'finished',
      result:
        request.kind === 'trace'
          ? traceWith(interpreter, request.program, request.displayProgram, request.input)
          : interpreter.execute(request.source, request.input),
    });
  } catch (error) {
    respond({
      type: 'failed',
      error: transferredErrorOf(error),
      loaded: interpreter !== undefined,
    });
  }
}

function respond(response: InterpreterResponse): void {
  globalThis.postMessage(response);
}
