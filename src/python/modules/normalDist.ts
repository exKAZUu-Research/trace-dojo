import { fma, vectorNorm } from '../floatArithmetic';
import { pyHash } from '../hashing';
import { importModule } from '../modules';
import { floatRepr } from '../numbers';
import { callValue, getAttribute } from '../objects';
import { binaryOp, compareOp, unaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { toFloat } from '../typeNumbers';
import {
  classOf,
  exceptionClassNamed,
  newException,
  newList,
  newTuple,
  None,
  NotImplemented,
  objectClass,
  typeClass,
  typeError,
} from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { type Kwargs, PyClass, PyError, PyInstance, type PyValue } from '../values';
import { builtinClassWithBase } from './moduleClasses';
import { bindArguments, defineProperty, defineSlot, pythonMethod } from './numberSupport';
import { keyOf, MersenneTwister, seedOf } from './random';
import { meanAndStdev } from './statistics';

export const statisticsErrorClass = builtinClassWithBase(
  'StatisticsError',
  exceptionClassNamed('ValueError'),
  'statistics'
);

export function statisticsError(message: string): PyError {
  return new PyError(newException(statisticsErrorClass, [message]));
}

/** A `statistics.NormalDist`. */
class PyNormalDist extends PyInstance {
  mu = 0;
  sigma = 1;
}

export const normalDistClass = new PyClass('NormalDist', [objectClass], typeClass);
normalDistClass.mro = [normalDistClass, objectClass];
normalDistClass.module = 'statistics';
normalDistClass.isBaseType = true;

const INIT = { qualified: 'NormalDist.__init__', params: ['mu', 'sigma'], required: 0 };

normalDistClass.construct = (cls: PyClass, args: PyValue[], kwargs: Kwargs) => {
  const instance = new PyNormalDist(cls);
  if (cls === normalDistClass) initialize(instance, bindArguments(INIT, args, kwargs));
  return instance;
};

function initialize(self: PyNormalDist, [mu, sigma]: (PyValue | undefined)[]): void {
  if (sigma !== undefined && compareOp('<', sigma, 0) === true) throw statisticsError('sigma must be non-negative');
  self.mu = toFloat(mu ?? 0);
  self.sigma = toFloat(sigma ?? 1);
}

function newNormalDist(mu: PyValue, sigma: PyValue): PyNormalDist {
  return callValue(normalDistClass, [mu, sigma]) as PyNormalDist;
}

const dist = (value: PyValue): PyNormalDist => value as PyNormalDist;

pythonMethod(normalDistClass, { params: ['mu', 'sigma'], required: 0 }, '__init__', (self, args) => {
  initialize(dist(self), args);
  return None;
});

pythonMethod(
  normalDistClass,
  { params: ['data'], required: 1 },
  'from_samples',
  (cls, [data]) => {
    const [mu, sigma] = meanAndStdev(data as PyValue);
    return callValue(cls as PyClass, [mu, sigma]);
  },
  'class'
);

defineSlot(normalDistClass, 'samples', (self, args, kwargs) => {
  const seed = kwargs?.get('seed');
  const rest = new Map([...(kwargs ?? [])].filter(([key]) => key !== 'seed'));
  const [n] = bindArguments(SAMPLES, args, rest.size > 0 ? rest : undefined);
  return samples(dist(self), n as PyValue, seed);
});

const SAMPLES = { qualified: 'NormalDist.samples', params: ['n'], required: 1 };

function samples(self: PyNormalDist, n: PyValue, seed: PyValue | undefined): PyValue {
  let next: () => number;
  if (seed === undefined || seed === None) {
    const random = importModule(currentRuntime(), 'random').dict.get('random') as PyValue;
    next = () => toFloat(callValue(random, []));
  } else {
    const generator = new MersenneTwister();
    generator.initByArray(keyOf(seedOf(seed)));
    next = () => generator.random();
  }
  const count = Number(n as bigint);
  const runtime = currentRuntime();
  runtime.ensureRoom(count);
  const result: PyValue[] = [];
  for (let index = 0; index < count; index++) {
    runtime.spend();
    result.push(inverseCdf(next(), self.mu, self.sigma));
  }
  return newList(result);
}

pythonMethod(normalDistClass, { params: ['x'], required: 1 }, 'pdf', (self, [x]) => {
  const { mu, sigma } = dist(self);
  const variance = sigma * sigma;
  if (!variance) throw statisticsError('pdf() not defined when sigma is zero');
  const diff = toFloat(binaryOp('-', x as PyValue, mu));
  return Math.exp((diff * diff) / (-2 * variance)) / Math.sqrt(2 * Math.PI * variance);
});

pythonMethod(normalDistClass, { params: ['x'], required: 1 }, 'cdf', () => {
  // Uses the C library's erfc, whose results JavaScript cannot reproduce in the last bit.
  throw new UnsupportedFeatureError('statistics.NormalDist.cdf()');
});

pythonMethod(normalDistClass, { params: ['other'], required: 1 }, 'overlap', (self, [other]) => {
  if (!(other instanceof PyNormalDist)) throw typeError('Expected another NormalDist instance');
  if (!dist(self).sigma || !other.sigma) throw statisticsError('overlap() not defined when sigma is zero');
  // Uses the C library's erfc, whose results JavaScript cannot reproduce in the last bit.
  throw new UnsupportedFeatureError('statistics.NormalDist.overlap()');
});

pythonMethod(normalDistClass, { params: ['p'], required: 1 }, 'inv_cdf', (self, [p]) => {
  if (compareOp('<=', p as PyValue, 0) === true || compareOp('>=', p as PyValue, 1) === true) {
    throw statisticsError('p must be in the range 0.0 < p < 1.0');
  }
  return inverseCdf(toFloat(p as PyValue), dist(self).mu, dist(self).sigma);
});

pythonMethod(normalDistClass, { params: ['n'], required: 0 }, 'quantiles', (self, [nValue]) => {
  const n = nValue ?? 4n;
  const inverse = getAttribute(self, 'inv_cdf');
  const result: PyValue[] = [];
  for (let i = 1n; compareOp('<', i, n) === true; i++) result.push(callValue(inverse, [binaryOp('/', i, n)]));
  return newList(result);
});

pythonMethod(normalDistClass, { params: ['x'], required: 1 }, 'zscore', (self, [x]) => {
  const { mu, sigma } = dist(self);
  if (!sigma) throw statisticsError('zscore() not defined when sigma is zero');
  return binaryOp('/', binaryOp('-', x as PyValue, mu), sigma);
});

defineProperty(normalDistClass, 'mean', (self) => dist(self).mu);
defineProperty(normalDistClass, 'median', (self) => dist(self).mu);
defineProperty(normalDistClass, 'mode', (self) => dist(self).mu);
defineProperty(normalDistClass, 'stdev', (self) => dist(self).sigma);
defineProperty(normalDistClass, 'variance', (self) => dist(self).sigma * dist(self).sigma);
defineProperty(normalDistClass, '_mu', (self) => dist(self).mu);
defineProperty(normalDistClass, '_sigma', (self) => dist(self).sigma);

const isDist = (value: PyValue): value is PyNormalDist => value instanceof PyNormalDist;

const binary = (name: string, run: (self: PyNormalDist, other: PyValue) => PyValue): void => {
  pythonMethod(normalDistClass, { params: ['x2'], required: 1 }, name, (self, [other]) =>
    run(dist(self), other as PyValue)
  );
};

const add = (self: PyNormalDist, other: PyValue): PyValue =>
  isDist(other)
    ? newNormalDist(self.mu + other.mu, vectorNorm([self.sigma, other.sigma]))
    : newNormalDist(binaryOp('+', self.mu, other), self.sigma);
const subtract = (self: PyNormalDist, other: PyValue): PyValue =>
  isDist(other)
    ? newNormalDist(self.mu - other.mu, vectorNorm([self.sigma, other.sigma]))
    : newNormalDist(binaryOp('-', self.mu, other), self.sigma);
const multiply = (self: PyNormalDist, other: PyValue): PyValue =>
  newNormalDist(binaryOp('*', self.mu, other), self.sigma * Math.abs(toFloat(other)));

binary('__add__', add);
binary('__radd__', add);
binary('__sub__', subtract);
binary('__rsub__', (self, other) => unaryOp('-', subtract(self, other)));
binary('__mul__', multiply);
binary('__rmul__', multiply);
binary('__truediv__', (self, other) =>
  newNormalDist(binaryOp('/', self.mu, other), self.sigma / Math.abs(toFloat(other)))
);
pythonMethod(normalDistClass, { params: [], required: 0 }, '__pos__', (self) =>
  newNormalDist(dist(self).mu, dist(self).sigma)
);
pythonMethod(normalDistClass, { params: [], required: 0 }, '__neg__', (self) =>
  newNormalDist(-dist(self).mu, dist(self).sigma)
);
binary('__eq__', (self, other) =>
  isDist(other) ? self.mu === other.mu && self.sigma === other.sigma : NotImplemented
);
pythonMethod(normalDistClass, { params: [], required: 0 }, '__hash__', (self) =>
  pyHash(newTuple([dist(self).mu, dist(self).sigma]))
);
pythonMethod(
  normalDistClass,
  { params: [], required: 0 },
  '__repr__',
  (self) => `${classOf(self).name}(mu=${floatRepr(dist(self).mu)}, sigma=${floatRepr(dist(self).sigma)})`
);

/** `_normal_dist_inv_cdf` of the C module `_statistics`, whose polynomials the compiler contracts into fmas. */
// code-gauge-allow functionNcss 31 -- Transcribes _normal_dist_inv_cdf of _statisticsmodule.c.
function inverseCdf(p: number, mu: number, sigma: number): number {
  if (p <= 0 || p >= 1) throw typeErrorOrValue();
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = fma(-q, q, 0.180625);
    const num = horner(CENTRAL_NUMERATOR, r) * q;
    const den = horner(CENTRAL_DENOMINATOR, r);
    if (den === 0) throw typeErrorOrValue();
    return fma(num / den, sigma, mu);
  }
  let r = q <= 0 ? p : 1 - p;
  if (r <= 0 || r >= 1) throw typeErrorOrValue();
  r = Math.sqrt(-Math.log(r));
  let num: number;
  let den: number;
  if (r <= 5) {
    r -= 1.6;
    num = horner(NEAR_NUMERATOR, r);
    den = horner(NEAR_DENOMINATOR, r);
  } else {
    r -= 5;
    num = horner(FAR_NUMERATOR, r);
    den = horner(FAR_DENOMINATOR, r);
  }
  if (den === 0) throw typeErrorOrValue();
  let x = num / den;
  if (q < 0) x = -x;
  return fma(x, sigma, mu);
}

