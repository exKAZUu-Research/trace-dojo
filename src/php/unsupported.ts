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

const SUPERGLOBALS = new Set(['_GET', '_POST', '_SERVER', '_ENV', '_COOKIE', '_FILES', '_REQUEST', '_SESSION']);

export function unavailableVariable(name: string): string | undefined {
  if (SUPERGLOBALS.has(name)) return `スーパーグローバル変数 $${name}`;
  if (name === 'argv' || name === 'argc') return `コマンドライン引数 $${name}`;
}

export function checkedDynamicVariable(name: string): string {
  const unavailable = unavailableVariable(name);
  if (unavailable) throw new UnsupportedFeatureError(unavailable);
  return name;
}
