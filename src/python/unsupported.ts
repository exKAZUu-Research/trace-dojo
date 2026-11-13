/** Stops a program at a feature this grader does not support, which no `except` clause may catch. */
export class UnsupportedFeatureError extends Error {
  constructor(feature: string) {
    super(`${feature}${/[!-~]$/.test(feature) ? ' ' : ''}は、この採点環境では使えません。`);
    this.name = 'UnsupportedFeatureError';
  }
}
