// Declarations from the ECMAScript library files of TypeScript 7.0.2 (`lib.es5.d.ts` through `lib.es2024.*.d.ts`), with
// comments, typed arrays, and `Intl` removed.
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0.
// oxfmt-ignore
export const ECMASCRIPT_LIBRARY = `
declare var NaN: number;
declare var Infinity: number;
declare function eval(x: string): any;
declare function parseInt(string: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;
declare function decodeURI(encodedURI: string): string;
declare function decodeURIComponent(encodedURIComponent: string): string;
declare function encodeURI(uri: string): string;
declare function encodeURIComponent(uriComponent: string | number | boolean): string;
declare function escape(string: string): string;
declare function unescape(string: string): string;
interface Symbol {
    toString(): string;
    valueOf(): symbol;
}
declare type PropertyKey = string | number | symbol;
interface PropertyDescriptor {
    configurable?: boolean;
    enumerable?: boolean;
    value?: any;
    writable?: boolean;
    get?(): any;
    set?(v: any): void;
}
interface PropertyDescriptorMap {
    [key: PropertyKey]: PropertyDescriptor;
}
interface Object {
    constructor: Function;
    toString(): string;
    toLocaleString(): string;
    valueOf(): Object;
    hasOwnProperty(v: PropertyKey): boolean;
    isPrototypeOf(v: Object): boolean;
    propertyIsEnumerable(v: PropertyKey): boolean;
}
interface ObjectConstructor {
    new (value?: any): Object;
    (): any;
    (value: any): any;
    readonly prototype: Object;
    getPrototypeOf(o: any): any;
    getOwnPropertyDescriptor(o: any, p: PropertyKey): PropertyDescriptor | undefined;
    getOwnPropertyNames(o: any): string[];
    create(o: object | null): any;
    create(o: object | null, properties: PropertyDescriptorMap & ThisType<any>): any;
    defineProperty<T>(o: T, p: PropertyKey, attributes: PropertyDescriptor & ThisType<any>): T;
    defineProperties<T>(o: T, properties: PropertyDescriptorMap & ThisType<any>): T;
    seal<T>(o: T): T;
    freeze<T extends Function>(f: T): T;
    freeze<T extends { [idx: string]: U | null | undefined | object; }, U extends string | bigint | number | boolean | symbol>(o: T): Readonly<T>;
    freeze<T>(o: T): Readonly<T>;
    preventExtensions<T>(o: T): T;
    isSealed(o: any): boolean;
    isFrozen(o: any): boolean;
    isExtensible(o: any): boolean;
    keys(o: object): string[];
}
declare var Object: ObjectConstructor;
interface Function {
    apply(this: Function, thisArg: any, argArray?: any): any;
    call(this: Function, thisArg: any, ...argArray: any[]): any;
    bind(this: Function, thisArg: any, ...argArray: any[]): any;
    toString(): string;
    prototype: any;
    readonly length: number;
    arguments: any;
    caller: Function;
}
interface FunctionConstructor {
    new (...args: string[]): Function;
    (...args: string[]): Function;
    readonly prototype: Function;
}
declare var Function: FunctionConstructor;
type ThisParameterType<T> = T extends (this: infer U, ...args: never) => any ? U : unknown;
type OmitThisParameter<T> = unknown extends ThisParameterType<T> ? T : T extends (...args: infer A) => infer R ? (...args: A) => R : T;
interface CallableFunction extends Function {
    apply<T, R>(this: (this: T) => R, thisArg: T): R;
    apply<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg: T, args: A): R;
    call<T, A extends any[], R>(this: (this: T, ...args: A) => R, thisArg: T, ...args: A): R;
    bind<T>(this: T, thisArg: ThisParameterType<T>): OmitThisParameter<T>;
    bind<T, A extends any[], B extends any[], R>(this: (this: T, ...args: [...A, ...B]) => R, thisArg: T, ...args: A): (...args: B) => R;
}
interface NewableFunction extends Function {
    apply<T>(this: new () => T, thisArg: T): void;
    apply<T, A extends any[]>(this: new (...args: A) => T, thisArg: T, args: A): void;
    call<T, A extends any[]>(this: new (...args: A) => T, thisArg: T, ...args: A): void;
    bind<T>(this: T, thisArg: any): T;
    bind<A extends any[], B extends any[], R>(this: new (...args: [...A, ...B]) => R, thisArg: any, ...args: A): new (...args: B) => R;
}
interface IArguments {
    [index: number]: any;
    length: number;
    callee: Function;
}
interface String {
    toString(): string;
    charAt(pos: number): string;
    charCodeAt(index: number): number;
    concat(...strings: string[]): string;
    indexOf(searchString: string, position?: number): number;
    lastIndexOf(searchString: string, position?: number): number;
    localeCompare(that: string): number;
    match(regexp: string | RegExp): RegExpMatchArray | null;
    replace(searchValue: string | RegExp, replaceValue: string): string;
    replace(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
    search(regexp: string | RegExp): number;
    slice(start?: number, end?: number): string;
    split(separator: string | RegExp, limit?: number): string[];
    substring(start: number, end?: number): string;
    toLowerCase(): string;
    toLocaleLowerCase(locales?: string | string[]): string;
    toUpperCase(): string;
    toLocaleUpperCase(locales?: string | string[]): string;
    trim(): string;
    readonly length: number;
    substr(from: number, length?: number): string;
    valueOf(): string;
    readonly [index: number]: string;
}
interface StringConstructor {
    new (value?: any): String;
    (value?: any): string;
    readonly prototype: String;
    fromCharCode(...codes: number[]): string;
}
declare var String: StringConstructor;
interface Boolean {
    valueOf(): boolean;
}
interface BooleanConstructor {
    new (value?: any): Boolean;
    <T>(value?: T): boolean;
    readonly prototype: Boolean;
}
declare var Boolean: BooleanConstructor;
interface Number {
    toString(radix?: number): string;
    toFixed(fractionDigits?: number): string;
    toExponential(fractionDigits?: number): string;
    toPrecision(precision?: number): string;
    valueOf(): number;
}
interface NumberConstructor {
    new (value?: any): Number;
    (value?: any): number;
    readonly prototype: Number;
    readonly MAX_VALUE: number;
    readonly MIN_VALUE: number;
    readonly NaN: number;
    readonly NEGATIVE_INFINITY: number;
    readonly POSITIVE_INFINITY: number;
}
declare var Number: NumberConstructor;
interface TemplateStringsArray extends ReadonlyArray<string> {
    readonly raw: readonly string[];
}
interface Math {
    readonly E: number;
    readonly LN10: number;
    readonly LN2: number;
    readonly LOG2E: number;
    readonly LOG10E: number;
    readonly PI: number;
    readonly SQRT1_2: number;
    readonly SQRT2: number;
    abs(x: number): number;
    acos(x: number): number;
    asin(x: number): number;
    atan(x: number): number;
    atan2(y: number, x: number): number;
    ceil(x: number): number;
    cos(x: number): number;
    exp(x: number): number;
    floor(x: number): number;
    log(x: number): number;
    max(...values: number[]): number;
    min(...values: number[]): number;
    pow(x: number, y: number): number;
    random(): number;
    round(x: number): number;
    sin(x: number): number;
    sqrt(x: number): number;
    tan(x: number): number;
}
declare var Math: Math;
interface Date {
    toString(): string;
    toDateString(): string;
    toTimeString(): string;
    toLocaleString(): string;
    toLocaleDateString(): string;
    toLocaleTimeString(): string;
    valueOf(): number;
    getTime(): number;
    getFullYear(): number;
    getUTCFullYear(): number;
    getMonth(): number;
    getUTCMonth(): number;
    getDate(): number;
    getUTCDate(): number;
    getDay(): number;
    getUTCDay(): number;
    getHours(): number;
    getUTCHours(): number;
    getMinutes(): number;
    getUTCMinutes(): number;
    getSeconds(): number;
    getUTCSeconds(): number;
    getMilliseconds(): number;
    getUTCMilliseconds(): number;
    getTimezoneOffset(): number;
    setTime(time: number): number;
    setMilliseconds(ms: number): number;
    setUTCMilliseconds(ms: number): number;
    setSeconds(sec: number, ms?: number): number;
    setUTCSeconds(sec: number, ms?: number): number;
    setMinutes(min: number, sec?: number, ms?: number): number;
    setUTCMinutes(min: number, sec?: number, ms?: number): number;
    setHours(hours: number, min?: number, sec?: number, ms?: number): number;
    setUTCHours(hours: number, min?: number, sec?: number, ms?: number): number;
    setDate(date: number): number;
    setUTCDate(date: number): number;
    setMonth(month: number, date?: number): number;
    setUTCMonth(month: number, date?: number): number;
    setFullYear(year: number, month?: number, date?: number): number;
    setUTCFullYear(year: number, month?: number, date?: number): number;
    toUTCString(): string;
    toISOString(): string;
    toJSON(key?: any): string;
}
interface DateConstructor {
    new (): Date;
    new (value: number | string): Date;
    new (year: number, monthIndex: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number): Date;
    (): string;
    readonly prototype: Date;
    parse(s: string): number;
    UTC(year: number, monthIndex: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number): number;
    now(): number;
}
declare var Date: DateConstructor;
interface RegExpMatchArray extends Array<string> {
    index?: number;
    input?: string;
    0: string;
}
interface RegExpExecArray extends Array<string> {
    index: number;
    input: string;
    0: string;
}
interface RegExp {
    exec(string: string): RegExpExecArray | null;
    test(string: string): boolean;
    readonly source: string;
    readonly global: boolean;
    readonly ignoreCase: boolean;
    readonly multiline: boolean;
    lastIndex: number;
    compile(pattern: string, flags?: string): this;
}
interface RegExpConstructor {
    new (pattern: RegExp | string): RegExp;
    new (pattern: string, flags?: string): RegExp;
    (pattern: RegExp | string): RegExp;
    (pattern: string, flags?: string): RegExp;
    readonly "prototype": RegExp;
    "$1": string;
    "$2": string;
    "$3": string;
    "$4": string;
    "$5": string;
    "$6": string;
    "$7": string;
    "$8": string;
    "$9": string;
    "input": string;
    "$_": string;
    "lastMatch": string;
    "$&": string;
    "lastParen": string;
    "$+": string;
    "leftContext": string;
    "$\`": string;
    "rightContext": string;
    "$'": string;
}
declare var RegExp: RegExpConstructor;
interface Error {
    name: string;
    message: string;
    stack?: string;
}
interface ErrorConstructor {
    new (message?: string): Error;
    (message?: string): Error;
    readonly prototype: Error;
}
declare var Error: ErrorConstructor;
interface EvalError extends Error {
}
interface EvalErrorConstructor extends ErrorConstructor {
    new (message?: string): EvalError;
    (message?: string): EvalError;
    readonly prototype: EvalError;
}
declare var EvalError: EvalErrorConstructor;
interface RangeError extends Error {
}
interface RangeErrorConstructor extends ErrorConstructor {
    new (message?: string): RangeError;
    (message?: string): RangeError;
    readonly prototype: RangeError;
}
declare var RangeError: RangeErrorConstructor;
interface ReferenceError extends Error {
}
interface ReferenceErrorConstructor extends ErrorConstructor {
    new (message?: string): ReferenceError;
    (message?: string): ReferenceError;
    readonly prototype: ReferenceError;
}
declare var ReferenceError: ReferenceErrorConstructor;
interface SyntaxError extends Error {
}
interface SyntaxErrorConstructor extends ErrorConstructor {
    new (message?: string): SyntaxError;
    (message?: string): SyntaxError;
    readonly prototype: SyntaxError;
}
declare var SyntaxError: SyntaxErrorConstructor;
interface TypeError extends Error {
}
interface TypeErrorConstructor extends ErrorConstructor {
    new (message?: string): TypeError;
    (message?: string): TypeError;
    readonly prototype: TypeError;
}
declare var TypeError: TypeErrorConstructor;
interface URIError extends Error {
}
interface URIErrorConstructor extends ErrorConstructor {
    new (message?: string): URIError;
    (message?: string): URIError;
    readonly prototype: URIError;
}
declare var URIError: URIErrorConstructor;
interface JSON {
    parse(text: string, reviver?: (this: any, key: string, value: any) => any): any;
    stringify(value: any, replacer?: (this: any, key: string, value: any) => any, space?: string | number): string;
    stringify(value: any, replacer?: (number | string)[] | null, space?: string | number): string;
}
declare var JSON: JSON;
interface ReadonlyArray<T> {
    readonly length: number;
    toString(): string;
    toLocaleString(): string;
    concat(...items: ConcatArray<T>[]): T[];
    concat(...items: (T | ConcatArray<T>)[]): T[];
    join(separator?: string): string;
    slice(start?: number, end?: number): T[];
    indexOf(searchElement: T, fromIndex?: number): number;
    lastIndexOf(searchElement: T, fromIndex?: number): number;
    every<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S, thisArg?: any): this is readonly S[];
    every(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
    some(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): boolean;
    forEach(callbackfn: (value: T, index: number, array: readonly T[]) => void, thisArg?: any): void;
    map<U>(callbackfn: (value: T, index: number, array: readonly T[]) => U, thisArg?: any): U[];
    filter<S extends T>(predicate: (value: T, index: number, array: readonly T[]) => value is S, thisArg?: any): S[];
    filter(predicate: (value: T, index: number, array: readonly T[]) => unknown, thisArg?: any): T[];
    reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T): T;
    reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T, initialValue: T): T;
    reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U, initialValue: U): U;
    reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T): T;
    reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: readonly T[]) => T, initialValue: T): T;
    reduceRight<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: readonly T[]) => U, initialValue: U): U;
    readonly [n: number]: T;
}
interface ConcatArray<T> {
    readonly length: number;
    readonly [n: number]: T;
    join(separator?: string): string;
    slice(start?: number, end?: number): T[];
}
interface Array<T> {
    length: number;
    toString(): string;
    toLocaleString(): string;
    pop(): T | undefined;
    push(...items: T[]): number;
    concat(...items: ConcatArray<T>[]): T[];
    concat(...items: (T | ConcatArray<T>)[]): T[];
    join(separator?: string): string;
    reverse(): T[];
    shift(): T | undefined;
    slice(start?: number, end?: number): T[];
    sort(compareFn?: (a: T, b: T) => number): this;
    splice(start: number, deleteCount?: number): T[];
    splice(start: number, deleteCount: number, ...items: T[]): T[];
    unshift(...items: T[]): number;
    indexOf(searchElement: T, fromIndex?: number): number;
    lastIndexOf(searchElement: T, fromIndex?: number): number;
    every<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): this is S[];
    every(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
    some(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): boolean;
    forEach(callbackfn: (value: T, index: number, array: T[]) => void, thisArg?: any): void;
    map<U>(callbackfn: (value: T, index: number, array: T[]) => U, thisArg?: any): U[];
    filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): S[];
    filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T[];
    reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
    reduce(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
    reduce<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
    reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T): T;
    reduceRight(callbackfn: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => T, initialValue: T): T;
    reduceRight<U>(callbackfn: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => U, initialValue: U): U;
    [n: number]: T;
}
interface ArrayConstructor {
    new (arrayLength?: number): any[];
    new <T>(arrayLength: number): T[];
    new <T>(...items: T[]): T[];
    (arrayLength?: number): any[];
    <T>(arrayLength: number): T[];
    <T>(...items: T[]): T[];
    isArray(arg: any): arg is any[];
    readonly prototype: any[];
}
declare var Array: ArrayConstructor;
declare type PromiseConstructorLike = new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void) => PromiseLike<T>;
interface PromiseLike<T> {
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): PromiseLike<TResult1 | TResult2>;
}
interface Promise<T> {
    then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2>;
    catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<T | TResult>;
}
type Awaited<T> = T extends null | undefined ? T : 
    T extends object & { then(onfulfilled: infer F, ...args: infer _): any; } ? 
        F extends ((value: infer V, ...args: infer _) => any) ? 
            Awaited<V> : 
        never : 
    T;
interface ArrayLike<T> {
    readonly length: number;
    readonly [n: number]: T;
}
type Partial<T> = {
    [P in keyof T]?: T[P];
};
type Required<T> = {
    [P in keyof T]-?: T[P];
};
type Readonly<T> = {
    readonly [P in keyof T]: T[P];
};
type Pick<T, K extends keyof T> = {
    [P in K]: T[P];
};
type Record<K extends keyof any, T> = {
    [P in K]: T;
};
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type NonNullable<T> = T & {};
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (...args: infer P) => any ? P : never;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : any;
type WeakKey = WeakKeyTypes[keyof WeakKeyTypes];
interface String {
    localeCompare(that: string, locales?: string | string[], options?: Intl.CollatorOptions): number;
}
interface Number {
    toLocaleString(locales?: string | string[], options?: Intl.NumberFormatOptions): string;
}
interface Date {
    toLocaleString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string;
    toLocaleDateString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string;
    toLocaleTimeString(locales?: string | string[], options?: Intl.DateTimeFormatOptions): string;
}
interface Array<T> {
    find<S extends T>(predicate: (value: T, index: number, obj: T[]) => value is S, thisArg?: any): S | undefined;
    find(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): T | undefined;
    findIndex(predicate: (value: T, index: number, obj: T[]) => unknown, thisArg?: any): number;
    fill(value: T, start?: number, end?: number): this;
    copyWithin(target: number, start: number, end?: number): this;
    toLocaleString(locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): string;
}
interface ArrayConstructor {
    from<T>(arrayLike: ArrayLike<T>): T[];
    from<T, U>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
    of<T>(...items: T[]): T[];
}
interface DateConstructor {
    new (value: number | string | Date): Date;
}
interface Function {
    readonly name: string;
}
interface Math {
    clz32(x: number): number;
    imul(x: number, y: number): number;
    sign(x: number): number;
    log10(x: number): number;
    log2(x: number): number;
    log1p(x: number): number;
    expm1(x: number): number;
    cosh(x: number): number;
    sinh(x: number): number;
    tanh(x: number): number;
    acosh(x: number): number;
    asinh(x: number): number;
    atanh(x: number): number;
    hypot(...values: number[]): number;
    trunc(x: number): number;
    fround(x: number): number;
    cbrt(x: number): number;
}
interface NumberConstructor {
    readonly EPSILON: number;
    isFinite(number: unknown): boolean;
    isInteger(number: unknown): boolean;
    isNaN(number: unknown): boolean;
    isSafeInteger(number: unknown): boolean;
    readonly MAX_SAFE_INTEGER: number;
    readonly MIN_SAFE_INTEGER: number;
    parseFloat(string: string): number;
    parseInt(string: string, radix?: number): number;
}
interface ObjectConstructor {
    assign<T extends {}, U>(target: T, source: U): T & U;
    assign<T extends {}, U, V>(target: T, source1: U, source2: V): T & U & V;
    assign<T extends {}, U, V, W>(target: T, source1: U, source2: V, source3: W): T & U & V & W;
    assign(target: object, ...sources: any[]): any;
    getOwnPropertySymbols(o: any): symbol[];
    keys(o: {}): string[];
    is(value1: any, value2: any): boolean;
    setPrototypeOf(o: any, proto: object | null): any;
}
interface ReadonlyArray<T> {
    find<S extends T>(predicate: (value: T, index: number, obj: readonly T[]) => value is S, thisArg?: any): S | undefined;
    find(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): T | undefined;
    findIndex(predicate: (value: T, index: number, obj: readonly T[]) => unknown, thisArg?: any): number;
    toLocaleString(locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): string;
}
interface RegExp {
    readonly flags: string;
    readonly sticky: boolean;
    readonly unicode: boolean;
}
interface RegExpConstructor {
    new (pattern: RegExp | string, flags?: string): RegExp;
    (pattern: RegExp | string, flags?: string): RegExp;
}
interface String {
    codePointAt(pos: number): number | undefined;
    includes(searchString: string, position?: number): boolean;
    endsWith(searchString: string, endPosition?: number): boolean;
    normalize(form: "NFC" | "NFD" | "NFKC" | "NFKD"): string;
    normalize(form?: string): string;
    repeat(count: number): string;
    startsWith(searchString: string, position?: number): boolean;
    anchor(name: string): string;
    big(): string;
    blink(): string;
    bold(): string;
    fixed(): string;
    fontcolor(color: string): string;
    fontsize(size: number): string;
    fontsize(size: string): string;
    italics(): string;
    link(url: string): string;
    small(): string;
    strike(): string;
    sub(): string;
    sup(): string;
}
interface StringConstructor {
    fromCodePoint(...codePoints: number[]): string;
    raw(template: { raw: readonly string[] | ArrayLike<string>; }, ...substitutions: any[]): string;
}
interface Map<K, V> {
    clear(): void;
    delete(key: K): boolean;
    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void;
    get(key: K): V | undefined;
    has(key: K): boolean;
    set(key: K, value: V): this;
    readonly size: number;
}
interface MapConstructor {
    new (): Map<any, any>;
    new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
    readonly prototype: Map<any, any>;
}
declare var Map: MapConstructor;
interface ReadonlyMap<K, V> {
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: any): void;
    get(key: K): V | undefined;
    has(key: K): boolean;
    readonly size: number;
}
interface WeakMap<K extends WeakKey, V> {
    delete(key: K): boolean;
    get(key: K): V | undefined;
    has(key: K): boolean;
    set(key: K, value: V): this;
}
interface WeakMapConstructor {
    new <K extends WeakKey = WeakKey, V = any>(entries?: readonly (readonly [K, V])[] | null): WeakMap<K, V>;
    readonly prototype: WeakMap<WeakKey, any>;
}
declare var WeakMap: WeakMapConstructor;
interface Set<T> {
    add(value: T): this;
    clear(): void;
    delete(value: T): boolean;
    forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void, thisArg?: any): void;
    has(value: T): boolean;
    readonly size: number;
}
interface SetConstructor {
    new <T = any>(values?: readonly T[] | null): Set<T>;
    readonly prototype: Set<any>;
}
declare var Set: SetConstructor;
interface ReadonlySet<T> {
    forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: any): void;
    has(value: T): boolean;
    readonly size: number;
}
interface WeakSet<T extends WeakKey> {
    add(value: T): this;
    delete(value: T): boolean;
    has(value: T): boolean;
}
interface WeakSetConstructor {
    new <T extends WeakKey = WeakKey>(values?: readonly T[] | null): WeakSet<T>;
    readonly prototype: WeakSet<WeakKey>;
}
declare var WeakSet: WeakSetConstructor;
interface SymbolConstructor {
    readonly iterator: unique symbol;
}
interface IteratorYieldResult<TYield> {
    done?: false;
    value: TYield;
}
interface IteratorReturnResult<TReturn> {
    done: true;
    value: TReturn;
}
type IteratorResult<T, TReturn = any> = IteratorYieldResult<T> | IteratorReturnResult<TReturn>;
interface Iterator<T, TReturn = any, TNext = any> {
    next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
    return?(value?: TReturn): IteratorResult<T, TReturn>;
    throw?(e?: any): IteratorResult<T, TReturn>;
}
interface Iterable<T, TReturn = any, TNext = any> {
    [Symbol.iterator](): Iterator<T, TReturn, TNext>;
}
interface IterableIterator<T, TReturn = any, TNext = any> extends Iterator<T, TReturn, TNext> {
    [Symbol.iterator](): IterableIterator<T, TReturn, TNext>;
}
interface IteratorObject<T, TReturn = unknown, TNext = unknown> extends Iterator<T, TReturn, TNext> {
    [Symbol.iterator](): IteratorObject<T, TReturn, TNext>;
}
type BuiltinIteratorReturn = intrinsic;
interface ArrayIterator<T> extends IteratorObject<T, BuiltinIteratorReturn, unknown> {
    [Symbol.iterator](): ArrayIterator<T>;
}
interface Array<T> {
    [Symbol.iterator](): ArrayIterator<T>;
    entries(): ArrayIterator<[number, T]>;
    keys(): ArrayIterator<number>;
    values(): ArrayIterator<T>;
}
interface ArrayConstructor {
    from<T>(iterable: Iterable<T> | ArrayLike<T>): T[];
    from<T, U>(iterable: Iterable<T> | ArrayLike<T>, mapfn: (v: T, k: number) => U, thisArg?: any): U[];
}
interface ReadonlyArray<T> {
    [Symbol.iterator](): ArrayIterator<T>;
    entries(): ArrayIterator<[number, T]>;
    keys(): ArrayIterator<number>;
    values(): ArrayIterator<T>;
}
interface IArguments {
    [Symbol.iterator](): ArrayIterator<any>;
}
interface MapIterator<T> extends IteratorObject<T, BuiltinIteratorReturn, unknown> {
    [Symbol.iterator](): MapIterator<T>;
}
interface Map<K, V> {
    [Symbol.iterator](): MapIterator<[K, V]>;
    entries(): MapIterator<[K, V]>;
    keys(): MapIterator<K>;
    values(): MapIterator<V>;
}
interface ReadonlyMap<K, V> {
    [Symbol.iterator](): MapIterator<[K, V]>;
    entries(): MapIterator<[K, V]>;
    keys(): MapIterator<K>;
    values(): MapIterator<V>;
}
interface MapConstructor {
    new (): Map<any, any>;
    new <K, V>(iterable?: Iterable<readonly [K, V]> | null): Map<K, V>;
}
interface WeakMap<K extends WeakKey, V> {}
interface WeakMapConstructor {
    new <K extends WeakKey = WeakKey, V = any>(iterable?: Iterable<readonly [K, V]> | null): WeakMap<K, V>;
}
interface SetIterator<T> extends IteratorObject<T, BuiltinIteratorReturn, unknown> {
    [Symbol.iterator](): SetIterator<T>;
}
interface Set<T> {
    [Symbol.iterator](): SetIterator<T>;
    entries(): SetIterator<[T, T]>;
    keys(): SetIterator<T>;
    values(): SetIterator<T>;
}
interface ReadonlySet<T> {
    [Symbol.iterator](): SetIterator<T>;
    entries(): SetIterator<[T, T]>;
    keys(): SetIterator<T>;
    values(): SetIterator<T>;
}
interface SetConstructor {
    new <T>(iterable?: Iterable<T> | null): Set<T>;
}
interface WeakSet<T extends WeakKey> {}
interface WeakSetConstructor {
    new <T extends WeakKey = WeakKey>(iterable: Iterable<T>): WeakSet<T>;
}
interface Promise<T> {}
interface PromiseConstructor {
    all<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]>;
    race<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>>;
}
interface StringIterator<T> extends IteratorObject<T, BuiltinIteratorReturn, unknown> {
    [Symbol.iterator](): StringIterator<T>;
}
interface String {
    [Symbol.iterator](): StringIterator<string>;
}
interface SymbolConstructor {
    readonly prototype: Symbol;
    (description?: string | number): symbol;
    for(key: string): symbol;
    keyFor(sym: symbol): string | undefined;
}
declare var Symbol: SymbolConstructor;
interface SymbolConstructor {
    readonly hasInstance: unique symbol;
    readonly isConcatSpreadable: unique symbol;
    readonly match: unique symbol;
    readonly replace: unique symbol;
    readonly search: unique symbol;
    readonly species: unique symbol;
    readonly split: unique symbol;
    readonly toPrimitive: unique symbol;
    readonly toStringTag: unique symbol;
    readonly unscopables: unique symbol;
}
interface Symbol {
    [Symbol.toPrimitive](hint: string): symbol;
    readonly [Symbol.toStringTag]: string;
}
interface Array<T> {
    readonly [Symbol.unscopables]: {
        [K in keyof any[]]?: boolean;
    };
}
interface ReadonlyArray<T> {
    readonly [Symbol.unscopables]: {
        [K in keyof readonly any[]]?: boolean;
    };
}
interface Date {
    [Symbol.toPrimitive](hint: "default"): string;
    [Symbol.toPrimitive](hint: "string"): string;
    [Symbol.toPrimitive](hint: "number"): number;
    [Symbol.toPrimitive](hint: string): string | number;
}
interface Map<K, V> {
    readonly [Symbol.toStringTag]: string;
}
interface WeakMap<K extends WeakKey, V> {
    readonly [Symbol.toStringTag]: string;
}
interface Set<T> {
    readonly [Symbol.toStringTag]: string;
}
interface WeakSet<T extends WeakKey> {
    readonly [Symbol.toStringTag]: string;
}
interface JSON {
    readonly [Symbol.toStringTag]: string;
}
interface Function {
    [Symbol.hasInstance](value: any): boolean;
}
interface GeneratorFunction {
    readonly [Symbol.toStringTag]: string;
}
interface Math {
    readonly [Symbol.toStringTag]: string;
}
interface Promise<T> {
    readonly [Symbol.toStringTag]: string;
}
interface PromiseConstructor {
    readonly [Symbol.species]: PromiseConstructor;
}
interface RegExp {
    [Symbol.match](string: string): RegExpMatchArray | null;
    [Symbol.replace](string: string, replaceValue: string): string;
    [Symbol.replace](string: string, replacer: (substring: string, ...args: any[]) => string): string;
    [Symbol.search](string: string): number;
    [Symbol.split](string: string, limit?: number): string[];
}
interface RegExpConstructor {
    readonly [Symbol.species]: RegExpConstructor;
}
interface String {
    match(matcher: { [Symbol.match](string: string): RegExpMatchArray | null; }): RegExpMatchArray | null;
    replace(searchValue: { [Symbol.replace](string: string, replaceValue: string): string; }, replaceValue: string): string;
    replace(searchValue: { [Symbol.replace](string: string, replacer: (substring: string, ...args: any[]) => string): string; }, replacer: (substring: string, ...args: any[]) => string): string;
    search(searcher: { [Symbol.search](string: string): number; }): number;
    split(splitter: { [Symbol.split](string: string, limit?: number): string[]; }, limit?: number): string[];
}
interface ArrayConstructor {
    readonly [Symbol.species]: ArrayConstructor;
}
interface MapConstructor {
    readonly [Symbol.species]: MapConstructor;
}
interface SetConstructor {
    readonly [Symbol.species]: SetConstructor;
}
interface Generator<T = unknown, TReturn = any, TNext = any> extends IteratorObject<T, TReturn, TNext> {
    next(...[value]: [] | [TNext]): IteratorResult<T, TReturn>;
    return(value: TReturn): IteratorResult<T, TReturn>;
    throw(e: any): IteratorResult<T, TReturn>;
    [Symbol.iterator](): Generator<T, TReturn, TNext>;
}
interface GeneratorFunction {
    new (...args: any[]): Generator;
    (...args: any[]): Generator;
    readonly length: number;
    readonly name: string;
    readonly prototype: Generator;
}
interface GeneratorFunctionConstructor {
    new (...args: string[]): GeneratorFunction;
    (...args: string[]): GeneratorFunction;
    readonly length: number;
    readonly name: string;
    readonly prototype: GeneratorFunction;
}
interface PromiseConstructor {
    readonly prototype: Promise<any>;
    new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
    all<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]>; }>;
    race<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
    reject<T = never>(reason?: any): Promise<T>;
    resolve(): Promise<void>;
    resolve<T>(value: T): Promise<Awaited<T>>;
    resolve<T>(value: T | PromiseLike<T>): Promise<Awaited<T>>;
}
declare var Promise: PromiseConstructor;
interface Array<T> {
    includes(searchElement: T, fromIndex?: number): boolean;
}
interface ReadonlyArray<T> {
    includes(searchElement: T, fromIndex?: number): boolean;
}
interface ObjectConstructor {
    values<T>(o: { [s: string]: T; } | ArrayLike<T>): T[];
    values(o: {}): any[];
    entries<T>(o: { [s: string]: T; } | ArrayLike<T>): [string, T][];
    entries(o: {}): [string, any][];
    getOwnPropertyDescriptors<T>(o: T): { [P in keyof T]: TypedPropertyDescriptor<T[P]>; } & { [x: string]: PropertyDescriptor; };
}
interface String {
    padStart(targetLength: number, padString?: string): string;
    padEnd(targetLength: number, padString?: string): string;
}
interface Promise<T> {
    finally(onfinally?: (() => void) | undefined | null): Promise<T>;
}
type FlatArray<Arr, Depth extends number> = {
    done: Arr;
    recur: Arr extends ReadonlyArray<infer InnerArr> ? FlatArray<InnerArr, [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20][Depth]>
        : Arr;
}[Depth extends -1 ? "done" : "recur"];
interface ReadonlyArray<T> {
    flatMap<U, This = undefined>(
        callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>,
        thisArg?: This,
    ): U[];
    flat<A, D extends number = 1>(
        this: A,
        depth?: D,
    ): FlatArray<A, D>[];
}
interface Array<T> {
    flatMap<U, This = undefined>(
        callback: (this: This, value: T, index: number, array: T[]) => U | ReadonlyArray<U>,
        thisArg?: This,
    ): U[];
    flat<A, D extends number = 1>(
        this: A,
        depth?: D,
    ): FlatArray<A, D>[];
}
interface ObjectConstructor {
    fromEntries<T = any>(entries: Iterable<readonly [PropertyKey, T]>): { [k: string]: T; };
    fromEntries(entries: Iterable<readonly any[]>): any;
}
interface String {
    trimEnd(): string;
    trimStart(): string;
    trimLeft(): string;
    trimRight(): string;
}
interface Symbol {
    readonly description: string | undefined;
}
interface BigIntToLocaleStringOptions {
    localeMatcher?: string;
    style?: string;
    numberingSystem?: string;
    unit?: string;
    unitDisplay?: string;
    currency?: string;
    currencyDisplay?: string;
    useGrouping?: boolean;
    minimumIntegerDigits?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;
    minimumFractionDigits?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;
    maximumFractionDigits?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;
    minimumSignificantDigits?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;
    maximumSignificantDigits?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;
    notation?: string;
    compactDisplay?: string;
}
interface BigInt {
    toString(radix?: number): string;
    toLocaleString(locales?: Intl.LocalesArgument, options?: BigIntToLocaleStringOptions): string;
    valueOf(): bigint;
    readonly [Symbol.toStringTag]: "BigInt";
}
interface BigIntConstructor {
    (value: bigint | boolean | number | string): bigint;
    readonly prototype: BigInt;
    asIntN(bits: number, int: bigint): bigint;
    asUintN(bits: number, int: bigint): bigint;
}
declare var BigInt: BigIntConstructor;
interface String {
    matchAll(regexp: RegExp): RegExpStringIterator<RegExpExecArray>;
    toLocaleLowerCase(locales?: Intl.LocalesArgument): string;
    toLocaleUpperCase(locales?: Intl.LocalesArgument): string;
    localeCompare(that: string, locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions): number;
}
interface SymbolConstructor {
    readonly matchAll: unique symbol;
}
interface RegExpStringIterator<T> extends IteratorObject<T, BuiltinIteratorReturn, unknown> {
    [Symbol.iterator](): RegExpStringIterator<T>;
}
interface RegExp {
    [Symbol.matchAll](str: string): RegExpStringIterator<RegExpExecArray>;
}
interface PromiseFulfilledResult<T> {
    status: "fulfilled";
    value: T;
}
interface PromiseRejectedResult {
    status: "rejected";
    reason: any;
}
type PromiseSettledResult<T> = PromiseFulfilledResult<T> | PromiseRejectedResult;
interface PromiseConstructor {
    allSettled<T extends readonly unknown[] | []>(values: T): Promise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>>; }>;
    allSettled<T>(values: Iterable<T | PromiseLike<T>>): Promise<PromiseSettledResult<Awaited<T>>[]>;
}
interface String {
    replaceAll(searchValue: string | RegExp, replaceValue: string): string;
    replaceAll(searchValue: string | RegExp, replacer: (substring: string, ...args: any[]) => string): string;
}
interface AggregateError extends Error {
    errors: any[];
}
interface AggregateErrorConstructor {
    new (errors: Iterable<any>, message?: string): AggregateError;
    (errors: Iterable<any>, message?: string): AggregateError;
    readonly prototype: AggregateError;
}
declare var AggregateError: AggregateErrorConstructor;
interface PromiseConstructor {
    any<T extends readonly unknown[] | []>(values: T): Promise<Awaited<T[number]>>;
    any<T>(values: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>>;
}
interface WeakRef<T extends WeakKey> {
    readonly [Symbol.toStringTag]: "WeakRef";
    deref(): T | undefined;
}
interface WeakRefConstructor {
    readonly prototype: WeakRef<any>;
    new <T extends WeakKey>(target: T): WeakRef<T>;
}
declare var WeakRef: WeakRefConstructor;
interface FinalizationRegistry<T> {
    readonly [Symbol.toStringTag]: "FinalizationRegistry";
    register(target: WeakKey, heldValue: T, unregisterToken?: WeakKey): void;
    unregister(unregisterToken: WeakKey): boolean;
}
interface FinalizationRegistryConstructor {
    readonly prototype: FinalizationRegistry<any>;
    new <T>(cleanupCallback: (heldValue: T) => void): FinalizationRegistry<T>;
}
declare var FinalizationRegistry: FinalizationRegistryConstructor;
interface Array<T> {
    at(index: number): T | undefined;
}
interface ReadonlyArray<T> {
    at(index: number): T | undefined;
}
interface ErrorOptions {
    cause?: unknown;
}
interface Error {
    cause?: unknown;
}
interface ErrorConstructor {
    new (message?: string, options?: ErrorOptions): Error;
    (message?: string, options?: ErrorOptions): Error;
}
interface EvalErrorConstructor {
    new (message?: string, options?: ErrorOptions): EvalError;
    (message?: string, options?: ErrorOptions): EvalError;
}
interface RangeErrorConstructor {
    new (message?: string, options?: ErrorOptions): RangeError;
    (message?: string, options?: ErrorOptions): RangeError;
}
interface ReferenceErrorConstructor {
    new (message?: string, options?: ErrorOptions): ReferenceError;
    (message?: string, options?: ErrorOptions): ReferenceError;
}
interface SyntaxErrorConstructor {
    new (message?: string, options?: ErrorOptions): SyntaxError;
    (message?: string, options?: ErrorOptions): SyntaxError;
}
interface TypeErrorConstructor {
    new (message?: string, options?: ErrorOptions): TypeError;
    (message?: string, options?: ErrorOptions): TypeError;
}
interface URIErrorConstructor {
    new (message?: string, options?: ErrorOptions): URIError;
    (message?: string, options?: ErrorOptions): URIError;
}
interface AggregateErrorConstructor {
    new (
        errors: Iterable<any>,
        message?: string,
        options?: ErrorOptions,
    ): AggregateError;
    (
        errors: Iterable<any>,
        message?: string,
        options?: ErrorOptions,
    ): AggregateError;
}
interface ObjectConstructor {
    hasOwn(o: object, v: PropertyKey): boolean;
}
interface String {
    at(index: number): string | undefined;
}
interface RegExpMatchArray {
    indices?: RegExpIndicesArray;
}
interface RegExpExecArray {
    indices?: RegExpIndicesArray;
}
interface RegExpIndicesArray extends Array<[number, number] | undefined> {
    groups?: {
        [key: string]: [number, number];
    };
}
interface RegExp {
    readonly hasIndices: boolean;
}
interface Array<T> {
    findLast<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): S | undefined;
    findLast(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): T | undefined;
    findLastIndex(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): number;
    toReversed(): T[];
    toSorted(compareFn?: (a: T, b: T) => number): T[];
    toSpliced(start: number, deleteCount: number, ...items: T[]): T[];
    toSpliced(start: number, deleteCount?: number): T[];
    with(index: number, value: T): T[];
}
interface ReadonlyArray<T> {
    findLast<S extends T>(
        predicate: (value: T, index: number, array: readonly T[]) => value is S,
        thisArg?: any,
    ): S | undefined;
    findLast(
        predicate: (value: T, index: number, array: readonly T[]) => unknown,
        thisArg?: any,
    ): T | undefined;
    findLastIndex(
        predicate: (value: T, index: number, array: readonly T[]) => unknown,
        thisArg?: any,
    ): number;
    toReversed(): T[];
    toSorted(compareFn?: (a: T, b: T) => number): T[];
    toSpliced(start: number, deleteCount: number, ...items: T[]): T[];
    toSpliced(start: number, deleteCount?: number): T[];
    with(index: number, value: T): T[];
}
interface ObjectConstructor {
    groupBy<K extends PropertyKey, T>(
        items: Iterable<T>,
        keySelector: (item: T, index: number) => K,
    ): Partial<Record<K, T[]>>;
}
interface MapConstructor {
    groupBy<K, T>(
        items: Iterable<T>,
        keySelector: (item: T, index: number) => K,
    ): Map<K, T[]>;
}
interface String {
    isWellFormed(): boolean;
    toWellFormed(): string;
}
interface RegExpMatchArray {
    groups?: {
        [key: string]: string;
    };
}
interface RegExpExecArray {
    groups?: {
        [key: string]: string;
    };
}
interface RegExp {
    readonly dotAll: boolean;
}
`;
