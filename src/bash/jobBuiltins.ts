import { parseBuiltinOptions } from './builtinOptions';
import { rejectUnsupportedFeature } from './capabilities';
import type { Shell } from './shell';
import type { Builtin } from './turtle';

const WAIT_USAGE = 'wait [-fn] [-p var] [id ...]';

/**
 * `wait`, which reports how background commands ended. They have all ended by the time it runs, since each runs to
 * its end when started, so it only reads their statuses: `wait id` returns one's status, as often as asked, `wait -n`
 * the next one it has not reported, and `wait` with no operand marks all of them reported.
 */
// code-gauge-allow functionCognitiveComplexity -- Waits for named jobs, the next job with `-n`, or all jobs, as the three forms of Bash `wait`.
// code-gauge-allow functionNcss -- Waits for named jobs, the next job with `-n`, or all jobs, as the three forms of Bash `wait`.
export const waitBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'wait', args, 'fnp:', WAIT_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  const { jobs } = shell.store;
  // A coprocess that nothing has read from yet runs now, as waiting for it lets it read its input to the end.
  for (const job of jobs.values()) job.finish?.();
  const pids = processIds(shell, operands);
  if (pids === undefined) return 1;
  const report = (pid: number, status: number): number => {
    const name = options.get('p');
    (jobs.get(pid) as { reported: boolean }).reported = true;
    return name === undefined || shell.assignVariable(name, String(pid)) ? status : 1;
  };
  if (options.has('n')) {
    const candidates = pids.length > 0 ? pids : [...jobs.keys()];
    const pid = candidates.find((candidate) => jobs.get(candidate)?.reported === false);
    return pid === undefined ? 127 : report(pid, (jobs.get(pid) as { status: number }).status);
  }
  if (pids.length === 0) {
    for (const job of jobs.values()) job.reported = true;
    return 0;
  }
  let status = 0;
  for (const pid of pids) {
    const job = jobs.get(pid);
    if (job) status = report(pid, job.status);
    else {
      shell.reportError(`wait: pid ${pid} is not a child of this shell`);
      status = 127;
    }
  }
  return status;
};

/** The process numbers `wait` names, or `undefined` after reporting one that is not a number. */
function processIds(shell: Shell, operands: readonly string[]): number[] | undefined {
  const pids: number[] = [];
  for (const operand of operands) {
    if (operand.startsWith('%')) rejectUnsupportedFeature(`ジョブ制御（wait ${operand}）`);
    if (!/^\d+$/.test(operand)) {
      shell.reportError(`wait: \`${operand}': not a pid or valid job spec`);
      return undefined;
    }
    pids.push(Number(operand));
  }
  return pids;
}
