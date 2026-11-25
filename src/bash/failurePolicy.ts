import { DiscardSignal, ExitSignal, type OutputTarget, SCRIPT_NAME } from './runtime';

export type FailureContext =
  | 'scriptAssignment'
  | 'commandPrefix'
  | 'expansion'
  | 'fatalReadonlyArithmetic'
  | 'arithmeticCommand'
  | 'letBuiltin'
  | 'conditional'
  | 'forHeader'
  | 'declarationCompoundPhase1'
  | 'declarationFunctionCompoundPhase1'
  | 'declarationOperand'
  | 'declarationFatalBuiltin'
  | 'regularBuiltin'
  | 'parameterRequire';

export type StoreFailureReason =
  | 'readonly'
  | 'invalidIdentifier'
  | 'badSubscript'
  | 'notArray'
  | 'cannotAssign'
  | 'incompatibleArray'
  | 'arithmetic';

export interface StoreFailure {
  readonly ok: false;
  readonly reason: StoreFailureReason;
  readonly message: string;
  /** Whether a diagnostic has already been emitted by a nested evaluation. */
  readonly alreadyReported?: boolean;
}

export type StoreOutcome = { readonly ok: true; readonly stored: string } | StoreFailure;

/**
 * Single policy dispatcher mapping failures to diagnostics, status updates, line abandonment, or shell exit.
 */
export class FailurePolicy {
  constructor(
    private readonly currentLine: () => number,
    private readonly fd2: () => OutputTarget
  ) {}

  report(message: string): void {
    this.fd2().write(`${SCRIPT_NAME}: line ${this.currentLine()}: ${message}\n`);
  }

  discard(message: string, status = 1): never {
    this.report(message);
    throw new DiscardSignal(status);
  }

  exitWithMessage(message: string, status = 1): never {
    this.report(message);
    throw new ExitSignal(status);
  }

  /** Handles a `StoreFailure` according to the enclosing `FailureContext`, returning `false` when execution continues. */
  handleStoreFailure(context: FailureContext, failure: StoreFailure, builtinPrefix?: string): false {
    if (!failure.alreadyReported && failure.message !== '') {
      const prefixed = builtinPrefix ? `${builtinPrefix}: ${failure.message}` : failure.message;
      this.report(prefixed);
    }
    switch (context) {
      case 'parameterRequire': {
        throw new ExitSignal(1);
      }
      case 'fatalReadonlyArithmetic': {
        if (failure.reason === 'readonly') throw new ExitSignal(1);
        throw new DiscardSignal(1);
      }
      case 'scriptAssignment':
      case 'expansion':
      case 'declarationCompoundPhase1': {
        throw new DiscardSignal(1);
      }
      case 'declarationFatalBuiltin': {
        if (failure.reason === 'readonly') throw new DiscardSignal(1);
        return false;
      }
      case 'commandPrefix':
      case 'arithmeticCommand':
      case 'letBuiltin':
      case 'conditional':
      case 'forHeader':
      case 'declarationFunctionCompoundPhase1':
      case 'declarationOperand':
      case 'regularBuiltin': {
        return false;
      }
    }
  }
}
