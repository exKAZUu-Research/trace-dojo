import { isVariableReference } from './arithmetic';
import { parseBuiltinOptions } from './builtinOptions';
import { rejectUnsupportedFeature } from './capabilities';
import type { Shell } from './shell';
import type { Builtin } from './turtle';
import { isIdentifier } from './variables';

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
  const pids = processIds(shell, operands);
  if (pids === undefined) return 1;
  const pidName = options.get('p');
  if (pidName !== undefined && !clearPidVariable(shell, pidName)) return 1;
  const targetPids = pids.length > 0 ? pids : [...jobs.keys()];
  const reaped = settleCoprocesses(shell, targetPids, options.has('n'));
  const forgetReaped = (): void => {
    for (const pid of reaped) jobs.delete(pid);
  };
  // A `>(...)` is waited for when named, or with no operand when `$!` is still its process ID, as Bash 5.3 does.
  const awaited = pids.length > 0 ? pids : [shell.store.lastBackgroundPid].filter((pid) => pid !== undefined);
  for (const pid of awaited) jobs.get(pid)?.awaitEnd?.();
  const report = (pid: number, status: number): number => {
    const name = options.get('p');
    (jobs.get(pid) as { reported: boolean }).reported = true;
    return name === undefined || shell.assignVariable(name, String(pid)) ? status : 1;
  };
  if (options.has('n')) {
    const candidates = pids.length > 0 ? pids : [...jobs.keys()];
    const pid = candidates.find(
      (candidate) => jobs.get(candidate)?.reported === false && !jobs.get(candidate)?.waiting
    );
    if (pid === undefined) return 127;
    // The coprocess it reports is reaped as well, which unsets its variables.
    jobs.get(pid)?.dispose?.();
    return report(pid, (jobs.get(pid) as { status: number }).status);
  }
  if (pids.length === 0) {
    // Bash reaps every child it waited for, so a later `wait` for one of them reports it is not a child; a job that
    // still holds descriptors or has yet to run stays, as its ends are still in use.
    for (const [pid, job] of jobs) {
      job.reported = true;
      if (job.finish === undefined && job.descriptors === undefined) jobs.delete(pid);
    }
    forgetReaped();
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

/**
 * Unsets the `-p` variable before `wait` waits, as Bash does, so it stays unset when no job is reported; a name that
 * cannot be unset fails `wait` first, while an array element is left as it is until a job is reported.
 */
function clearPidVariable(shell: Shell, name: string): boolean {
  if (!isIdentifier(name) && !isVariableReference(name)) {
    shell.reportError(`wait: \`${name}': not a valid identifier`);
    return false;
  }
  const failure = isIdentifier(name) ? shell.store.unsetNamed(name, false) : undefined;
  if (failure) shell.reportError(`wait: ${failure.message}`);
  return failure === undefined;
}

/**
 * Runs or settles the coprocesses `wait` waits for and reaps those that have ended, returning their process IDs. One
 * that nothing has read from yet runs now; one waiting for input the shell can still write would be waited for
 * forever; `wait -n` returns as soon as one target has ended, so a waiting coprocess matters only when none has, and
 * reaps only the job it reports.
 */
function settleCoprocesses(shell: Shell, targetPids: readonly number[], next: boolean): number[] {
  const targets = targetPids.map((pid) => shell.store.jobs.get(pid));
  for (const job of targets) job?.finish?.();
  const oneEnded = next && targets.some((job) => job?.reported === false && job.waiting !== true);
  if (!oneEnded) for (const job of targets) job?.settleWait?.();
  if (next) return [];
  // Only `wait` without operands forgets a reaped coprocess, while one that names it keeps its status for a later
  // `wait` that names it again.
  const reaped: number[] = [];
  for (const [index, job] of targets.entries()) {
    if (job?.dispose === undefined || job.finish !== undefined || job.waiting === true) continue;
    job.dispose();
    reaped.push(targetPids[index] as number);
  }
  return reaped;
}

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
