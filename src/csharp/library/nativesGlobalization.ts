import { type Culture, CultureInfoState, cultureNamed, cultureSettingsOf, INVARIANT, isCultureInfo } from '../cultures';
import { defineNatives, type NativeCall } from '../natives';
import { primitiveHash } from '../objects';
import { CsObject, type Value } from '../values';
import { fail, failNull, libraryType, unsupportedCall } from './support';

const CULTURE_INFO = 'System.Globalization.CultureInfo';

function newCultureInfo(call: NativeCall, culture: Culture, isReadOnly: boolean): CsObject {
  const object = new CsObject(libraryType(call, CULTURE_INFO), []);
  object.native = new CultureInfoState(culture, isReadOnly);
  return object;
}

export function invariantObject(call: NativeCall): CsObject {
  const { objects } = cultureSettingsOf(call.frame.runtime);
  objects.invariant ??= newCultureInfo(call, INVARIANT, true);
  return objects.invariant;
}

/** The current culture's object, which in globalization-invariant mode is `InvariantCulture` itself. */
function currentObject(call: NativeCall, which: 'current' | 'currentUi'): CsObject {
  const settings = cultureSettingsOf(call.frame.runtime);
  const objects = settings.objects;
  objects[which] ??= settings.isGlobalizationInvariant
    ? invariantObject(call)
    : newCultureInfo(call, settings[which], true);
  return objects[which];
}

function setCurrent(call: NativeCall, which: 'current' | 'currentUi', value: Value): void {
  if (!isCultureInfo(value)) failNull('value');
  const settings = cultureSettingsOf(call.frame.runtime);
  settings[which] = value.native.culture;
  settings.objects[which] = value;
}

/**
 * The culture of a name, which in globalization-invariant mode can only be the invariant one, as .NET's
 * CultureNotFoundException says with the name as given (`GetCultureInfo` gives it in lowercase).
 */
function cultureOfName(call: NativeCall, name: Value, shownName: (name: string) => string): Culture {
  if (name === undefined) failNull('name');
  const text = name as string;
  const notFound = (reason: string): never =>
    fail(
      'System.Globalization.CultureNotFoundException',
      `${reason} (Parameter 'name')\n${shownName(text)} is an invalid culture identifier.`
    );
  if (cultureSettingsOf(call.frame.runtime).isGlobalizationInvariant && text !== '')
    notFound(
      'Only the invariant culture is supported in globalization-invariant mode. See https://aka.ms/GlobalizationInvariantMode for more information.'
    );
  const culture = cultureNamed(text);
  if (culture === 'invalid') return notFound('Culture is not supported.');
  return culture ?? unsupportedCall(call, `カルチャ（${text}）`);
}

function cultureOf(receiver: Value): Culture {
  return (receiver as CsObject & { native: CultureInfoState }).native.culture;
}

defineNatives({
  [`${CULTURE_INFO}..ctor`]: (call, receiver, [name]) => {
    (receiver as CsObject).native = new CultureInfoState(
      cultureOfName(call, name as Value, (text) => text),
      false
    );
    return;
  },
  [`${CULTURE_INFO}.get_CurrentCulture`]: (call) => currentObject(call, 'current'),
  [`${CULTURE_INFO}.set_CurrentCulture`]: (call, _receiver, [value]) => {
    setCurrent(call, 'current', value as Value);
    return;
  },
  [`${CULTURE_INFO}.get_CurrentUICulture`]: (call) => currentObject(call, 'currentUi'),
  [`${CULTURE_INFO}.set_CurrentUICulture`]: (call, _receiver, [value]) => {
    setCurrent(call, 'currentUi', value as Value);
    return;
  },
  [`${CULTURE_INFO}.get_InvariantCulture`]: (call) => invariantObject(call),
  [`${CULTURE_INFO}.GetCultureInfo`]: (call, _receiver, [name]) => {
    const culture = cultureOfName(call, name as Value, (text) => text.toLowerCase());
    const { cached } = cultureSettingsOf(call.frame.runtime).objects;
    let object = cached.get(culture.name);
    if (!object) {
      object = newCultureInfo(call, culture, true);
      cached.set(culture.name, object);
    }
    return object;
  },
  [`${CULTURE_INFO}.get_Name`]: (_call, receiver) => cultureOf(receiver).name,
  [`${CULTURE_INFO}.get_DisplayName`]: (_call, receiver) => cultureOf(receiver).displayName,
  [`${CULTURE_INFO}.get_EnglishName`]: (_call, receiver) => cultureOf(receiver).englishName,
  [`${CULTURE_INFO}.get_NativeName`]: (_call, receiver) => cultureOf(receiver).nativeName,
  [`${CULTURE_INFO}.get_TwoLetterISOLanguageName`]: (_call, receiver) => cultureOf(receiver).twoLetterIsoLanguageName,
  [`${CULTURE_INFO}.get_IsReadOnly`]: (_call, receiver) =>
    (receiver as CsObject & { native: CultureInfoState }).native.isReadOnly,
  // The format objects that .NET returns, NumberFormatInfo and DateTimeFormatInfo, are types this grader lacks, so a
  // program can ask only for other types, which get null.
  [`${CULTURE_INFO}.GetFormat`]: () => {},
  [`${CULTURE_INFO}.Equals`]: (_call, receiver, [other]) =>
    isCultureInfo(other as Value) && cultureOf(other as Value) === cultureOf(receiver),
  [`${CULTURE_INFO}.GetHashCode`]: (_call, receiver) => primitiveHash(cultureOf(receiver).name) ?? 0,
  [`${CULTURE_INFO}.ToString`]: (_call, receiver) => cultureOf(receiver).name,
});
