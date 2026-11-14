import { runtimeErrorPanic } from './runtimeErrors';

export class RangeProtocol {
  private state: 'ready' | 'active' | 'stopped' | 'exited' = 'ready';

  enter(): void {
    switch (this.state) {
      case 'ready': {
        this.state = 'active';
        return;
      }
      case 'active': {
        runtimeErrorPanic('range function continued iteration after loop body panic');
      }
      case 'stopped': {
        runtimeErrorPanic('range function continued iteration after function for loop body returned false');
      }
      case 'exited': {
        runtimeErrorPanic('range function continued iteration after whole loop exit');
      }
    }
  }

  complete(keepGoing: boolean): void {
    this.state = keepGoing ? 'ready' : 'stopped';
  }

  returned(): void {
    if (this.state === 'active')
      runtimeErrorPanic('range function recovered a loop body panic and did not resume panicking');
  }

  exit(): void {
    this.state = 'exited';
  }
}
