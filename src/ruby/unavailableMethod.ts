import type { NativeFn } from './objects';
import { coreMethodAliases } from './rubyCoreMethods';
import { UnsupportedFeatureError } from './runtime';

const unavailableIdentities = new Map<string, object>();
const aliasNames = new Map<string, string>(
  coreMethodAliases.flatMap(([owner, names]) =>
    names.map((name) => [`${owner}#${name}`, `${owner}#${names[0]}`] as const)
  )
);

export function unavailableMethod(feature: string): NativeFn {
  const key = aliasNames.get(feature) ?? feature;
  let nativeIdentity = unavailableIdentities.get(key);
  if (!nativeIdentity) {
    nativeIdentity = {};
    unavailableIdentities.set(key, nativeIdentity);
  }
  return Object.assign(
    (): never => {
      throw new UnsupportedFeatureError(feature);
    },
    { unavailable: true, nativeIdentity }
  );
}
