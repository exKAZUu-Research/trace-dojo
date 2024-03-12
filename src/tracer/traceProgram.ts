import type { GeneratedProgram } from '../types';

export function traceProgram(program: GeneratedProgram): void {
  const code = `
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

  set(varName, value) {
    if (this.variables[varName] !== undefined) {
      this.variables[varName] = value;
      return true;
    }
    if (this.parent && this.parent.set(varName, value)) {
      return true;
    }
    this.variables[varName] = value;
    return false;
  }

  enterNewScope() {
    return new Scope(this);
  }

  leaveScope() {
    if (!this.parent) {
      throw new Error();
    }
    return this.parent;
  }
}

let s = new Scope();
${program.instrumentedProgram}
s;
`;

  const ret = eval(code);
  console.log(ret);
}
