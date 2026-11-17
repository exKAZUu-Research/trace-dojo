import { def } from './define';
import { rubyError } from './errors';
import { callProc, type Gen, requireBlock } from './interp';
import type { RProc } from './objects';
import { ExitSignal, ReturnSignal, rt, RubyError, UnsupportedFeatureError } from './runtime';

def(
  'Kernel',
  'at_exit',
  0,
  (_self, _args, block) => {
    const proc = requireBlock(block, rt().c.ArgumentError, 'called without a block');
    rt().atExit.push(proc);
    return proc;
  },
  { visibility: 'private' }
);

export function* runAtExit(): Gen<(RubyError | ExitSignal | UnsupportedFeatureError)[]> {
  const runtime = rt();
  const errors: (RubyError | ExitSignal | UnsupportedFeatureError)[] = [];
  while (runtime.atExit.length > 0) {
    const handler = runtime.atExit.pop() as RProc;
    runtime.completedExitHandlers.push(handler);
    try {
      yield* callProc(handler, [], { used: false });
    } catch (error) {
      let failure = error;
      if (failure instanceof ReturnSignal) {
        const converted = rubyError(runtime.c.LocalJumpError, 'unexpected return');
        converted.exception.internal = new Map([['hookReturn', true]]);
        failure = converted;
      }
      if (failure instanceof RubyError) runtime.globals.set('$!', failure.exception);
      else if (!(failure instanceof ExitSignal) && !(failure instanceof UnsupportedFeatureError)) throw failure;
      errors.push(failure);
    }
  }
  return errors;
}
