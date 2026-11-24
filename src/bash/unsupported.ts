const UNSUPPORTED_SUFFIX = 'は、この採点環境では使えません。';

/** The message for a feature this environment does not provide, as every language's interpreter words it. */
export function unsupportedMessage(feature: string): string {
  if (feature.endsWith(UNSUPPORTED_SUFFIX)) return feature;
  return `${feature}${/[!-~]$/.test(feature) ? ' ' : ''}${UNSUPPORTED_SUFFIX}`;
}

/** Stops the program at a feature this environment does not provide, which the program cannot recover from. */
export class UnsupportedFeatureError extends Error {
  constructor(feature: string) {
    super(unsupportedMessage(feature));
    this.name = 'UnsupportedFeatureError';
  }
}
