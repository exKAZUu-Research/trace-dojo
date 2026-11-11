// CPython's token and tokenize modules, over `_tokenize.TokenizerIter`, which gives the tokens of CPython's C tokenizer.
import { bytesLikeData } from '../bytesValues';
import { decodeBytes } from '../codecs';
import { registerModule } from '../modules';
import { callValue } from '../objects';
import { registerSourceModule } from '../sourceModules';
import { exceptionClassNamed, iteratorClass, newTuple, typeError, unbox } from '../types';
import { DONE, PyError, PyIterator, type PyValue } from '../values';
import { clinicArgs, type ClinicSpec } from './clinicArgs';
import { TokenizeError, Tokenizer } from './tokenizer';
import { TOKENIZE_SOURCE } from './tokenizeSource';
import { TOKEN_SOURCE } from './tokenSource';

const tokenizerIterClass = iteratorClass('TokenizerIter');
tokenizerIterClass.module = '_tokenize';

const TOKENIZER_ITER: ClinicSpec = {
  name: 'TokenizerIter',
  params: ['readline'],
  positionalOnly: 1,
  required: 1,
  keywordOnly: ['extra_tokens', 'encoding'],
};

tokenizerIterClass.construct = (cls, args, kwargs) => {
  const [readline, , encoding] = clinicArgs(TOKENIZER_ITER, args, kwargs);
  const tokens = new Tokenizer(() => readLine(readline as PyValue, encoding)).tokens();
  return new PyIterator(cls, () => {
    let step: IteratorResult<{ type: number; text: string; start: number[]; end: number[]; line: string }>;
    try {
      step = tokens.next();
    } catch (error) {
      throw error instanceof TokenizeError ? syntaxError(error) : error;
    }
    if (step.done) return DONE;
    const { type, text, start, end, line } = step.value;
    return newTuple([BigInt(type), text, position(start), position(end), line]);
  });
};

const position = (pair: number[]): PyValue => newTuple(pair.map(BigInt));

/** One line from `readline`, decoded when the tokenizer reads bytes, or undefined at the end of the input. */
function readLine(readline: PyValue, encoding: PyValue | undefined): string | undefined {
  let line: PyValue;
  try {
    line = callValue(readline, []);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.isSubclassOf(exceptionClassNamed('StopIteration')))
      return undefined;
    throw error;
  }
  const text = unbox(line);
  if (typeof text === 'string') return text;
  const data = bytesLikeData(line);
  if (data === undefined || encoding === undefined) {
    throw typeError(`readline() returned a non-string object`);
  }
  return decodeBytes(data, unbox(encoding) as string, 'strict');
}

function syntaxError(error: TokenizeError): PyError {
  const cls = exceptionClassNamed(error.kind);
  const details = newTuple(['<string>', BigInt(error.lineno), BigInt(error.offset), error.text]);
  return new PyError(callValue(cls, [error.message, details]) as never);
}

registerModule('_tokenize', () => new Map<string, PyValue>([['TokenizerIter', tokenizerIterClass]]));
registerSourceModule('token', TOKEN_SOURCE);
registerSourceModule('tokenize', TOKENIZE_SOURCE);
