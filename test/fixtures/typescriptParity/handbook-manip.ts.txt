function identity<Type>(arg: Type): Type {
  return arg;
}
let myIdentity: <Input>(arg: Input) => Input = identity;
let myIdentity2: { <Type>(arg: Type): Type } = identity;
interface GenericIdentityFn<Type> {
  (arg: Type): Type;
}
let myIdentity3: GenericIdentityFn<number> = identity;
class GenericNumber<NumType> {
  zeroValue: NumType;
  add: (x: NumType, y: NumType) => NumType;
  constructor(z: NumType, add: (x: NumType, y: NumType) => NumType) {
    this.zeroValue = z;
    this.add = add;
  }
}
let myGenericNumber = new GenericNumber<number>(0, (x, y) => x + y);
console.log(myGenericNumber.add(1, 2), myIdentity(1), myIdentity2("a"), myIdentity3(3));
interface Lengthwise {
  length: number;
}
function loggingIdentity<Type extends Lengthwise>(arg: Type): Type {
  console.log(arg.length);
  return arg;
}
loggingIdentity({ length: 10, value: 3 });
function getProperty<Type, Key extends keyof Type>(obj: Type, key: Key) {
  return obj[key];
}
let x = { a: 1, b: 2, c: 3, d: 4 };
console.log(getProperty(x, "a"));
type Point = { x: number; y: number };
type P = keyof Point;
const pk: P = "y";
type Arrayish = { [n: number]: unknown };
type A = keyof Arrayish;
const ak: A = 1;
type Mapish = { [k: string]: boolean };
type M = keyof Mapish;
const mk: M = 2;
let s = "hello";
let n: typeof s;
n = "x";
type Predicate = (x: unknown) => boolean;
type K = ReturnType<Predicate>;
const kk: K = true;
function f() {
  return { x: 10, y: 3 };
}
type PP = ReturnType<typeof f>;
const ppp: PP = { x: 1, y: 2 };
type Person = { age: number; name: string; alive: boolean };
type Age = Person["age"];
type I1 = Person["age" | "name"];
type I2 = Person[keyof Person];
type AliveOrName = "alive" | "name";
type I3 = Person[AliveOrName];
const i1: I1 = "s";
const i2: I2 = false;
const MyArray = [
  { name: "Alice", age: 15 },
  { name: "Bob", age: 23 },
];
type Person2 = (typeof MyArray)[number];
type Age2 = (typeof MyArray)[number]["age"];
const age2: Age2 = 3;
const p2: Person2 = { name: "n", age: 2 };
interface IdLabel {
  id: number;
}
interface NameLabel {
  name: string;
}
type NameOrId<T extends number | string> = T extends number ? IdLabel : NameLabel;
function createLabel<T extends number | string>(idOrName: T): NameOrId<T> {
  throw "unimplemented";
}
type MessageOf<T> = T extends { message: unknown } ? T["message"] : never;
interface Email {
  message: string;
}
type EmailMessageContents = MessageOf<Email>;
const emc: EmailMessageContents = "m";
type Flatten<T> = T extends any[] ? T[number] : T;
type Str = Flatten<string[]>;
type Num = Flatten<number>;
const fs: Str = "a";
const fn2: Num = 1;
type GetReturnType<Type> = Type extends (...args: never[]) => infer Return ? Return : never;
type Num2 = GetReturnType<() => number>;
type Str2 = GetReturnType<(x: string) => string>;
type Bools = GetReturnType<(a: boolean, b: boolean) => boolean[]>;
const n2: Num2 = 1;
const s2: Str2 = "s";
const b2: Bools = [true];
type ToArray<Type> = Type extends any ? Type[] : never;
type StrArrOrNumArr = ToArray<string | number>;
const sa: StrArrOrNumArr = ["a"];
type ToArrayNonDist<Type> = [Type] extends [any] ? Type[] : never;
type ArrOfStrOrNum = ToArrayNonDist<string | number>;
const ar: ArrOfStrOrNum = ["a", 1];
type OptionsFlags<Type> = {
  [Property in keyof Type]: boolean;
};
type Features = {
  darkMode: () => void;
  newUserProfile: () => void;
};
type FeatureOptions = OptionsFlags<Features>;
const fo: FeatureOptions = { darkMode: true, newUserProfile: false };
type CreateMutable<Type> = {
  -readonly [Property in keyof Type]: Type[Property];
};
type LockedAccount = {
  readonly id: string;
  readonly name: string;
};
type UnlockedAccount = CreateMutable<LockedAccount>;
const ua: UnlockedAccount = { id: "1", name: "n" };
ua.id = "2";
type Concrete<Type> = {
  [Property in keyof Type]-?: Type[Property];
};
type MaybeUser = {
  id: string;
  name?: string;
  age?: number;
};
type User = Concrete<MaybeUser>;
const user: User = { id: "1", name: "n", age: 1 };
type Getters<Type> = {
  [Property in keyof Type as `get${Capitalize<string & Property>}`]: () => Type[Property];
};
interface Person3 {
  name: string;
  age: number;
  location: string;
}
type LazyPerson = Getters<Person3>;
const lp: LazyPerson = { getName: () => "n", getAge: () => 1, getLocation: () => "l" };
type RemoveKindField<Type> = {
  [Property in keyof Type as Exclude<Property, "kind">]: Type[Property];
};
interface Circle {
  kind: "circle";
  radius: number;
}
type KindlessCircle = RemoveKindField<Circle>;
const kc: KindlessCircle = { radius: 1 };
type World = "world";
type Greeting = `hello ${World}`;
const gr: Greeting = "hello world";
type EmailLocaleIDs = "welcome_email" | "email_heading";
type FooterLocaleIDs = "footer_title" | "footer_sendoff";
type AllLocaleIDs = `${EmailLocaleIDs | FooterLocaleIDs}_id`;
const al: AllLocaleIDs = "footer_title_id";
type ShoutyGreeting = Uppercase<Greeting>;
type QuietGreeting = Lowercase<"HELLO">;
type ASCIICacheKey<Str extends string> = `ID-${Uppercase<Str>}`;
type MainID = ASCIICacheKey<"my_app">;
const mid: MainID = "ID-MY_APP";
const sh: ShoutyGreeting = "HELLO WORLD";
const qg: QuietGreeting = "hello";
type UncomfortableGreeting = Uncapitalize<"Hello World">;
const ug: UncomfortableGreeting = "hello World";
console.log(pk, ak, mk, n, kk, ppp, i1, i2, age2, p2, emc, fs, fn2, n2, s2, b2, sa, ar, fo, ua, user, lp.getName(), kc, gr, al, mid, sh, qg, ug);