function typeErrorOrValue(): PyError {
  return new PyError(newException(exceptionClassNamed('ValueError'), ['inv_cdf undefined for these parameters']));
}

/** Evaluates a polynomial from its highest coefficient, as `((c0 * r + c1) * r + c2) ...` contracted into fmas. */
function horner(coefficients: readonly number[], r: number): number {
  let result = coefficients[0];
  for (const coefficient of coefficients.slice(1)) result = fma(result, r, coefficient);
  return result;
}

// The coefficients as the C source writes them, which parse to the same doubles.
// prettier-ignore
const CENTRAL_NUMERATOR = ['2.5090809287301226727e+3', '3.3430575583588128105e+4', '6.7265770927008700853e+4', '4.5921953931549871457e+4', '1.3731693765509461125e+4', '1.9715909503065514427e+3', '1.3314166789178437745e+2', '3.3871328727963666080e+0'].map(Number);
// prettier-ignore
const CENTRAL_DENOMINATOR = ['5.2264952788528545610e+3', '2.8729085735721942674e+4', '3.9307895800092710610e+4', '2.1213794301586595867e+4', '5.3941960214247511077e+3', '6.8718700749205790830e+2', '4.2313330701600911252e+1', '1.0'].map(Number);
// prettier-ignore
const NEAR_NUMERATOR = ['7.74545014278341407640e-4', '2.27238449892691845833e-2', '2.41780725177450611770e-1', '1.27045825245236838258e+0', '3.64784832476320460504e+0', '5.76949722146069140550e+0', '4.63033784615654529590e+0', '1.42343711074968357734e+0'].map(Number);
// prettier-ignore
const NEAR_DENOMINATOR = ['1.05075007164441684324e-9', '5.47593808499534494600e-4', '1.51986665636164571966e-2', '1.48103976427480074590e-1', '6.89767334985100004550e-1', '1.67638483018380384940e+0', '2.05319162663775882187e+0', '1.0'].map(Number);
// prettier-ignore
const FAR_NUMERATOR = ['2.01033439929228813265e-7', '2.71155556874348757815e-5', '1.24266094738807843860e-3', '2.65321895265761230930e-2', '2.96560571828504891230e-1', '1.78482653991729133580e+0', '5.46378491116411436990e+0', '6.65790464350110377720e+0'].map(Number);
// prettier-ignore
const FAR_DENOMINATOR = ['2.04426310338993978564e-15', '1.42151175831644588870e-7', '1.84631831751005468180e-5', '7.86869131145613259100e-4', '1.48753612908506148525e-2', '1.36929880922735805310e-1', '5.99832206555887937690e-1', '1.0'].map(Number);
