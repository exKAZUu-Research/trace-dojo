import type { Realm } from './realm';
import { isAccessor, JsObject } from './values';

/**
 * The order V8 defines the members of each builtin in, which `Object.getOwnPropertyNames` and `console.dir` show;
 * members V8 has and this interpreter lacks are skipped.
 */
const V8_MEMBER_ORDER: Record<string, string> = {
  Math: 'abs,acos,acosh,asin,asinh,atan,atanh,atan2,ceil,cbrt,expm1,clz32,cos,cosh,exp,floor,f16round,fround,hypot,imul,log,log1p,log2,log10,max,min,pow,random,round,sign,sin,sinh,sqrt,tan,tanh,trunc,E,LN10,LN2,LOG10E,LOG2E,PI,SQRT1_2,SQRT2',
  'Array.prototype':
    'length,constructor,at,concat,copyWithin,fill,find,findIndex,findLast,findLastIndex,lastIndexOf,pop,push,reverse,shift,unshift,slice,sort,splice,includes,indexOf,join,keys,entries,values,forEach,filter,flat,flatMap,map,every,some,reduce,reduceRight,toReversed,toSorted,toSpliced,with,toLocaleString,toString',
  'String.prototype':
    'length,constructor,anchor,at,big,blink,bold,charAt,charCodeAt,codePointAt,concat,endsWith,fontcolor,fontsize,fixed,includes,indexOf,isWellFormed,italics,lastIndexOf,link,localeCompare,match,matchAll,normalize,padEnd,padStart,repeat,replace,replaceAll,search,slice,small,split,strike,sub,substr,substring,sup,startsWith,toString,toWellFormed,trim,trimStart,trimLeft,trimEnd,trimRight,toLocaleLowerCase,toLocaleUpperCase,toLowerCase,toUpperCase,valueOf',
  Object:
    'length,name,prototype,assign,getOwnPropertyDescriptor,getOwnPropertyDescriptors,getOwnPropertyNames,getOwnPropertySymbols,hasOwn,is,preventExtensions,seal,create,defineProperties,defineProperty,freeze,getPrototypeOf,setPrototypeOf,isExtensible,isFrozen,isSealed,keys,entries,fromEntries,values,groupBy',
  Number:
    'length,name,prototype,isFinite,isInteger,isNaN,isSafeInteger,parseFloat,parseInt,MAX_VALUE,MIN_VALUE,NaN,NEGATIVE_INFINITY,POSITIVE_INFINITY,MAX_SAFE_INTEGER,MIN_SAFE_INTEGER,EPSILON',
  'Number.prototype': 'constructor,toExponential,toFixed,toPrecision,toString,valueOf,toLocaleString',
  'Map.prototype':
    'constructor,get,set,has,delete,clear,entries,forEach,keys,size,values,getOrInsert,getOrInsertComputed',
  'Set.prototype':
    'constructor,has,add,delete,difference,clear,entries,forEach,intersection,isSubsetOf,isSupersetOf,isDisjointFrom,size,symmetricDifference,union,values,keys',
  Array: 'length,name,prototype,isArray,from,fromAsync,of',
  String: 'length,name,prototype,fromCharCode,fromCodePoint,raw',
  JSON: 'parse,stringify,rawJSON,isRawJSON',
  'Object.prototype':
    'constructor,__defineGetter__,__defineSetter__,hasOwnProperty,__lookupGetter__,__lookupSetter__,isPrototypeOf,propertyIsEnumerable,toString,valueOf,__proto__,toLocaleString',
  'Error.prototype': 'constructor,name,message,toString',
  'Function.prototype': 'length,name,constructor,apply,bind,call,toString,arguments,caller',
  Error: 'length,name,prototype,captureStackTrace,prepareStackTrace,isError,stackTraceLimit',
  Symbol:
    'length,name,prototype,for,keyFor,asyncIterator,hasInstance,isConcatSpreadable,iterator,match,matchAll,replace,search,species,split,toPrimitive,toStringTag,unscopables,dispose,asyncDispose',
  RegExp:
    "length,name,prototype,input,$_,lastMatch,$&,lastParen,$+,leftContext,$`,rightContext,$',$1,$2,$3,$4,$5,$6,$7,$8,$9,escape",
  'RegExp.prototype':
    'constructor,exec,dotAll,flags,global,hasIndices,ignoreCase,multiline,source,sticky,unicode,unicodeSets,compile,toString,test',
  console:
    'log,info,debug,warn,error,dir,time,timeEnd,timeLog,trace,assert,clear,count,countReset,group,groupEnd,table,dirxml,groupCollapsed,_stdoutErrorHandler,_stderrErrorHandler,_ignoreErrors,_times,Console,profile,profileEnd,timeStamp,context,createTask,_stdout,_stderr',
};

/** Reorders the members of the builtins as V8 defines them, keeping any other member after them. */
export function orderBuiltinMembers(realm: Realm): void {
  for (const [path, names] of Object.entries(V8_MEMBER_ORDER)) {
    const object = builtinAt(realm, path);
    if (!object) continue;
    const order = names.split(',');
    const rank = (key: unknown): number => {
      const index = typeof key === 'string' ? order.indexOf(key) : -1;
      return index === -1 ? order.length : index;
    };
    const entries = [...object.properties.entries()].toSorted(([a], [b]) => rank(a) - rank(b));
    object.properties.clear();
    for (const [key, property] of entries) object.properties.set(key, property);
  }
}

function builtinAt(realm: Realm, path: string): JsObject | undefined {
  const [name, member] = path.split('.');
  let value = realm.globals.bindings.get(name)?.value;
  if (member && value instanceof JsObject) {
    const property = value.properties.get(member);
    value = property && !isAccessor(property) ? property.value : undefined;
  }
  return value instanceof JsObject ? value : undefined;
}
