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

s.set('a', 1);
if (s.get('a') > 0) {
  // 2
  s.set('b', 2); // 3
  s.set('a', f(s.get('a'), s.get('b'))); // 4
}
let c = s.get('a') * 2; // 5

function f(x, y) {
  // 6
  s = s.enterNewScope();
  const ret = x * y; // 7
  s = s.leaveScope();
  return ret;
}
