import { parseBuiltinOptions } from './builtinOptions';
import { rejectUnsupportedFeature } from './capabilities';
import type { Builtin } from './turtle';

const WAIT_USAGE = 'wait [-fn] [-p var] [id ...]';

/**
 * `wait`, which reports how background commands ended. They have all ended by the time it runs, since each runs to
 * its end when started, so it only reads their statuses: `wait id` returns one's status, as often as asked, `wait -n`
 * the next one it has not reported, and `wait` with no operand marks all of them reported.
 */
export const waitBuiltin: Builtin = (shell, args) => {
  const parsed = parseBuiltinOptions(shell, 'wait', args, 'fnp:', WAIT_USAGE);
  if (typeof parsed === 'number') return parsed;
  const { options, operands } = parsed;
  const { jobs } = shell.store;
  // A coprocess that nothing has read from yet runs now, as waiting for it lets it read its input to the end.
  for (const job of jobs.values()) job.finish?.();
  const pids: number[] = [];
  for (const operand of operands) {
    if (operand.startsWith('%')) rejectUnsupportedFeature(`ジョブ制御（wait ${operand}）`);
    if (!/^\d+$/.test(operand)) {
      shell.reportError(`wait: \`${operand}': not a pid or valid job spec`);
      return 1;
    }
    pids.push(Number(operand));
  }
  const recordPid = (pid: number): boolean => {
    const name = options.get('p');
    return name === undefined || shell.assignVariable(name, String(pid));
  };
  if (options.has('n')) {
    const candidates = pids.length > 0 ? pids : [...jobs.keys()];
    const pid = candidates.find((candidate) => jobs.get(candidate)?.reported === false);
    if (pid === undefined) return 127;
    const job = jobs.get(pid) as { status: number; reported: boolean };
    job.reported = true;
    return recordPid(pid) ? job.status : 1;
  }
  if (pids.length === 0) {
    for (const job of jobs.values()) job.reported = true;
    return 0;
  }
  let status = 0;
  for (const pid of pids) {
    const job = jobs.get(pid);
    if (!job) {
      shell.reportError(`wait: pid ${pid} is not a child of this shell`);
      status = 127;
      continue;
    }
    job.reported = true;
    status = job.status;
    if (!recordPid(pid)) status = 1;
  }
  return status;
};
