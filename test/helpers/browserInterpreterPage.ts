import { createInterpreterRunner, type InterpreterRunner } from '../../src/interpreter/worker/interpreterRunner';

declare global {
  var createRunner: () => InterpreterRunner;
}

globalThis.createRunner = () =>
  createInterpreterRunner(() => new Worker('/src/interpreter/worker/interpreterWorker.js', { type: 'module' }));
