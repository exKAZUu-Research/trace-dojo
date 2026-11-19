/** The message for a feature this environment does not provide, as every language's interpreter words it. */
export function unsupportedMessage(feature: string): string {
  return `${feature}${/[!-~]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`;
}

/** Stops the program at a feature this environment does not provide, which the program cannot recover from. */
export class UnsupportedFeatureError extends Error {
  constructor(feature: string) {
    super(unsupportedMessage(feature));
    this.name = 'UnsupportedFeatureError';
  }
}
