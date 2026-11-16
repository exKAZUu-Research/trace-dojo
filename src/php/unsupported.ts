/** The message of a feature this grader does not provide. */
export function unsupportedMessage(what: string): string {
  return `${what}は、この採点環境では使えません。`;
}

/** Stops a program that uses a feature this grader does not provide; the program cannot catch it. */
export class UnsupportedFeatureError extends Error {
  constructor(what: string) {
    super(unsupportedMessage(what));
    this.name = 'UnsupportedFeatureError';
  }
}
