const { existsSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { z } = require('zod');

const directory = z.string().parse(process.argv[2]);
const config = z
  .object({ wasm: z.string(), bridge: z.string() })
  .parse(JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8')));
const requestSchema = z.object({
  id: z.number().int().positive(),
  program: z.number().int().positive(),
  maxSlots: z.number().int().nonnegative(),
  maxRanges: z.number().int().positive(),
  source: z.string(),
  flags: z.number().int().min(0).max(7),
  text: z.string(),
  start: z.number().int().nonnegative(),
  timeout: z.number().positive(),
});
const { DefaultRubyVM } = require(config.bridge);

process.stdin.on('end', () => {
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
});
process.stdin.resume();

const respond = (response) => {
  writeFileSync(path.join(directory, 'response.next'), JSON.stringify(response), { mode: 0o600 });
  renameSync(path.join(directory, 'response.next'), path.join(directory, 'response.json'));
};

// code-gauge-allow functionNcss 33 -- The VM, its per-run pattern cache and the sequential request loop share one subprocess lifetime.
async function main() {
  const module = await WebAssembly.compile(readFileSync(config.wasm));
  const { vm } = await DefaultRubyVM(module, { consolePrint: false });
  const compile = vm.eval(`$VERBOSE = nil
->(source, flags) do
  Regexp.new(source.to_s, flags.to_s.to_i)
rescue RegexpError
  nil
end`);
  const search = vm.eval(`->(regexp, text, position, timeout, max_slots, max_ranges) do
  return '{"result":"unsupported","batch":null}' if regexp.nil?
  pos = position.to_s.to_i
  seconds = timeout.to_s.to_f
  Regexp.timeout = seconds
  first = regexp.match(text, pos)
  encode = ->(match) do
    match ? "[" + (0...match.length).map { |i|
      match.begin(i) ? "[#{match.begin(i)},#{match.end(i)}]" : "null"
    }.join(",") + "]" : "null"
  end
  result = encode.call(first)
  count = first ? first.length : regexp.source.length / 2 + 1
  available = max_slots.to_s.to_i - (first ? 1 + first.length * 3 : 1) - 4
  capacity = [[available / (count * 3 + 1), (max_ranges.to_s.to_i - count) / count, 64].min, 0].max
  extra = "null"
  if seconds > 0.01 && capacity > 0
    from = [pos - capacity / 2, 0].max
    cursor = from
    through = from - 1
    rows = []
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + [seconds, 0.005].min
    while rows.length < capacity && cursor <= text.length
      left = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      break if left <= 0
      Regexp.timeout = [seconds, left].min
      begin
        match = regexp.match(text, cursor)
      rescue Regexp::TimeoutError
        break
      end
      unless match
        through = text.length
        break
      end
      rows << encode.call(match)
      through = match.begin(0)
      cursor = through + 1
    end
    if through >= from
      extra = '{"from":' + from.to_s + ',"through":' + through.to_s + ',"matches":[' + rows.join(",") + ']}'
    end
  end
  '{"result":' + result + ',"batch":' + extra + '}'
rescue Regexp::TimeoutError
  '{"result":"timeout","batch":null}'
end`);
  const patterns = new Map();
  let lastId = 0;
  let program;
  const perform = (request) => {
    try {
      if (program !== request.program) {
        patterns.clear();
        program = request.program;
      }
      const key = JSON.stringify([request.source, request.flags]);
      let pattern = patterns.get(key);
      if (!pattern) {
        pattern = { regexp: compile.call('call', vm.wrap(request.source), vm.wrap(request.flags)) };
        patterns.set(key, pattern);
      }
      if (pattern.text !== request.text) {
        pattern.subject = vm.wrap(request.text).call('to_s');
        pattern.text = request.text;
      }
      const result = JSON.parse(
        search
          .call(
            'call',
            pattern.regexp,
            pattern.subject,
            vm.wrap(request.start),
            vm.wrap(request.timeout),
            vm.wrap(request.maxSlots),
            vm.wrap(request.maxRanges)
          )
          .toString()
      );
      respond({ status: 'ok', id: request.id, ...result });
    } catch (error) {
      respond({ status: 'error', id: request.id, message: String(error) });
    }
  };
  while (true) {
    const requestPath = path.join(directory, `request-${lastId + 1}.json`);
    if (!existsSync(requestPath)) {
      await delay(1);
      continue;
    }
    const request = requestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
    rmSync(requestPath);
    lastId = request.id;
    perform(request);
  }
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- The subprocess entry uses CommonJS on both Node and Bun.
main().catch((error) => {
  writeFileSync(path.join(directory, 'fatal.json'), JSON.stringify({ message: String(error) }), { mode: 0o600 });
  process.exitCode = 1;
});
