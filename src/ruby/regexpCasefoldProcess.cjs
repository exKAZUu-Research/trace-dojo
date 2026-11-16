const { readFileSync } = require('node:fs');

const request = JSON.parse(readFileSync(0, 'utf8'));
const { DefaultRubyVM } = require(request.bridge);

async function main() {
  const module = await WebAssembly.compile(readFileSync(request.wasm));
  const { vm } = await DefaultRubyVM(module, { consolePrint: false });
  const search = vm.eval(`$VERBOSE = nil
->(source, flags, text, position, timeout) do
  regexp = Regexp.new(source.to_s, flags.to_s.to_i)
  Regexp.timeout = timeout.to_s.to_f
  match = regexp.match(text.to_s, position.to_s.to_i)
  return "null" unless match
  "[" + (0...match.length).map { |i|
    match.begin(i) ? "[#{match.begin(i)},#{match.end(i)}]" : "null"
  }.join(",") + "]"
rescue Regexp::TimeoutError
  '"timeout"'
rescue RegexpError
  '"unsupported"'
end`);
  process.stdout.write(
    search
      .call(
        'call',
        vm.wrap(request.source),
        vm.wrap(request.flags),
        vm.wrap(request.text),
        vm.wrap(request.start),
        vm.wrap(request.timeout)
      )
      .toString()
  );
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- The subprocess entry uses CommonJS on both Node and Bun.
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
