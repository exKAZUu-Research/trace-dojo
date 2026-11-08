import { addConstant, addMethod, newString, type Registry } from './builtinSupport';
import { throwBuiltin } from './runtime';
import { type ClassInfo, type JavaType, type MethodInfo, type NativeMethod } from './types';
import { JavaObject, type Value } from './values';

/** The constants of `Locale` defined here, by name, with their language and country. */
const LOCALES = [
  ['ROOT', '', ''],
  ['ENGLISH', 'en', ''],
  ['US', 'en', 'US'],
  ['UK', 'en', 'GB'],
  ['JAPANESE', 'ja', ''],
  ['JAPAN', 'ja', 'JP'],
] as const;

interface LocaleTag {
  language: string;
  country: string;
}

const localeTags = new WeakMap<JavaObject, LocaleTag>();

/**
 * `java.util.Locale`'s common constants, which the locale-taking overloads of `toLowerCase`, `toUpperCase`,
 * `String.format`, and `printf` accept; these locales case-map and format text as the overloads without one do.
 */
export function defineLocale(
  registry: Registry,
  objectClass: ClassInfo,
  stringClass: ClassInfo,
  printStreamClass: ClassInfo
): void {
  const locale = registry.define('Locale', objectClass, 'java.util');
  locale.isFinal = true;
  for (const [name, language, country] of LOCALES) {
    const object = new JavaObject(locale);
    localeTags.set(object, { language, country });
    addConstant(locale, name, locale.type, object);
  }
  const stringType = stringClass.type;
  addMethod(locale, 'getLanguage', [], stringType, false, (frame, receiver) =>
    newString(frame, tagOf(receiver).language)
  );
  addMethod(locale, 'getCountry', [], stringType, false, (frame, receiver) =>
    newString(frame, tagOf(receiver).country)
  );
  addMethod(locale, 'toString', [], stringType, false, (frame, receiver) => {
    const { language, country } = tagOf(receiver);
    return newString(frame, country ? `${language}_${country}` : language);
  });
  for (const name of ['toLowerCase', 'toUpperCase']) {
    const native = nativeOf(stringClass, name, []);
    addMethod(stringClass, name, [locale.type], stringType, false, (frame, receiver, [given]) => {
      if (given === undefined) throwBuiltin(frame, 'NullPointerException');
      return native(frame, receiver, []);
    });
  }
  withLocaleFirst(stringClass, 'format', locale.type, true);
  for (const name of ['printf', 'format']) withLocaleFirst(printStreamClass, name, locale.type, false);
}

function tagOf(receiver: Value): LocaleTag {
  return localeTags.get(receiver as JavaObject) as LocaleTag;
}

function nativeOf(cls: ClassInfo, name: string, parameterTypes: readonly JavaType[]): NativeMethod {
  const method = cls.methods.find(
    (candidate) => candidate.name === name && candidate.parameterTypes.length === parameterTypes.length
  ) as MethodInfo;
  return method.native as NativeMethod;
}

/** Adds an overload of the varargs formatting method `name` that takes a locale first and formats as it does. */
function withLocaleFirst(cls: ClassInfo, name: string, localeType: JavaType, isStatic: boolean): void {
  const base = cls.methods.find(
    (method) => method.name === name && method.isVarargs && method.parameterTypes.length === 2
  ) as MethodInfo;
  const native = base.native as NativeMethod;
  const method = addMethod(
    cls,
    name,
    [localeType, ...base.parameterTypes],
    base.returnType,
    isStatic,
    (frame, receiver, [, ...args]) => native(frame, receiver, args)
  );
  method.isVarargs = true;
}
