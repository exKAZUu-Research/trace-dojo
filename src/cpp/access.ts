import type { Access, ClassInfo } from './types';

/**
 * Whether code in `here` (undefined outside every class) may name a member declared in `owner` with `access` through
 * the naming class `naming` (C++20 [class.access.base]p5), on an object of `objectClass` when the member is non-static
 * ([class.protected]).
 */
export function isMemberAccessible(
  access: Access,
  owner: ClassInfo,
  naming: ClassInfo,
  here: ClassInfo | undefined,
  objectClass?: ClassInfo
): boolean {
  const asMember = accessAsMemberOf(access, owner, naming);
  if (asMember && here === naming) return true;
  if (asMember === 'public') return true;
  if (
    asMember === 'protected' &&
    here?.isDerivedFrom(naming) &&
    accessAsMemberOf(access, owner, here) !== undefined &&
    (!objectClass || objectClass.isDerivedFrom(here))
  ) {
    return true;
  }
  return [naming.base, ...naming.secondaryBases.map((secondary) => secondary.cls)].some(
    (base) =>
      base !== undefined &&
      base.isDerivedFrom(owner) &&
      isBaseAccessible(naming, base, here) &&
      isMemberAccessible(access, owner, base, here, objectClass)
  );
}

/** Whether `base` is an accessible base class of `derived` in `here` (C++20 [class.access.base]p4). */
export function isBaseAccessible(derived: ClassInfo, base: ClassInfo, here: ClassInfo | undefined): boolean {
  const asMember = accessAsMemberOf('public', base, derived);
  if (asMember === 'public' || (asMember && here === derived)) return true;
  if (here && here !== derived && here.isDerivedFrom(derived) && accessAsMemberOf('public', base, here)) return true;
  for (let middle = derived.base; middle && middle !== base; middle = middle.base) {
    if (isBaseAccessible(derived, middle, here) && isBaseAccessible(middle, base, here)) return true;
  }
  return false;
}

/** The access a member declared in `owner` has as a member of the derived class `cls`, or undefined when none. */
export function accessAsMemberOf(access: Access, owner: ClassInfo, cls: ClassInfo): Access | undefined {
  if (cls === owner) return access;
  const inBase = cls.base && accessAsMemberOf(access, owner, cls.base);
  if (inBase && inBase !== 'private') return cls.baseAccess === 'public' ? inBase : cls.baseAccess;
  for (const secondary of cls.secondaryBases) {
    const inherited = accessAsMemberOf(access, owner, secondary.cls);
    if (inherited && inherited !== 'private') return secondary.access === 'public' ? inherited : secondary.access;
  }
  for (const base of cls.library?.additionalPublicBases ?? []) {
    const inherited = accessAsMemberOf(access, owner, base);
    if (inherited && inherited !== 'private') return inherited;
  }
}
