import type { GeneratedProgram } from '../types';

export function traceProgram(program: GeneratedProgram): void {
  if (program.instrumentedProgram.includes(' = ')) {
    throw new Error('Instrumented program MUST NOT contain assignment operators (=).');
  }
  if (
    program.instrumentedProgram.includes('const ') ||
    program.instrumentedProgram.includes('let ') ||
    program.instrumentedProgram.includes('var ')
  ) {
    throw new Error('Instrumented program MUST NOT contain variable declarations.');
  }

  let sid = 1;
  const modifiedCode = program.instrumentedProgram.replaceAll(/s\.set\((.+)\);/g, (_, args) => {
    return `s.set(${args}, ${sid++});`;
  });
  const executableCode = `
const trace = [];
let s;
class Scope {
  constructor(parent) {
    this.parent = parent;
    this.variables = {};
  }

  get(varName) {
    if (this.variables[varName] !== undefined) {
      return this.variables[varName];
    }
    if (this.parent) {
      return this.parent.get(varName);
    }
    throw new Error();
  }

  set(varName, value, sid) {
    if (!this.update(varName, value)) {
      this.variables[varName] = value;
    }
    trace.push({ sid, variables: { ...this.variables } });
  }

  update(varName, value) {
    if (this.variables[varName] !== undefined) {
      this.variables[varName] = value;
      return true;
    }
    if (this.parent && this.parent.update(varName, value)) {
      return true;
    }
    return false;
  }

  enterNewScope() {
    s = new Scope(this);
  }

  leaveScope() {
    if (!this.parent) {
      throw new Error();
    }
    s = this.parent;
  }
}
s = new Scope();

${modifiedCode}

trace;
`;

  const ret = eval(executableCode);
  console.log(ret); // TODO: remove this later
  return ret;
}
