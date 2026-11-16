function loggingIdentity<Type>(arg: Type): Type {
  console.log(arg.length);
  return arg;
}
function getProperty<Type, Key extends keyof Type>(obj: Type, key: Key) {
  return obj[key];
}
let x = { a: 1, b: 2, c: 3, d: 4 };
getProperty(x, "m");
type Person = { age: number; name: string; alive: boolean };
type I1 = Person["alve"];
const key = "age";
type Age = Person[key];
function createLabel<T extends number | string>(idOrName: T) {}
createLabel(true);
type MessageOf<T> = T["message"];
type Getters<Type> = {
  [Property in keyof Type as `get${Capitalize<string & Property>}`]: () => Type[Property];
};
const g: Getters<{ name: string }> = { getName: () => 1 };
type Greeting = `hello ${"world" | "there"}`;
const greet: Greeting = "hello you";
type Up = Uppercase<"a">;
const up: Up = "a";
