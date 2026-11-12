import { defineGeneratorBuiltins } from './generators';
import { defineFunctionProperties } from './memberProperties';
import { defineArrayBuiltins } from './realmArrays';
import { defineGlobalBuiltins } from './realmGlobals';
import { defineNodeBuiltins } from './realmNode';
import { defineRegExpBuiltins } from './realmRegExp';
import { defineStringBuiltins } from './realmStrings';
import type { Runtime } from './runtime';
import { JsFunction, JsObject, type NativeFunction, Scope, type Value } from './values';

export type ErrorName = 'Error' | 'TypeError' | 'RangeError' | 'ReferenceError' | 'SyntaxError';

/** The builtin objects of one run, which programs may modify. */
export interface Realm {
  objectPrototype: JsObject;
  functionPrototype: JsObject;
  arrayPrototype: JsObject;
  stringPrototype: JsObject;
  numberPrototype: JsObject;
  booleanPrototype: JsObject;
  regExpPrototype: JsObject;
  /** `%IteratorPrototype%`, the parent of the builtin iterators' prototypes. */
  iteratorPrototype: JsObject;
  /** `%GeneratorPrototype%`, with the methods every generator object has. */
  generatorPrototype: JsObject;
  errorPrototypes: Record<ErrorName, JsObject>;
  /** The scope of the builtin globals, which encloses the program's own scope. */
  globals: Scope;
}

/** Creates builtins without charging the run, since a program cannot avoid them. */
export class RealmBuilder {
  readonly realm: Realm;

  constructor(readonly runtime: Runtime) {
    // oxlint-disable-next-line unicorn/no-null -- Object.prototype ends every prototype chain.
    const objectPrototype = new JsObject(null);
    const errorPrototype = new JsObject(objectPrototype);
    const iteratorPrototype = new JsObject(objectPrototype);
    this.realm = {
      objectPrototype,
      functionPrototype: new JsObject(objectPrototype),
      arrayPrototype: new JsObject(objectPrototype),
      stringPrototype: new JsObject(objectPrototype),
      numberPrototype: new JsObject(objectPrototype),
      booleanPrototype: new JsObject(objectPrototype),
      regExpPrototype: new JsObject(objectPrototype),
      iteratorPrototype,
      generatorPrototype: new JsObject(iteratorPrototype),
      errorPrototypes: {
        Error: errorPrototype,
        TypeError: new JsObject(errorPrototype),
        RangeError: new JsObject(errorPrototype),
        ReferenceError: new JsObject(errorPrototype),
        SyntaxError: new JsObject(errorPrototype),
      },
      globals: new Scope(undefined),
    };
  }

  function(name: string, length: number, run: NativeFunction, isConstructor = false): JsFunction {
    const fn = new JsFunction(this.realm.functionPrototype, { kind: 'native', run, isConstructor });
    defineFunctionProperties(fn, name, length);
    return fn;
  }

  /** Defines a builtin method, which is non-enumerable. */
  method(object: JsObject, name: string, length: number, run: NativeFunction): JsFunction {
    const fn = this.function(name, length, run);
    object.properties.set(name, {
      value: fn,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return fn;
  }

  getter(object: JsObject, name: string, run: NativeFunction): void {
    object.properties.set(name, {
      get: this.function(`get ${name}`, 0, run),
      set: undefined,
      enumerable: false,
      configurable: true,
    });
  }

  constant(object: JsObject, name: string, value: Value): void {
    object.properties.set(name, { value, writable: false, enumerable: false, configurable: false });
  }

  /** Defines a constructor with its prototype object, linking the two as `constructor` and `prototype`. */
  defineClass(
    name: string,
    length: number,
    prototype: JsObject,
    run: NativeFunction,
    isConstructor = true
  ): JsFunction {
    const fn = this.function(name, length, run, isConstructor);
    fn.properties.set('prototype', {
      value: prototype,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    prototype.properties.set('constructor', {
      value: fn,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    this.global(name, fn);
    return fn;
  }

  namespace(name: string): JsObject {
    const object = new JsObject(this.realm.objectPrototype);
    this.global(name, object);
    return object;
  }

  global(name: string, value: Value, isMutable = true): void {
    this.realm.globals.bindings.set(name, { value, isMutable });
  }
}

export function createRealm(runtime: Runtime): Realm {
  const builder = new RealmBuilder(runtime);
  defineGlobalBuiltins(builder);
  defineNodeBuiltins(builder);
  defineArrayBuiltins(builder);
  defineStringBuiltins(builder);
  defineRegExpBuiltins(builder);
  defineGeneratorBuiltins(builder);
  return builder.realm;
}
