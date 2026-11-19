export const PCRE_WORKER_SOURCE = `
let pcre;
let sharedContext;
let sharedStack;
const patternCache = new Map();
const MAX_CACHED_PATTERNS = 16;

function pcreFunctions() {
  const koffi = require('koffi');
  const paths = process.platform === 'darwin'
    ? ['/opt/homebrew/opt/pcre2/lib/libpcre2-8.dylib', '/usr/local/opt/pcre2/lib/libpcre2-8.dylib', 'libpcre2-8.dylib']
    : process.platform === 'win32' ? ['pcre2-8.dll'] : ['libpcre2-8.so.0'];
  let library;
  for (const path of paths) {
    try {
      library = koffi.load(path);
      break;
    } catch {}
  }
  if (!library) return null;
  const bind = (signature) => library.func(signature);
  return {
    compile: bind('void* pcre2_compile_8(const uint8_t*, size_t, uint32_t, _Out_ int*, _Out_ size_t*, void*)'),
    makeCompileContext: bind('void* pcre2_compile_context_create_8(void*)'),
    freeCompileContext: bind('void pcre2_compile_context_free_8(void*)'),
    setExtraOptions: bind('int pcre2_set_compile_extra_options_8(void*, uint32_t)'),
    freeCode: bind('void pcre2_code_free_8(void*)'),
    jit: bind('int pcre2_jit_compile_8(void*, uint32_t)'),
    makeContext: bind('void* pcre2_match_context_create_8(void*)'),
    freeContext: bind('void pcre2_match_context_free_8(void*)'),
    makeStack: bind('void* pcre2_jit_stack_create_8(size_t, size_t, void*)'),
    freeStack: bind('void pcre2_jit_stack_free_8(void*)'),
    attachStack: bind('void pcre2_jit_stack_assign_8(void*, void*, void*)'),
    setMatchLimit: bind('int pcre2_set_match_limit_8(void*, uint32_t)'),
    setDepthLimit: bind('int pcre2_set_depth_limit_8(void*, uint32_t)'),
    makeData: bind('void* pcre2_match_data_create_from_pattern_8(void*, void*)'),
    freeData: bind('void pcre2_match_data_free_8(void*)'),
    match: bind('int pcre2_match_8(void*, const uint8_t*, size_t, size_t, uint32_t, void*, void*)'),
    offsets: bind('void* pcre2_get_ovector_pointer_8(void*)'),
    decodeOffsets: (pointer, count) => koffi.decode(pointer, 'size_t', count),
  };
}

function compilePcre({ source, options, restrictCaseless }) {
  const bytes = Buffer.from(source, 'latin1');
  const context = restrictCaseless ? pcre.makeCompileContext(null) : null;
  try {
    if (restrictCaseless && (!context || pcre.setExtraOptions(context, 0x80) !== 0)) return null;
    return pcre.compile(bytes, bytes.length, options, [0], [0], context);
  } finally {
    if (context) pcre.freeCompileContext(context);
  }
}

function ensureContext() {
  if (sharedContext) return sharedContext;
  sharedContext = pcre.makeContext(null);
  if (!sharedContext) return null;
  sharedStack = pcre.makeStack(32 * 1024, 192 * 1024, null);
  if (sharedStack) pcre.attachStack(sharedContext, null, sharedStack);
  pcre.setMatchLimit(sharedContext, 1_000_000);
  pcre.setDepthLimit(sharedContext, 100_000);
  return sharedContext;
}

function cachedPattern(pattern) {
  const key = pattern.options + ':' + (pattern.restrictCaseless ? 1 : 0) + ':' + pattern.source;
  const existing = patternCache.get(key);
  if (existing) {
    patternCache.delete(key);
    patternCache.set(key, existing);
    return existing;
  }
  const code = compilePcre(pattern);
  if (!code) return 'unsupported';
  const data = pcre.makeData(code, null);
  if (!data) {
    pcre.freeCode(code);
    return { pregError: 1 };
  }
  pcre.jit(code, 1); // PCRE2_JIT_COMPLETE
  if (patternCache.size >= MAX_CACHED_PATTERNS) {
    const oldestKey = patternCache.keys().next().value;
    const oldest = patternCache.get(oldestKey);
    patternCache.delete(oldestKey);
    pcre.freeData(oldest.data);
    pcre.freeCode(oldest.code);
  }
  const entry = { code, data };
  patternCache.set(key, entry);
  return entry;
}

function disposePcre() {
  if (!pcre) return;
  for (const entry of patternCache.values()) {
    pcre.freeData(entry.data);
    pcre.freeCode(entry.code);
  }
  patternCache.clear();
  if (sharedContext) {
    pcre.freeContext(sharedContext);
    sharedContext = undefined;
  }
  if (sharedStack) {
    pcre.freeStack(sharedStack);
    sharedStack = undefined;
  }
}

function nextUtf8Byte(subject, position) {
  do {
    position++;
  } while (position < subject.length && (subject[position] & 0xc0) === 0x80);
  return position;
}

function matchPcreBatch(pattern, subject, position, retry, utf8, limit, batchBudgetMs, noEmptyRemaining, lastEnd) {
  if (pcre === undefined) pcre = pcreFunctions();
  if (!pcre) return 'unsupported';
  const context = ensureContext();
  if (!context) {
    return { offsets: new Int32Array(0), nextPosition: position, nextRetry: retry, done: true, noEmptyRemaining, lastEnd, pregError: 1 };
  }
  const entry = cachedPattern(pattern);
  if (entry === 'unsupported') return 'unsupported';
  if ('pregError' in entry) {
    return { offsets: new Int32Array(0), nextPosition: position, nextRetry: retry, done: true, noEmptyRemaining, lastEnd, pregError: entry.pregError };
  }
  const retryFlags = 0x80000008; // PCRE2_ANCHORED | PCRE2_NOTEMPTY_ATSTART
  const deadline = batchBudgetMs > 0 ? performance.now() + batchBudgetMs : Infinity;
  const out = [];
  let matches = 0;
  let done = false;
  let pregError;
  while (position <= subject.length && matches < limit) {
    if (matches > 0 && batchBudgetMs > 0 && performance.now() >= deadline) break;
    const count = pcre.match(entry.code, subject, subject.length, position, retry ? retryFlags : 0, entry.data, context);
    if (count === -1) {
      if (!retry || position >= subject.length) {
        done = true;
        break;
      }
      retry = false;
      position = utf8 ? nextUtf8Byte(subject, position) : position + 1;
      continue;
    }
    if (count <= 0) {
      pregError = ({ [-47]: 2, [-53]: 3, [-46]: 6 })[count] ?? 1;
      done = true;
      break;
    }
    if (count > 257) {
      if (matches === 0) return 'unsupported';
      break;
    }
    const raw = pcre.decodeOffsets(pcre.offsets(entry.data), count * 2);
    const start = Number(raw[0]);
    const end = Number(raw[1]);
    out.push(count, start, end);
    for (let i = 2; i < raw.length; i += 2) {
      const gs = Number(raw[i]);
      const ge = Number(raw[i + 1]);
      if (gs <= ge && ge <= subject.length) out.push(gs, ge);
      else out.push(-1, -1);
    }
    matches++;
    position = end;
    retry = start === end;
    if (noEmptyRemaining > 0) {
      if (start !== lastEnd) noEmptyRemaining--;
      lastEnd = end;
      if (noEmptyRemaining === 0) {
        done = true;
        break;
      }
    }
  }
  if (position > subject.length) done = true;
  return { offsets: Int32Array.from(out), nextPosition: position, nextRetry: retry, done, noEmptyRemaining, lastEnd, pregError };
}
`;
