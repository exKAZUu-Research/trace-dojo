import type { TextReader } from '../interpreter/programIo';

/** Where a file descriptor writes: the run's standard output or error, a file, a pipe, or a substitution's capture. */
export interface OutputTarget {
  write(text: string): void;
}

/**
 * An open file description, which every descriptor duplicated from it shares, so that they read from one position
 * and write to one place, as after `dup2`.
 */
export interface OpenFile {
  readonly output?: OutputTarget;
  readonly input?: TextReader;
}

/** Writing to a descriptor that is closed or open only for reading, which Bash reports as `Bad file descriptor`. */
export class BadDescriptorError extends Error {
  constructor() {
    super('Bad file descriptor');
    this.name = 'BadDescriptorError';
  }
}

/** The lowest descriptor that `{name}>file` allocates, as Bash does. */
const FIRST_ALLOCATED_DESCRIPTOR = 10;

/** The open descriptors of a shell, which a subshell copies and a redirection changes for one command. */
export class DescriptorTable {
  private readonly open: Map<number, OpenFile>;

  constructor(entries?: Iterable<[number, OpenFile]>) {
    this.open = new Map(entries);
  }

  get(fd: number): OpenFile | undefined {
    return this.open.get(fd);
  }

  set(fd: number, file: OpenFile): void {
    this.open.set(fd, file);
  }

  close(fd: number): void {
    this.open.delete(fd);
  }

  /** The lowest unused descriptor from 10 up, which `{name}>file` stores in `name`. */
  allocate(): number {
    let fd = FIRST_ALLOCATED_DESCRIPTOR;
    while (this.open.has(fd)) fd++;
    return fd;
  }

  clone(): DescriptorTable {
    return new DescriptorTable(this.open);
  }

  /** Makes this table hold what another holds, restoring descriptors that a command's redirections changed. */
  restore(saved: DescriptorTable): void {
    this.open.clear();
    for (const [fd, file] of saved.open) this.open.set(fd, file);
  }
}

/** What `/dev/null` reads and writes: nothing. */
export function nullFile(reader: TextReader): OpenFile {
  return { output: { write: () => {} }, input: reader };
}
