export const PCRE_WORKER_SOURCE = `
let pcre;

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

function matchPcre(pattern, subject, position, retry) {
  if (pcre === undefined) pcre = pcreFunctions();
  if (!pcre) return 'unsupported';
  const code = compilePcre(pattern);
  if (!code) return 'unsupported';
  let data, context, stack;
  try {
    context = pcre.makeContext(null);
    data = pcre.makeData(code, null);
    if (!context || !data) return { pregError: 1 };
    if (pcre.jit(code, 1) === 0) { // PCRE2_JIT_COMPLETE
      stack = pcre.makeStack(32 * 1024, 192 * 1024, null);
      if (stack) pcre.attachStack(context, null, stack);
    }
    pcre.setMatchLimit(context, 1_000_000);
    pcre.setDepthLimit(context, 100_000);
    const retryFlags = 0x80000008; // PCRE2_ANCHORED | PCRE2_NOTEMPTY_ATSTART
    const count = pcre.match(code, subject, subject.length, position, retry ? retryFlags : 0, data, context);
    if (count === -1) return null;
    if (count <= 0) {
      const pregError = ({ [-47]: 2, [-53]: 3, [-46]: 6 })[count] ?? 1;
      return { pregError };
    }
    if (count > 257) return 'unsupported';
    return matchOffsetRanges(pcre.decodeOffsets(pcre.offsets(data), count * 2), subject.length);
  } finally {
    if (data) pcre.freeData(data);
    if (context) pcre.freeContext(context);
    pcre.freeCode(code);
    if (stack) pcre.freeStack(stack);
  }
}

function matchOffsetRanges(offsets, subjectLength) {
  const groups = {};
  for (let i = 2; i < offsets.length; i += 2) {
    const start = Number(offsets[i]);
    const end = Number(offsets[i + 1]);
    if (start <= end && end <= subjectLength) groups['$' + i / 2] = [start, end];
  }
  return { range: [Number(offsets[0]), Number(offsets[1])], groups };
}
`;
