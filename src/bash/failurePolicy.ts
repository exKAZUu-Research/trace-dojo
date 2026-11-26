import type { OutputTarget } from './descriptors';
import { DiscardSignal, ExitSignal, SCRIPT_NAME } from './runtime';

export type FailureContext =
  | 'scriptAssignment'
  | 'commandPrefix'
  | 'expansion'
  | 'fatalReadonlyArithmetic'
  | 'arithmeticCommand'
  | 'letBuiltin'
  | 'conditional'
  | 'forHeader'
  | 'declarationGlobalCompound'
  | 'declarationLocalCompound'
  /**
   * A declaration builtin's compound value without `-a` or `-A`, which it assigns as a plain array assignment does, so
   * that a failure abandons the line and a readonly error ends the shell under `set -e`.
   */
  | 'arrayAssignment'
  | 'declarationOperand'
  /** `readonly` or `export` assigning a scalar as a plain assignment does, whose readonly error `set -e` ends at. */
  | 'builtinAssignment'
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
    private readonly fd2: () => OutputTarget,
    /** Whether `set -e` is on, under which the errors Bash reports with its `report_error` end the shell. */
    private readonly exitsOnError: () => boolean
  ) {}

  report(message: string): void {
    this.fd2().write(`${SCRIPT_NAME}: line ${this.currentLine()}: ${message}\n`);
  }

  /**
   * Reports an error as Bash's `report_error` does, which ends the shell under `set -e` wherever the command runs,
   * even where a failed status would not: a readonly variable, a bad subscript or substitution, or no glob match.
   */
  reportFatal(message: string): void {
    this.report(message);
    if (this.exitsOnError()) throw new ExitSignal(1);
  }

  /**
   * Reports an error and abandons the rest of the line. `recoverable` marks the errors that `set -e` lets the
   * shell go on after, which Bash reports otherwise: arithmetic errors and a builtin's bad operands.
   */
  discard(message: string, status = 1, recoverable = false): never {
    if (recoverable) this.report(message);
    else this.reportFatal(message);
    throw new DiscardSignal(status);
  }

  /** Handles a `StoreFailure` according to the enclosing `FailureContext`, returning `false` when execution continues. */
  handleStoreFailure(context: FailureContext, failure: StoreFailure, builtinPrefix?: string): false {
    if (!failure.alreadyReported && failure.message !== '') {
      const prefixed = builtinPrefix ? `${builtinPrefix}: ${failure.message}` : failure.message;
      this.report(prefixed);
    }
    if (isReportedAsShellError(context, failure, builtinPrefix) && this.exitsOnError()) throw new ExitSignal(1);
    switch (context) {
      case 'parameterRequire': {
        throw new ExitSignal(1, true);
      }
      case 'fatalReadonlyArithmetic':
      case 'scriptAssignment':
      case 'expansion':
      case 'declarationGlobalCompound':
      case 'arrayAssignment': {
        throw new DiscardSignal(1);
      }
      case 'declarationLocalCompound': {
        if (failure.reason === 'badSubscript') throw new DiscardSignal(1);
        return false;
      }
      case 'commandPrefix':
      case 'arithmeticCommand':
      case 'letBuiltin':
      case 'conditional':
      case 'forHeader':
      case 'declarationOperand':
      case 'builtinAssignment':
      case 'regularBuiltin': {
        return false;
      }
    }
  }
}

/**
 * Whether Bash reports a store failure with its `report_error`, which `set -e` makes fatal: a bad subscript, or an
 * assignment to a readonly variable, except where `unset` or a declaration builtin's operand reports it.
 */
function isReportedAsShellError(context: FailureContext, failure: StoreFailure, builtinPrefix?: string): boolean {
  if (builtinPrefix === 'unset') return false;
  if (failure.reason === 'badSubscript') return true;
  return failure.reason === 'readonly' && !context.startsWith('declaration');
}
