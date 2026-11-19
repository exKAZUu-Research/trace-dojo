import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const run = (program: string): ReturnType<typeof executeProgram> => executeProgram('php', program);

test.each([
  ['object properties', '$held = (object) ["a" => new D(1), "b" => new D(2), "c" => new D(3)];'],
  ['storage entries', '$held = new SplObjectStorage; for ($i = 1; $i <= 3; $i++) $held[new stdClass] = new D($i);'],
])('continues object shutdown after a detached static fails through %s', (_description, setup) => {
  const program = `<?php
    error_reporting(0);
    class D {
      function __construct(public $id) {}
      function __destruct() { echo $this->id, ';'; if ($this->id === 1) throw new Exception('stop batch'); }
    }
    static $held;
    ${setup}
    unset($held);
    echo 'done;';`;
  expect(run(program)).toMatchObject({ kind: 'executed', stdout: 'done;1;2;3;' });
});

test('resolves namespace-relative literal constants in the global namespace', () => {
  expect(run(String.raw`<?php var_dump(namespace\TrUe, namespace\false, namespace\NULL);`)).toMatchObject({
    kind: 'executed',
    stdout: 'bool(true)\nbool(false)\nNULL\n',
  });
});

test.each([
  [String.raw`try {} catch (\self $error) {}`, String.raw`'\self' is an invalid class name`],
  [String.raw`try {} catch (A|\static $error) {}`, String.raw`'\static' is an invalid class name`],
  [String.raw`new \self;`, String.raw`'\self' is an invalid class name`],
  [String.raw`\SELF::VALUE;`, String.raw`'\SELF' is an invalid class name`],
  [String.raw`\self::call();`, String.raw`'\self' is an invalid class name`],
  [String.raw`\parent::$value;`, String.raw`'\parent' is an invalid class name`],
  [String.raw`class A extends \self {}`, String.raw`'\self' is an invalid class name`],
  [String.raw`class A implements \parent {}`, String.raw`'\parent' is an invalid class name`],
  [String.raw`class A { use \self; }`, String.raw`'\self' is an invalid class name`],
  [String.raw`try {} catch (namespace\self $error) {}`, 'Bad class name in the catch statement'],
  [String.raw`class A extends namespace\Self {}`, 'Cannot use "Self" as class name, as it is reserved'],
  [String.raw`class A implements namespace\parent {}`, 'Cannot use "parent" as interface name, as it is reserved'],
  [String.raw`class A { use namespace\self; }`, 'Cannot use "self" as trait name, as it is reserved'],
  [String.raw`function f(): namespace\static {}`, "Type declaration 'static' must be unqualified"],
  [String.raw`function f(A\int $value) {}`, String.raw`Cannot use "A\int" as a type name as it is reserved`],
  [
    String.raw`namespace N; class T { public ?App\Mixed $value; }`,
    String.raw`Cannot use "N\App\Mixed" as a type name as it is reserved`,
  ],
  [
    String.raw`use A\int as I; function f(I $value) {}`,
    String.raw`Cannot use "A\int" as a type name as it is reserved`,
  ],
  [String.raw`function f(\Int $value) {}`, "Type declaration 'int' must be unqualified"],
  [String.raw`namespace A; function f(namespace\int $value) {}`, "Type declaration 'int' must be unqualified"],
  [String.raw`function f(\ArRaY $value) {}`, 'Cannot use "ArRaY" as a type name as it is reserved'],
  [
    String.raw`namespace A; function f(namespace\CALLABLE $value) {}`,
    String.raw`Cannot use "A\CALLABLE" as a type name as it is reserved`,
  ],
])('rejects qualified relative class and builtin type names in %s', (statement, message) => {
  expect(run(`<?php\n${statement}`)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 1, message }] });
});

test.each(['self', 'parent', String.raw`\self`, String.raw`namespace\parent`])(
  'reports the global initializer diagnostic for %s::class',
  (scope) => {
    expect(run(`<?php\nconst NAME = ${scope}::class;`)).toMatchObject({
      kind: 'executed',
      stdout: expect.stringContaining('Cannot use "self" when no class scope is active'),
    });
  }
);

test.each([
  ['var_dump(new enum instanceof stdClass);', 'enum', ':'],
  ['var_dump(new match instanceof stdClass);', 'match', ':'],
  ['var_dump(new enum instanceof A::class);', 'enum', ':'],
  ['var_dump(new match instanceof A::class);', 'match', ':'],
  ['var_dump(5 + new match instanceof A::class);', 'match', 'class'],
  ['var_dump(new and 1);', 'and', ':'],
  ['var_dump(new );', ')', ':'],
  ['return (new and 1);', 'and', 'class'],
  ['var_dump(new clone instanceof stdClass);', 'clone', ':'],
  ['var_dump(new list instanceof stdClass);', 'list', ':'],
  ['var_dump(new unset instanceof stdClass);', 'unset', ':'],
  ['var_dump(new eval instanceof stdClass);', 'eval', ':'],
  ['var_dump(new enum and true);', 'enum', ':'],
  ['var_dump(new match());', 'match', ':'],
  ['var_dump(new readonly instanceof stdClass);', 'instanceof', 'class'],
  ['$object = new enum instanceof stdClass;', 'enum', 'class'],
  ['function make() { return new enum instanceof stdClass; }', 'enum', 'class'],
])('rejects keywords as class names in %s', (statement, token, expected) => {
  expect(run(`<?php\n${statement}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: `syntax error, unexpected token "${token}", expecting "${expected}"` }],
  });
});

test.each([
  ['new );', 1, "Unmatched ')'"],
  ['$x = new ); $y = 1;', 1, "Unmatched ')'"],
  ['$x = new ];', 1, "Unmatched ']'"],
  ['$x = new , ;', 1, 'syntax error, unexpected token ",", expecting "class"'],
  ['var_dump(new ,);', 1, 'syntax error, unexpected token ",", expecting ":"'],
  ['var_dump((new ));', 1, 'syntax error, unexpected token ")", expecting "class"'],
  ['return [1, new ];', 1, 'syntax error, unexpected token "]", expecting "class"'],
  ['var_dump(new\n]);', 2, "Unclosed '(' on line 2 does not match ']'"],
  ['new /* keep the token row */\n);', 2, "Unmatched ')'"],
])('reports the PHP delimiter diagnostic in %s', (statement, row, message) => {
  expect(run(`<?php\n${statement}`)).toMatchObject({ kind: 'compileError', diagnostics: [{ row, message }] });
});

test.each([
  ['$x = new {;', 'token "{"', 'class'],
  ['var_dump(new {);', 'token "{"', ':'],
  ['$x = new & 1;', 'token "&"', 'class'],
  ['$x = new && 1;', 'token "&&"', 'class'],
  ['$x = new ->;', 'token "->"', 'class'],
  ['var_dump(new /* skipped */ ->);', 'token "->"', ':'],
  ['$x = new ::;', 'token "::"', 'class'],
  ['$x = new = 1;', 'token "="', 'class'],
  ['$x = new . 1;', 'token "."', 'class'],
  ['$x = new ++;', 'token "++"', 'class'],
  ['$x = new "a";', 'double-quoted string "a"', 'class'],
  ["$x = new 'abc';", 'single-quoted string "abc"', 'class'],
  ['$x = new 1.5;', 'floating-point number "1.5"', 'class'],
  ['$x = new 0x10;', 'integer "0x10"', 'class'],
  ['$x = new "$variable";', 'double-quote mark', 'class'],
  ['$x = new __Line__;', 'token "__LINE__"', 'class'],
  ['var_dump(new __fIle__);', 'token "__FILE__"', ':'],
  ['var_dump(new __property__);', 'token "__PROPERTY__"', ':'],
  ['new', 'end of file', 'class'],
])('reports the first unexpected token in %s', (statement, token, expected) => {
  expect(run(`<?php\n${statement}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: `syntax error, unexpected ${token}, expecting "${expected}"` }],
  });
});

test('retains contextual enum class references beside operators', () => {
  expect(
    run('<?php class enum{} var_dump(new enum() instanceof enum, new stdClass instanceof enum, new enum && true);')
  ).toMatchObject({
    kind: 'executed',
    stdout: 'bool(true)\nbool(false)\nbool(true)\n',
  });
});

test.each([
  ['a syntax error', '<?php\necho "a"\necho "b";'],
  ['an unclosed block', '<?php\nif (true) {\n  echo 1;'],
  ['a break outside a loop', '<?php\necho "x";\nbreak;'],
  ['a function declared twice', '<?php\nfunction f() {}\nfunction f() {}'],
  ['a value returned from a void function', '<?php\nfunction g(): void { return 1; }'],
  ['a void arrow returning null', '<?php\n$fn = fn(): void => null;'],
  ['a reference to a nullsafe static property', '<?php\n$a = null; $x = &$a?->obj::$property;'],
  ['writing to a nullsafe static property', '<?php\n$a = null; $a?->obj::$property = 1;'],
  ['returning a nullsafe static property by reference', '<?php\nfunction &f($a) { return $a?->obj::$property; }'],
  [
    'self in a named function declared by a method',
    '<?php\nclass T { function f(){ function g(){ return self::C; } } }',
  ],
  ['reading with []', '<?php\n$a = [];\necho $a[];'],
  ['a goto into a loop', '<?php\ngoto x;\nwhile (true) { x: echo 1; }'],
  ['partial application, which PHP 8.5 does not have', '<?php\nfunction f($a, $b) {}\n$g = f(?, 1);'],
])('rejects %s before running, as PHP does', (_name, program) => {
  expect(run(program).kind).toBe('compileError');
});

test.each([
  ['class Empty {}', 'unexpected token "empty", expecting identifier'],
  ['function Isset() {}', 'unexpected token "isset", expecting "("'],
  ['trait Die {}', 'unexpected token "exit", expecting identifier'],
  ['class T extends Exit {}', 'unexpected token "exit"'],
  ['new ISSET;', 'unexpected token "isset", expecting "class"'],
  ['function f(empty &$p) {}', 'unexpected token "empty", expecting variable'],
  ['function f(int|list $p) {}', 'unexpected token "list"'],
  ['class T { public ?empty $p; }', 'unexpected token "empty"'],
  ['function f(): isset {}', 'unexpected token "isset"'],
  ['use isset;', 'unexpected token "isset"'],
  [String.raw`use Vendor\{Empty};`, 'unexpected token "empty", expecting identifier or namespaced name'],
  ['class T { use Empty; }', 'unexpected token "empty"'],
  ['try {} catch (Empty $e) {}', 'unexpected token "empty"'],
  ['try {} catch (Problem|static $e) {}', 'Bad class name in the catch statement'],
  ['class T { var function f() {} }', 'unexpected token "function", expecting variable'],
  ['class T { var const C = 1; }', 'unexpected token "const", expecting variable'],
  ['class T { public private $p; }', 'Multiple access type modifiers are not allowed'],
  ['class T { static static function f() {} }', 'Multiple static modifiers are not allowed'],
  ['class T { abstract abstract const C = 1; }', 'Cannot use the abstract modifier on a class constant'],
  ['class T { static static const C = 1; }', 'Cannot use the static modifier on a class constant'],
  ['class T { final final const C = 1; }', 'Multiple final modifiers are not allowed'],
])('reports the PHP diagnostic for %s', (source, message) => {
  expect(run(`<?php\n${source}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining(message) }],
  });
});

test('accepts qualified names and the readonly function identifier in their PHP contexts', () => {
  const source = `<?php
namespace Empty;
use Vendor\\Empty as Ordinary;
function readonly(?Ordinary $p = null): bool { return $p === null; }
echo readonly() ? 'ok' : 'fail';`;
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: 'ok' });
});

test.each([
  ['<<<TAG', ' bad', 'Invalid body indentation level'],
  ["<<<'TAG'", ' bad', 'Invalid body indentation level'],
  ['<<<TAG', '\tbad', 'Invalid indentation - tabs and spaces cannot be mixed'],
])('reports the offending body row for %s with %s', (marker, line, message) => {
  const source = `<?php\necho ${marker}\n  good\n${line}\n  TAG;`;
  expect(run(source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining(message) }],
  });
});

test.each([
  ['\n <?php echo 1;', '\n 1'],
  ['  text <?php echo 1;', '  text 1'],
  [' \t<?= 1;', ' \t1'],
  [' \t\n', ' \t\n'],
  ['#!/usr/bin/env php\n\n <?php echo 1;', '\n 1'],
])('prints leading inline text from %j', (program, stdout) => {
  expect(run(program)).toMatchObject({ kind: 'executed', stdout });
});

test('counts decoded PHP output against the shared limit', () => {
  expect(run('<?php print str_repeat("あ",40000);')).toMatchObject({
    kind: 'executed',
    stdout: 'あ'.repeat(40_000),
  });
  expect(run('<?php echo str_repeat("あ",60000); echo str_repeat("あ",40001);')).toEqual({
    kind: 'limitExceeded',
    limit: 'output',
  });
});

test.each([
  ['an enum', '<?php\nenum Suit { case Hearts; }', '列挙型（enum）'],
  ['a generator', '<?php\nfunction g() { yield 1; }', 'ジェネレータ（yield）'],
  ['include', "<?php\ninclude 'a.php';", 'include・require'],
  ['a superglobal', '<?php\necho $_GET["x"];', '$_GET'],
])('rejects %s with a message in Japanese', (_name, program, what) => {
  const execution = run(program);
  expect(execution).toMatchObject({ kind: 'compileError' });
  if (execution.kind === 'compileError') {
    expect(execution.diagnostics[0].message).toContain(what);
    expect(execution.diagnostics[0].message).toContain('この採点環境では使えません。');
  }
});

test('stops at a runtime feature the grader rejects, keeping the output before it', () => {
  const execution = run('<?php\necho "start\\n";\n$f = fopen("a.txt", "r");\necho "never";');
  expect(execution).toMatchObject({
    kind: 'executed',
    stdout: 'start\n',
    uncaughtException: 'ファイルの読み書き（fopen）は、この採点環境では使えません。',
  });
});

test.each([
  ['_POST', 'echo $$name;', 'スーパーグローバル変数'],
  ['_FILES', 'isset(${$name});', 'スーパーグローバル変数'],
  ['_SERVER', '$$name = 1;', 'スーパーグローバル変数'],
  ['_GET', 'unset($$name);', 'スーパーグローバル変数'],
  ['argv', 'echo ${$name};', 'コマンドライン引数'],
  ['argc', 'echo $GLOBALS[$name];', 'コマンドライン引数'],
  ['_GET', '$value = 1; $$name =& $value;', 'スーパーグローバル変数'],
  ['argv', '$values = [1]; [&$$name] = $values;', 'コマンドライン引数'],
  ['_POST', '$values = [1]; foreach ($values as &$$name) {}', 'スーパーグローバル変数'],
  ['_GET', 'extract([$name => 1]);', 'スーパーグローバル変数'],
  ['argc', 'global $$name;', 'コマンドライン引数'],
  ['argv', 'compact([[$name]]);', 'コマンドライン引数'],
])('rejects indirect access to $%s through %s', (name, action, label) => {
  expect(run(`<?php $name = '${name}'; echo 'before'; ${action} echo 'after';`)).toMatchObject({
    kind: 'executed',
    stdout: 'before',
    uncaughtException: `${label} $${name}は、この採点環境では使えません。`,
  });
});

test('writes standard error without showing it in standard output', () => {
  expect(run('<?php\nfwrite(STDERR, "err");\nfwrite(STDOUT, "out");')).toMatchObject({ stdout: 'out', stderr: 'err' });
});

test('an endless loop stops at the execution limit', () => {
  expect(run('<?php\nwhile (true) {}')).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('endless recursion ends with the fatal error PHP prints when it runs out of memory', () => {
  const execution = run('<?php\nfunction r($n) { return r($n + 1); }\nr(1);');
  expect(execution.kind === 'executed' && execution.stdout).toMatch(
    /^\nFatal error: Allowed memory size of 134217728 bytes exhausted \(tried to allocate 2097152 bytes\) in \/main\.php on line 2\nStack trace:\n#0 \/main\.php\(2\): r\(\d+\)\n#1 \{main\}\n$/
  );
});

test.each([
  ['a string past the length limit', '<?php\n$s = str_pad("", 300000000, "x");', 'str_pad'],
  [
    'arrays past the element limit',
    '<?php\nfor ($i = 0; $i < 10; $i++) $a[] = array_fill(0, 200000, $i);',
    'array_fill',
  ],
  [
    'a dump of arrays that share their elements',
    '<?php\n$a = [1];\nfor ($i = 0; $i < 40; $i++) $a = [$a, $a];\nprint_r($a);',
    'print_r',
  ],
])('%s ends with the fatal error PHP prints when it runs out of memory', (_name, program, fn) => {
  const execution = run(program);
  expect(execution.kind === 'executed' && execution.stdout).toMatch(
    new RegExp(
      String.raw`^\nFatal error: Allowed memory size of 134217728 bytes exhausted \(tried to allocate \d+ bytes\) in /main\.php on line \d\nStack trace:\n#0 /main\.php\(\d\): ${fn}\(`
    )
  );
});

test('running out of memory cannot be caught', () => {
  const execution = run('<?php\ntry { $s = str_repeat("ab", 900000); } catch (Throwable $e) { echo "caught"; }');
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test.each([
  [
    'dynamic property writes',
    '$fill = array_fill(0, 999_995, 0); $object = new stdClass; ' +
      'for ($i = 0; $i < 20; $i++) $object->{"field$i"} = $i;',
  ],
  ['array-to-object casts', '$fill = array_fill(0, 999_000, 0); $object = (object) array_fill(0, 500, 0);'],
])('%s count toward the slot limit', (_name, contents) => {
  const execution = run(`<?php ${contents} echo 'done';`);
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test('declared slots and replacement writes use their existing allocation', () => {
  const execution = run(
    '<?php class C { public $x; } $fill = array_fill(0, 999_000, 0); ' +
      'for ($i = 0; $i < 400; $i++) { $object = new C; $object->x = 1; unset($object->x); $object->x = 2; } ' +
      'echo $object->x;'
  );
  expect(execution.kind === 'executed' && execution.stdout).toBe('2');
});

test('walking arrays that share their elements stops at the execution limit', () => {
  const execution = run(
    '<?php\n$a = [1];\nfor ($i = 0; $i < 40; $i++) $a = [$a, $a];\necho count($a, COUNT_RECURSIVE);'
  );
  expect(execution).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('charges each seeded shuffle against the execution budget', () => {
  const execution = run(String.raw`<?php
$randomizer = new Random\Randomizer(new Random\Engine\Mt19937(7));
$bytes = str_repeat('a', 900_000);
$randomizer->shuffleBytes($bytes);
$randomizer->shuffleBytes($bytes);
echo 'completed';`);
  expect(execution).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('charges global string shuffles against the execution budget', () => {
  const execution = run(`<?php
mt_srand(7);
$bytes = str_repeat('a', 900_000);
str_shuffle($bytes);
str_shuffle($bytes);
echo 'completed';`);
  expect(execution).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('an uncaught exception prints its fatal error and reports it', () => {
  const execution = run('<?php\nfunction f() { throw new RuntimeException("boom"); }\nf();');
  expect(execution).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Uncaught RuntimeException: boom in /main.php:2\nStack trace:\n#0 /main.php(3): f()\n#1 {main}\n  thrown in /main.php on line 2\n',
  });
  expect(execution.kind === 'executed' && execution.uncaughtException).toMatch(
    /^Fatal error: Uncaught RuntimeException: boom/
  );
});

test.each([
  ['new Exception("walked")', 'array_walk($error, function (&$value) {});', '/main.php', 10],
  ['new ReferencedLocation', '', 'example.php', 42],
])('reports a referenced throwable location for %s', (exception, prepare, file, line) => {
  const execution = run(`<?php
class ReferencedLocation extends Exception {
    function __construct() {
        $file =& $this->file;
        $file = 'example.php';
        $line =& $this->line;
        $line = 42;
    }
}
$error = ${exception};
${prepare}
throw $error;`);
  expect(execution).toMatchObject({
    kind: 'executed',
    stdout: expect.stringContaining(`  thrown in ${file} on line ${line}\n`),
  });
});

test('a no-op reference walk preserves the behavior of native enum cases', () => {
  const execution = run(String.raw`<?php
$before = new Random\Randomizer(new Random\Engine\Mt19937(5));
$after = new Random\Randomizer(new Random\Engine\Mt19937(5));
foreach (Random\IntervalBoundary::cases() as $boundary) {
    $expected = $before->getFloat(1, 2, $boundary);
    array_walk($boundary, function (&$value) {});
    var_dump($expected === $after->getFloat(1, 2, $boundary));
}
foreach (RoundingMode::cases() as $mode) {
    $expected = round(1.25, 1, $mode);
    array_walk($mode, function (&$value) {});
    var_dump($expected === round(1.25, 1, $mode));
}`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'bool(true)\n'.repeat(12) });
});

test('text outside the PHP tags is printed as it is', () => {
  expect(run('Title\n<?php echo 1 + 1 ?>\nmiddle <?= "x" ?>\nend\n')).toMatchObject({
    stdout: 'Title\n2middle xend\n',
  });
});

test('turtle methods take their Japanese and English names', () => {
  const execution = run(
    '<?php\n$t = new Turtle();\n$t->前に進む();\n$t->forward();\n$t->右を向く();\n$t->turnRight();'
  );
  expect(execution.kind === 'executed' && execution.finalTurtles).toEqual([{ x: 0, y: 2, color: '#', dir: 'S' }]);
});

test('string offset padding stops at the string limit before allocating', () => {
  const execution = run('<?php $s = "abc"; try { $s[1000000000] = "x"; } catch (Throwable $e) { echo "caught"; }');
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test.each(['/(a|(b))+/', '/(?:a|(b))+/', '/(?>(a)|b)+/'])(
  'rejects repeated nested captures rather than returning JavaScript capture semantics: %s',
  (pattern) => {
    const execution = run(`<?php preg_match('${pattern}', 'aba', $m);`);
    expect(execution).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
);

test.each(['<?php echo "hello"; declare(strict_types=1);', '<?php function f() {} declare(strict_types=1);'])(
  'rejects a late strict_types declaration before execution: %s',
  (source) => {
    expect(run(source).kind).toBe('compileError');
  }
);

test.each(['1', '1.5'])('bounds number_format precision for %s before padding', (value) => {
  const execution = run(`<?php number_format(${value}, 100000000000000000);`);
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test('object replacement remains within the execution budget beside a large scalar grid', () => {
  vi.restoreAllMocks();
  const execution = run(
    '<?php class P { public $x; function __construct($x) { $this->x=$x; } } $grid=[]; for($i=0;$i<10000;$i++) $grid[]=[$i,$i]; $sum=0; for($i=0;$i<10000;$i++) { $p=new P($i); $sum+=$p->x; } echo $sum;'
  );
  expect(execution).toMatchObject({ kind: 'executed', stdout: '49995000' });
});

test.each([
  '<?php $s=str_repeat("a",10000); similar_text($s,$s);',
  '<?php $it=new LimitIterator(new InfiniteIterator(new ArrayIterator([1])),1000000000); $it->rewind();',
])('native loops stop at the operation limit: %s', (source) => {
  expect(run(source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  '<?php new SplFixedArray(1000001);',
  '<?php $a=new SplFixedArray(); $a->setSize(1000001);',
  '<?php SplFixedArray::fromArray([1000001 => 1]);',
])('native collection allocation failure remains a PHP result: %s', (source) => {
  const execution = run(source);
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test.each(['<?php file_put_contents("a.txt","x",FILE_APPEND|LOCK_EX);', '<?php mb_strlen("abc","sjis");'])(
  'unsupported arguments produce the unsupported-feature message: %s',
  (source) => {
    expect(run(source)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
);

test('unrelated array temporaries do not invalidate scalar-grid garbage caches', () => {
  const execution = run(
    '<?php $data=[]; for($i=0;$i<10000;$i++) $data[]=[$i]; for($i=0;$i<10000;$i++){ $temp=[$i]; $x=new stdClass(); } echo "done";'
  );
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'done' });
});

test('array arguments released after calls do not force repeated copies', () => {
  const execution = run(
    '<?php function total($arr){return count($arr);} $a=[];for($i=0;$i<3000;$i++){ $a[]=$i; $n=total($a); } echo $n;'
  );
  expect(execution).toMatchObject({ kind: 'executed', stdout: '3000' });
});

test.each(['<?php echo "${i[]}";', '<?php echo <<<E\n${a[]}\nE;'])(
  'reports empty interpolation offsets as compile errors: %s',
  (source) => {
    expect(run(source).kind).toBe('compileError');
  }
);

test('queue reindexing and string deduplication do not allocate copies of existing storage', () => {
  expect(
    run('<?php $q=range(1,3000);$n=0;while($q){array_shift($q);$n++;} echo $n," ",count(array_unique(range(1,15000)));')
  ).toMatchObject({ kind: 'executed', stdout: '3000 15000' });
});

test.each(['getBytes(1000000000)', 'getBytesFromString("ab",1000000000)'])(
  'bounds random byte output before generating: %s',
  (method) => {
    const execution = run(`<?php $r=new Random\\Randomizer(new Random\\Engine\\Mt19937(1)); $r->${method};`);
    expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
  }
);

test('decodes a base64 payload within the string budget without host argument spreading', () => {
  expect(run('<?php echo strlen(base64_decode(str_repeat("YWFh",240000)));')).toMatchObject({
    kind: 'executed',
    stdout: '720000',
  });
});

test('set operations use indexed membership for ordinary collections', () => {
  expect(
    run(
      '<?php $a=range(1,5000);$b=range(5001,10000);echo count(array_intersect($a,$b))," ",count(array_diff_key($a,$b));'
    )
  ).toMatchObject({ kind: 'executed', stdout: '0 0' });
});

test('query-string separator expansion is bounded before joining', () => {
  const execution = run('<?php http_build_query(range(1,1000),"",str_repeat("x",10000));');
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test.each(['<?php bcadd("1","2");', '<?php pack("C",1);', '<?php new NumberFormatter("en",0);'])(
  'unavailable PHP builtins are rejected explicitly: %s',
  (source) => {
    expect(run(source)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
);

test.each([
  '<?php final abstract class A{}',
  '<?php abstract final class A{}',
  '<?php class A{abstract const X=1;}',
  '<?php abstract class A{abstract protected $p;}',
  '<?php abstract class A{abstract protected $p{get{return 1;}}}',
  '<?php $a?->b=1;',
  '<?php const X=$a;',
  '<?php const X=foo();',
  '<?php class A{const X=new B;}',
  '<?php function f(){static $a;static $a;}',
  '<?php $f=function()use($a,$a){};',
  '<?php function f(int|int $a){}',
  '<?php function f(iterable|array $a){}',
  '<?php function f(?mixed $a){}',
  '<?php function f(int&string $a){}',
  '<?php function f(void $a){}',
  '<?php function f(?void $a){}',
  '<?php function f(int|void $a){}',
  '<?php interface I{private function f();}',
  '<?php class A{const int X="a";}',
  '<?php echo "{$a+1}";',
  '<?php echo "{$a.$b}";',
  '<?php echo "{$a[0]??1}";',
])('rejects invalid declarations and expressions before execution: %s', (source) => {
  expect(run(source).kind).toBe('compileError');
});

test('ownership tracking keeps append loops and linked lists within the operation budget', () => {
  expect(run('<?php $a=[];for($i=0;$i<50000;$i++)$a[]=$i;echo count($a);')).toMatchObject({
    kind: 'executed',
    stdout: '50000',
  });
  expect(
    run(
      '<?php class N{public $next=null;function __construct(public $v){}} $head=new N(0);$c=$head;for($i=1;$i<3000;$i++){$c->next=new N($i);$c=$c->next;}$n=0;for($p=$head;$p!==null;$p=$p->next)$n++;echo $n;'
    )
  ).toMatchObject({ kind: 'executed', stdout: '3000' });
});

test.each([
  '<?php class A {public int $v {set($v){}}}',
  '<?php class A {public string $v {set(int $v){}}}',
  '<?php class A {public int $v=1 {get => 2;}}',
  '<?php echo 1 |> fn($x) => $x;',
  '<?php while(false){goto x; x: echo "ok";} goto x;',
])('rejects invalid hook, pipe and same-line goto syntax: %s', (source) => {
  expect(run(source).kind).toBe('compileError');
});

test('deeply nested arrays compare without a host stack limit', () => {
  const source =
    '<?php $a=1;$b=1;for($i=0;$i<1000;$i++){$a=[$a];$b=[$b];}try{var_dump($a===$b);}catch(Error $e){echo "caught";}';
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: 'bool(true)\n' });
});

test('releasing a large object-containing array does not exhaust the host argument stack', () => {
  expect(run('<?php $a=array_fill(0,200000,1);$a[]=new stdClass;unset($a);echo "done";')).toMatchObject({
    kind: 'executed',
    stdout: 'done',
  });
});

test('format padding checks its allocation before constructing the field', () => {
  const result = run('<?php sprintf("%1000000000s", "x");');
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test('array_unique scales with distinct values in numeric sort mode', () => {
  expect(run('<?php echo count(array_unique(range(1,5000),SORT_NUMERIC));')).toMatchObject({
    kind: 'executed',
    stdout: '5000',
  });
});

test.each([
  '<?php $a=new stdClass;$b=new stdClass;for($i=0;$i<25;$i++){$a=(object)["l"=>$a,"r"=>$a];$b=(object)["l"=>$b,"r"=>$b];}var_dump($a==$b);',
  '<?php echo strtr(str_repeat("a",2000),array_fill_keys(range(0,999),"x"));',
  '<?php $a=["x"];for($i=0;$i<25;$i++)$a=[$a,$a];var_dump(mb_check_encoding($a));',
  '<?php $s=str_repeat("b",500000); $d=str_repeat("a",500000); echo strlen(strtok($s,$d));',
  '<?php $s=str_repeat("z",500000); $f="%[^" . str_repeat("a-b",100000) . "]"; echo strlen(sscanf($s,$f)[0]);',
])('charges recursive or multiplicative native work against the budget: %s', (source) => {
  expect(run(source)).toEqual({ kind: 'limitExceeded', limit: 'operations' });
});

test('rejects detached plain-object SPL backing instead of producing stale views', () => {
  const result = run('<?php $o=(object)["x"=>1];$a=new ArrayObject($o);');
  expect(result).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません。'),
  });
});

test('charges cloned linked-list nodes before allocating their storage', () => {
  const result = run(
    '<?php $s=new SplDoublyLinkedList;for($i=0;$i<10000;$i++)$s->push(1);$copies=[];for($i=0;$i<100;$i++)$copies[]=clone $s;echo "never";'
  );
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test.each([
  '<?php class A{public $x=foo();}',
  '<?php class A{public $x=$b;}',
  '<?php class A{public $x=new B;}',
  '<?php function f($x=foo()){}',
  '<?php function f($x=$b){}',
  '<?php class A{public void $x;}',
  '<?php class A{public callable $x;}',
  '<?php class A{public never $x;}',
  '<?php function f(bool|false $x){}',
  '<?php function f(object|stdClass $x){}',
  '<?php function f(?int|string $x){}',
  '<?php interface I{final function f();}',
  '<?php interface I{abstract function f();}',
  '<?php class A{public public $x;}',
  '<?php class A{public private $x;}',
  '<?php class A{static static $x;}',
  '<?php class A{final final function f(){}}',
  '<?php class A{private final const X=1;}',
  '<?php abstract class A{abstract final function f();}',
  '<?php $f=function()use($GLOBALS){};',
  '<?php unset($a?->b);',
  '<?php $x=&$a?->b;',
  '<?php $a=[];echo "$a[ 4]";',
  '<?php class A{public $v{set($v=5){}get=>1;}}',
])('rejects invalid declarations and writes before execution: %s', (source) => {
  expect(run(source).kind).toBe('compileError');
});

test.each([
  ['$GLOBALS = [];', '$GLOBALS can only be modified using the $GLOBALS[$name] = $value syntax'],
  ['unset($GLOBALS);', '$GLOBALS can only be modified using the $GLOBALS[$name] = $value syntax'],
  ['[$GLOBALS] = [1];', '$GLOBALS can only be modified using the $GLOBALS[$name] = $value syntax'],
  ['$value =& $GLOBALS;', 'Cannot acquire reference to $GLOBALS'],
  ["$GLOBALS[]['name'] = 1;", 'Cannot append to $GLOBALS'],
  ['function f($GLOBALS) {}', 'Cannot re-assign auto-global variable GLOBALS'],
])('rejects forbidden use of the whole global table before execution: %s', (source, message) => {
  expect(run(`<?php echo 'before'; ${source}`)).toMatchObject({ kind: 'compileError', diagnostics: [{ message }] });
});

test.each([
  ["$GLOBALS['this'] = 1;", 'Cannot re-assign $this'],
  ["$GLOBALS['this'] ??= 1;", 'Cannot re-assign $this'],
  ["$GLOBALS['this']++;", 'Cannot re-assign $this'],
  ["$ref =& $GLOBALS['this'];", 'Cannot re-assign $this'],
  ["unset($GLOBALS['this']['child']);", 'Cannot unset $this'],
  ["unset($GLOBALS['this']);", 'done'],
])('protects the current object in global table operations: %s', (operation, stdout) => {
  expect(
    run(`<?php try { ${operation} echo 'done'; } catch (Error $error) { echo $error->getMessage(); }`)
  ).toMatchObject({
    kind: 'executed',
    stdout,
  });
});

test.each([
  ['new final class {};', 'final'],
  ['new abstract class {};', 'abstract'],
  ['new final readonly class {};', 'final'],
  ['new abstract final class {};', 'abstract'],
])('rejects forbidden anonymous class modifiers before execution: %s', (source, modifier) => {
  expect(run(`<?php echo 'before';\n${source}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: `Cannot use the ${modifier} modifier on an anonymous class` }],
  });
});

test.each([
  ['final final class K {}', 'Multiple final modifiers are not allowed'],
  ['abstract abstract class K {}', 'Multiple abstract modifiers are not allowed'],
  ['readonly final readonly class K {}', 'Multiple readonly modifiers are not allowed'],
  ['$value = new readonly readonly class {};', 'Multiple readonly modifiers are not allowed'],
  ['$value = new final abstract class {};', 'Cannot use the final modifier on an anonymous class'],
  ['class K { const VALUE = "text"; public int $n = self::VALUE; }', 'Cannot use string as default value'],
  ['class K { const VALUE = "text"; public static int $n = K::VALUE . "x"; }', 'Cannot use string as default value'],
  ['class E { const TEXT = "a"; } class K { public int $n = E::TEXT; }', 'Cannot use string as default value'],
  ['class D { public int $n = __CLASS__; }', 'Cannot use string as default value'],
  ['class D { public static int $n = __METHOD__; }', 'Cannot use string as default value'],
  ['trait T { public int $n = __TRAIT__; }', 'Cannot use string as default value'],
  ['class D { const int NAME = __CLASS__; }', 'Cannot use string as value for class constant'],
  ['class D { const int|callable X = UNKNOWN; }', 'Class constant D::X cannot have type callable|int'],
  ['interface D { const ?callable X = UNKNOWN; }', 'Class constant D::X cannot have type ?callable'],
  ['trait D { const never X = UNKNOWN; }', 'Class constant D::X cannot have type never'],
  ['class D { const void X = 1; }', 'Class constant D::X cannot have type void'],
  ['class D { const ?parent X = null; }', 'Cannot use "parent" when current class scope has no parent'],
  [
    'interface P {} interface D extends P { const parent X = UNKNOWN; }',
    'Cannot use "parent" when current class scope has no parent',
  ],
  ['function f(int $n = __FUNCTION__) {}', 'Cannot use string as default value'],
  ['class D { function f(int $n = __METHOD__) {} }', 'Cannot use string as default value'],
  ['if (false) { $object = new class { public int $n = __CLASS__; }; }', 'Cannot use string as default value'],
  ['$object = new class { const int NAME = __CLASS__; };', 'Cannot use string as value for class constant'],
  ['$object = new class { function f(int $n = __METHOD__) {} };', 'Cannot use string as default value'],
  ['$closure = function (int $n = __FUNCTION__) {};', 'Cannot use string as default value'],
  [String.raw`function f(int $n = \TRUE) {}`, 'Cannot use bool as default value'],
  ['$array = [[] => 1];', 'Illegal offset type'],
  ['const VALUE = [[] => 1];', 'Illegal offset type'],
  ['class K { const VALUE = [[] => 1]; }', 'Illegal offset type'],
  ['function f($value = [[] => 1]) {}', 'Illegal offset type'],
  ['$value = new (1.5);', 'Illegal class name'],
  ['$value = new (null);', 'Illegal class name'],
  ['$value = new ([]);', 'Illegal class name'],
  ['$value = (1)::X;', 'Illegal class name'],
  ['$value = (1)::m();', 'Illegal class name'],
  ['$value = new stdClass instanceof (1);', 'Illegal class name'],
])('rejects invalid compiled operands and class defaults before execution: %s', (source, message) => {
  expect(run(`<?php echo 'before'; ${source}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining(message) }],
  });
});

test('rejects directly declared abstract methods on anonymous classes before execution', () => {
  expect(run("<?php echo 'before';\nnew class {\nabstract function rejected();\n};")).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: 'Anonymous class method rejected() must not be abstract' }],
  });
});

test('reports Unicode caseless restriction as an unsupported regex feature', () => {
  expect(run("<?php preg_match('/k/iur', 'K');")).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません'),
  });
});

test.each([String.raw`/(a)?\1/`, String.raw`/(?<x>a)?\k<x>/`])(
  'does not match an empty subject through a reference to an unmatched group: %s',
  (pattern) => {
    expect(run(`<?php var_dump(preg_match('${pattern}', '', $m));`)).toMatchObject({
      kind: 'executed',
      stdout: 'int(0)\n',
      uncaughtException: undefined,
    });
  }
);

test('retains participating empty captures', () => {
  expect(run(String.raw`<?php var_dump(preg_match('/(a|)\1/','',$m),$m);`)).toMatchObject({
    kind: 'executed',
    stdout: 'int(1)\narray(2) {\n  [0]=>\n  string(0) ""\n  [1]=>\n  string(0) ""\n}\n',
  });
});

test('preserves PHP stdout bytes alongside decoded text for malformed UTF-8', () => {
  const result = run('<?php echo "prefix ", chr(206), chr(177), "|", chr(128), strrev("aα"), "|", chr(200);');
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: 'prefix α|���a|�',
    stdoutBytes: Uint8Array.of(112, 114, 101, 102, 105, 120, 32, 206, 177, 124, 128, 177, 206, 97, 124, 200),
  });
});

test('object allocation and destructor bookkeeping stay within learner budgets', () => {
  vi.restoreAllMocks();
  expect(run('<?php class P{public $x=1;}$s=0;for($i=0;$i<30000;$i++){$q=new P;$s+=$q->x;}echo $s;')).toMatchObject({
    kind: 'executed',
    stdout: '30000',
  });
  expect(run('<?php class N{function __destruct(){}}for($i=0;$i<4000;$i++)$k[]=new N;echo "done";')).toMatchObject({
    kind: 'executed',
    stdout: 'done',
  });
});

test.each(['==', '===', '<=>'])('compares deeply nested arrays iteratively: %s', (operator) => {
  expect(run(`<?php $a=1;$b=1;for($i=0;$i<5000;$i++){$a=[$a];$b=[$b];}var_dump($a ${operator} $b);`)).toMatchObject({
    kind: 'executed',
    stdout: operator === '<=>' ? 'int(0)\n' : 'bool(true)\n',
  });
});

test('compares long linked object structures without a fixed recursion cutoff', () => {
  expect(
    run(
      '<?php class N {public $next;function __construct(public $v){}} function build(){ $h=null;for($i=0;$i<1000;$i++){ $n=new N($i);$n->next=$h;$h=$n;}return $h;} $a=build();$b=build();var_dump($a==$b);'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'bool(true)\n' });
});

test.each([
  ['(a)+', 20_000],
  ['(b){2}', 20_000],
  ['(a)', 300],
])('regex translation bounds repeated items: %s x %i', (item, count) => {
  vi.restoreAllMocks();
  expect(run(`<?php @preg_match('/'.str_repeat('${item}',${count}).'/', '');echo 'done';`)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません。'),
  });
});

test.each(['true', '2.0', 'null'])('exit validates strict scalar arguments before terminating: %s', (value) => {
  const result = run(
    `<?php declare(strict_types=1);try {exit(${value});}catch(Throwable $e){echo $e->getMessage();}echo ':continued';`
  );
  expect(result.kind === 'executed' && result.stdout).toMatch(/^exit\(\): Argument #1 .*:continued$/);
});

test('weak exit accepts an integral float without precision-loss diagnostics', () => {
  expect(run('<?php echo "before";exit(2.0);echo "after";')).toMatchObject({ kind: 'executed', stdout: 'before' });
});

test.each([
  ['callback', "preg_replace_callback('/a/', fn() => exit('callback;'), ['aaa', 'a'], -1, $count);", 'callback;2'],
  [
    'callback result conversion',
    "preg_replace_callback('/a/', fn() => new Replacement, 'aaa', -1, $count);",
    'conversion;result=99;1',
  ],
  ['pattern conversion', "preg_replace(['/b/', new Replacement], 'x', 'baa', -1, $count);", 'conversion;result=1;1'],
  [
    'callback array',
    "preg_replace_callback_array(['/a/' => fn() => exit('callback;')], ['aaa', 'a'], -1, $count);",
    'callback;99',
  ],
])('preserves PHP replacement counts at shutdown after exit during %s', (_name, program, stdout) => {
  expect(
    run(`<?php
$count = 99;
class CountReader { function __destruct() { global $count; echo $count; } }
class Replacement {
    function __toString() { exit('conversion;'); }
    function __destruct() { global $count; echo "result=$count;"; }
}
$reader = new CountReader;
${program}
echo 'unreachable';
`)
  ).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  ["exit('exit;');", 'drop;exit;count:2'],
  ["throw new Exception('cleanup');", 'drop;caught:cleanup;count:2'],
])('counts the match after a converted regex result fails during cleanup with %s', (failure, stdout) => {
  expect(
    run(`<?php
$count = 99;
class Reader { function __destruct() { global $count; echo 'count:', $count; } }
class Replacement {
    function __toString() { return 'X'; }
    function __destruct() { echo 'drop;'; ${failure} }
}
$reader = new Reader;
try { preg_replace_callback('/a/', fn() => new Replacement, 'aa', -1, $count); }
catch (Throwable $error) { echo 'caught:', $error->getMessage(), ';'; }
`)
  ).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  String.raw`<?php preg_match('/\xe9/i',"\xc9");`,
  String.raw`<?php preg_match('/[\xe0-\xef]/i',"\xc9");`,
  '<?php preg_match("/(a*)+/","aaa");',
  '<?php preg_match("/(a?){0,3}/","a");',
  '<?php preg_match("/()*/","");',
  '<?php preg_replace("/(?:b?|a)*/","X","aa");',
  '<?php preg_match("/(?:|a){0,3}/","aa");',
  '<?php preg_match("/(?:a*?)*/","aa");',
  '<?php preg_match("/(?:x*|a)+/","aa");',
  '<?php preg_match("/^(?:a+)+$/",str_repeat("a", 30)."b");',
  '<?php preg_match("/^(?:a|aa)+$/",str_repeat("a", 30)."b");',
])('rejects regex semantics the host cannot preserve: %s', (source) => {
  expect(run(source)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません。'),
  });
});

test.each([
  'a*a*a*a*',
  'a+a?a+a+',
  '[a-c]+b[a-d]+',
  '(?:a*)(a*)(?:a*)',
  '(?i:a*)A*a*',
  '(?i:z)(a+|b)(a+|b)(a+|b)',
  '(?i:z)(a*|b)(a*|b)(a*|b)',
])('bounds overlapping repeated atoms: %s', (pattern) => {
  expect(run(`<?php preg_match('/^${pattern}x$/', str_repeat('a', 22).'!');`)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません。'),
  });
});

test('allows case-sensitive disjoint repetitions and small bounded repetitions on long subjects', () => {
  expect(
    run(String.raw`<?php
var_dump(preg_match('/^[a-z]*[A-Z]*$/', 'abcdefghijklmnopQ'));
var_dump(preg_match('/^(?-i:a*A*)$/i', 'aaaaaaaaaaaaaaaaA'));
var_dump(preg_match('/^(?i:z)[a-z]*[A-Z]*$/', 'ZabcdefghijklmnopQ'));
var_dump(preg_match('/^(?:yes|YES)+$/', str_repeat('yesYES', 8)));
var_dump(preg_match('/^(?-i:a|A)+$/i', str_repeat('aA', 20)));
var_dump(preg_match('/^(?:é|É)+$/u', str_repeat('éÉ', 10)));
var_dump(preg_match('/^\d{1,2}\d{1,2}$/', '12345678901234567'));
var_dump(preg_match('/^a{1,3}a{1,3}$/', str_repeat('a', 17)));
`)
  ).toMatchObject({ kind: 'executed', stdout: 'int(1)\nint(1)\nint(1)\nint(1)\nint(1)\nint(1)\nint(0)\nint(0)\n' });
});

test('retains short ambiguous repetitions and long unambiguous repetitions', () => {
  expect(
    run('<?php var_dump(preg_match("/^(?:a|aa)+$/","aaaa"),preg_match("/^(?:ab|ac)+$/",str_repeat("ab", 30)));')
  ).toMatchObject({ kind: 'executed', stdout: 'int(1)\nint(1)\n' });
});

test('allows disjoint regex classes with negation, shorthand and scoped case flags', () => {
  expect(
    run(String.raw`<?php
var_dump(preg_match('/^[^a]*a*$/', 'bbbbbbbbbbbbbbbbba'));
var_dump(preg_match('/^\D*\d*$/', 'abcdefghijklmnopq1'));
var_dump(preg_match('/^(?i:[^a]*)A*$/', 'bbbbbbbbbbbbbbbbbA'));
var_dump(preg_match('/^[^\x{e9}]*\x{e9}*$/u', "aaaaaaaaaaaaaaaa\u{e9}"));
`)
  ).toMatchObject({ kind: 'executed', stdout: 'int(1)\nint(1)\nint(1)\nint(1)\n' });
});

test('retains bounded lookbehind and Unicode or ASCII case folding', () => {
  expect(
    run('<?php var_dump(preg_match("/(?<=a{1,255})b/","ab"),preg_match("/é/iu","É"),preg_match("/a/i","日A"));')
  ).toMatchObject({ kind: 'executed', stdout: 'int(1)\nint(1)\nint(1)\n' });
});

test('retains fixed empty captures and nonempty repeated captures', () => {
  expect(run('<?php var_dump(preg_match("/()+/","",$m),$m,preg_match("/(a)+/","aa",$m),$m);')).toMatchObject({
    kind: 'executed',
    stdout:
      'int(1)\narray(2) {\n  [0]=>\n  string(0) ""\n  [1]=>\n  string(0) ""\n}\nint(1)\narray(2) {\n  [0]=>\n  string(2) "aa"\n  [1]=>\n  string(1) "a"\n}\n',
  });
});

test.each([false, true])(
  'dropping a long linked object chain uses bounded release work with destructor=%s',
  (destructor) => {
    vi.restoreAllMocks();
    expect(
      run(
        `<?php class N{public $next;${destructor ? 'function __destruct(){}' : ''}}$x=null;for($i=0;$i<10000;$i++){$n=new N;$n->next=$x;$x=$n;}unset($n);$x=null;echo 'done';`
      )
    ).toMatchObject({
      kind: 'executed',
      stdout: 'done',
    });
  }
);

test.each(['mb_strpos', 'mb_strrpos', 'mb_stripos', 'mb_strripos'])(
  'multibyte substring search bounds repeated-prefix work: %s',
  (name) => {
    vi.restoreAllMocks();
    expect(run(`<?php var_dump(${name}(str_repeat('a',200000),str_repeat('a',100000).'b'));`)).toMatchObject({
      kind: 'executed',
      stdout: 'bool(false)\n',
    });
  }
);

test('title casing computes final sigma context without rescanning prefixes', () => {
  vi.restoreAllMocks();
  expect(run('<?php echo strlen(mb_convert_case(str_repeat("Σ",50000),MB_CASE_TITLE));')).toMatchObject({
    kind: 'executed',
    stdout: '100000',
  });
});

test.each([
  [
    'class A{final function f(){}}class B extends A{}class C extends B{function f(){}}',
    'Cannot override final method A::f()',
  ],
  [
    'class A{function f():int{return 1;}}class B extends A{}class C extends B{function f():string{return "x";}}',
    'Declaration of C::f(): string must be compatible with A::f(): int',
  ],
])('checks inherited methods through intermediate classes: %s', (source, message) => {
  const result = run(`<?php ${source} echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toContain(message);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  ['public static $a {set($v=1){}}', 'Cannot declare hooks for static property'],
  ['public $a {get($i){return $i;}set($v=1){}}', 'get hook of property A::$a must not have a parameter list'],
  ['public $a {set($v,$w=1){}}', 'set hook of property A::$a must accept exactly one parameters'],
  ['public $a {set(&$v=1){}}', 'Parameter $v of set hook A::$a must not be pass-by-reference'],
  ['public $a {set(...$v){}}', 'Parameter $v of set hook A::$a must not be variadic'],
  ['public $a {get(){}}', 'get hook of property A::$a must not have a parameter list'],
  ['public $a {set(){}}', 'set hook of property A::$a must accept exactly one parameters'],
])('validates hook declarations before defaults and bodies: %s', (property, message) => {
  expect(run(`<?php class A{${property}} echo 'never';`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message }],
  });
});

test.each([
  'K::m()',
  'G instanceof P',
  'print 1',
  'clone G',
  'match(G){default=>1}',
  'throw new Exception',
  'new class{}',
  'new static',
  'new P(...[1])',
  'static::X',
  'static::class',
  'static fn()=>1',
  'function(){}',
  'static function()use($x){}',
])('rejects executable operations in constant declarations and defaults: %s', (expression) => {
  const declarations = [`const X=${expression};`, `function f($x=${expression}){}`];
  for (const declaration of declarations) {
    expect(run(`<?php class P{}class K{static function m(){}}const G=5;${declaration} echo 'never';`).kind).toBe(
      'compileError'
    );
  }
});

test.each(['$k', '$k[0]'])(
  'retiring argument references keeps repeated object-returning calls bounded: %s',
  (argument) => {
    vi.restoreAllMocks();
    expect(
      run(
        `<?php class N{function __destruct(){echo 'end';}}function f($o){return $o;}$k=${argument === '$k' ? 'new N' : '[new N]'};for($i=0;$i<8000;$i++)$r=f(${argument});echo 'done';`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'doneend' });
  }
);

test('keeps ordinary patterns within the supported capture envelope', () => {
  expect(run("<?php var_dump(preg_match('/'.str_repeat('(a)',255).'/',str_repeat('a',255)));")).toMatchObject({
    kind: 'executed',
    stdout: 'int(1)\n',
  });
});

test.each([
  ['$x=1;', '0'],
  ['global $d;$d++;', '10000'],
  ['static $k=0;$k++;', '0'],
  ['$x=$this->next;', '0'],
  ['$this->scratch=[$this];', '0'],
])('destructor writes retain bounded release work: %s', (body, count) => {
  vi.restoreAllMocks();
  expect(
    run(
      `<?php $d=0;class N{public $next;public $scratch;function __destruct(){${body}}}$head=null;for($i=0;$i<10000;$i++){$n=new N;$n->next=$head;$head=$n;}unset($n);$head=null;echo 'done:',$d;`
    )
  ).toMatchObject({ kind: 'executed', stdout: `done:${count}` });
});

test.each([
  ['class ParentReference {function &g($x){return $x;}}', 'class'],
  ['interface ParentReference {function &g($x);}', 'interface'],
  ['abstract class ParentReference {abstract function &g($x);}', 'abstract'],
])('retains parent return-reference contracts through %s', (parent, kind) => {
  const relation = kind === 'interface' ? 'implements' : 'extends';
  const result = run(
    `<?php ${parent}class ChildValue ${relation} ParentReference{function g($x){return $x;}}echo 'never';`
  );
  expect(result.kind === 'executed' && result.stdout).toContain(
    'Declaration of ChildValue::g($x) must be compatible with & ParentReference::g($x)'
  );
});

test.each(['int', '?int'])(
  'static update reads reject uninitialized %s storage without exposing host values',
  (type) => {
    const result = run(
      `<?php class A{public static ${type} $x;}try{A::$x++;}catch(Throwable $e){echo $e->getMessage();}echo ':done';`
    );
    expect(result).toMatchObject({
      kind: 'executed',
      stdout: 'Typed static property A::$x must not be accessed before initialization:done',
    });
  }
);

test('strict native null coercion throws without emitting a deprecation', () => {
  const result = run(
    '<?php declare(strict_types=1);try{strlen(null);}catch(Throwable $e){echo $e->getMessage();}echo ":done";'
  );
  expect(result.kind === 'executed' && result.stdout).toBe(
    'strlen(): Argument #1 ($string) must be of type string, null given:done'
  );
});

test.each([
  "preg_replace('/^/',$p,[$s],1)[0]",
  "preg_filter('/^/',$p,[$s],1)[0]",
  "preg_replace_callback('/^/',fn()=>$p,[$s],1)[0]",
  'substr_replace([$s],$p,0,0)[0]',
])('bounds complete array replacement strings: %s', (expression) => {
  const result = run(`<?php $s='a';$p=str_repeat('x',900000);for($i=0;$i<5;$i++)$s=${expression};echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test.each(['/(?<=(a{1,3})(a{1,3}))b/', '/(?<=a{1,3}(a{1,3}))b/'])(
  'rejects variable lookbehind capture order the host cannot preserve: %s',
  (pattern) => {
    expect(run(`<?php preg_match('${pattern}','aaaab',$m);`)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
);

test.each([
  String.raw`preg_match('/(?<=(a)\1)b/', 'aab')`,
  String.raw`preg_match('/(?<!(a)\1)b/', 'aab')`,
  String.raw`preg_replace('/(?<=(.)\1)x/', 'Y', 'aax bcx')`,
  String.raw`preg_match_all('/(?<=(\d)\1)-/', '11-23-', $matches)`,
])('rejects references to captures within the same lookbehind: %s', (call) => {
  expect(run(`<?php ${call}; echo 'done';`)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('後読みの内部キャプチャへの後方参照'),
  });
});

test('retains fixed lookbehind captures', () => {
  expect(run("<?php preg_match('/(?<=(aa))b/','aab',$m);echo $m[1];")).toMatchObject({
    kind: 'executed',
    stdout: 'aa',
  });
});

test('collects a long object cycle without host recursion', () => {
  expect(
    run(
      '<?php class N{public $next;}$head=new N;$p=$head;for($i=0;$i<30000;$i++){$p->next=new N;$p=$p->next;}$p->next=$head;unset($p,$head);echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: '30001' });
});

test('counts shared cyclic arrays once when collecting their owners', () => {
  const source = `<?php
    class Node { public $items; }
    $nodes = [];
    for ($i = 0; $i < 1500; $i++) $nodes[] = new Node;
    $shared = [$nodes];
    foreach ($nodes as $node) $node->items = $shared;
    unset($node, $nodes, $shared);
    echo gc_collect_cycles(), ':', gc_collect_cycles();
  `;
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '1502:0' });
});

test.each(['$this->next=null;', 'unset($this->next);'])(
  'nested destructor cleanup obeys the call-depth limit without rescanning: %s',
  (body) => {
    vi.restoreAllMocks();
    const result = run(
      `<?php class N{public $next;function __destruct(){${body}}}$head=null;for($i=0;$i<5000;$i++){$n=new N;$n->next=$head;$head=$n;}unset($n);$head=null;echo 'never';`
    );
    expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
  }
);

test('memory exhaustion stops destructor callbacks', () => {
  const result = run('<?php class N{function __destruct(){echo "never";}}$n=new N;str_repeat("x",1000001);');
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each(['return 1;', 'throw new Exception("replacement");'])(
  'memory exhaustion bypasses finally replacement: %s',
  (body) => {
    const result = run(
      `<?php function f(){try{str_repeat('x',1000000000);}finally{${body}}}try{echo f(),'never';}catch(Throwable $e){echo 'caught';}`
    );
    expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
    expect(result.kind === 'executed' && result.stdout).not.toMatch(/never|caught|replacement/);
  }
);

test.each(['array_merge_recursive', 'array_replace_recursive'])(
  'combines deep acyclic arrays without host recursion: %s',
  (name) => {
    const result = run(
      `<?php $a=['k'=>1];for($i=0;$i<2000;$i++)$a=['k'=>$a];$b=${name}($a,$a);for($i=0;$i<2000;$i++)$b=$b['k'];echo is_array($b['k'])?$b['k'][0]:$b['k'];`
    );
    expect(result).toMatchObject({ kind: 'executed', stdout: '1' });
  }
);

test('counts deep nested arrays without host recursion', () => {
  expect(run('<?php $a=[];for($i=0;$i<30000;$i++)$a=[$a];echo count($a,COUNT_RECURSIVE);')).toMatchObject({
    kind: 'executed',
    stdout: '30000',
  });
});

test.each([
  'function f(int $x=[]){}',
  'function f(false $x=true){}',
  'function f(true $x=false){}',
  'class A{public int $x="bad";}',
  'class A{public int $x=[];}',
  'class A{public int $x=null;}',
  'class A{public false $x=true;}',
  'function f(int $x=-1.5){}',
  'function f(false $x=!false){}',
  'class A{public int $x=-1.5;}',
  'class A{public false $x=!false;}',
  'function f(string $x=+true){}',
  'function f(string $x=-null){}',
  'function f(string $x=+"12.5"){}',
  'function f(string $x=![]){}',
])('rejects incompatible declaration defaults before output: %s', (declaration) => {
  expect(run(`<?php echo 'before'; ${declaration}`).kind).toBe('compileError');
});

test('identifies the property when rejecting its incompatible default', () => {
  expect(run('<?php echo "never"; class Account { public int $balance=[]; }')).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('property Account::$balance of type int') }],
  });
});

test.each([
  '<?php echo "before"; $s=<<<TXT\n \thello\n  TXT;',
  '<?php echo "before"; $s=<<<\'TXT\'\n\thello\n  TXT;',
  '<?php echo "before"; $s=<<<TXT\n  hello\n\tTXT;',
  '<?php echo "before"; $s=<<<TXT\n  hello\n \tTXT;',
  '<?php echo "before"; $s=<<<TXT\n  hello\n \t\n  TXT;',
  '<?php echo "before"; $s=<<<"TXT"\n  hello\n\t\n  TXT;',
  '<?php echo "before"; $s=<<<\'TXT\'\n  hello\n \t\n  TXT;',
])('rejects mixed heredoc indentation before output: %s', (source) => {
  expect(run(source).kind).toBe('compileError');
});

test.each(['\n', '\r\n'])('keeps literal multiline whitespace with line ending %j', (lineEnding) => {
  const source = [
    '<?php',
    '$value = 7;',
    '$spaces = <<<TEXT',
    '    ',
    '  TEXT;',
    "$blank = <<<'TEXT'",
    '',
    '',
    'TEXT;',
    '$interpolated = <<<TEXT',
    '  ',
    '  $value',
    '  TEXT;',
    'var_dump($spaces, $blank, $interpolated);',
  ].join(lineEnding);
  expect(run(source)).toMatchObject({
    kind: 'executed',
    stdout: `string(2) "  "\nstring(${lineEnding.length}) "${lineEnding}"\nstring(${lineEnding.length + 1}) "${lineEnding}7"\n`,
  });
});

test.each(['SplMaxHeap', 'SplMinHeap', 'SplPriorityQueue'])(
  'charges cloned heap storage to the allocation budget: %s',
  (name) => {
    const insert = name === 'SplPriorityQueue' ? '$h->insert($i,$i);' : '$h->insert($i);';
    const result = run(
      `<?php $h=new ${name};for($i=0;$i<1000;$i++){${insert}}$held=array_fill(0,970000,0);$copies=[];for($i=0;$i<40;$i++)$copies[]=clone $h;echo 'never';`
    );
    expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
    expect(result.kind === 'executed' && result.stdout).not.toContain('never');
  }
);

test('finishes a heap removal interrupted by the comparator', () => {
  expect(
    run(`<?php
class Heap extends SplMaxHeap {
  public bool $stop = false;
  public function compare($a, $b): int { if ($this->stop) exit('exit;'); return $a <=> $b; }
}
class Reader {
  public function __destruct() { global $heap; var_dump(count($heap), $heap->isCorrupted()); }
}
$heap = new Heap;
foreach ([1, 2, 3, 4, 5, 6] as $value) $heap->insert($value);
$reader = new Reader;
$heap->stop = true;
$heap->extract();
`)
  ).toMatchObject({ kind: 'executed', stdout: 'exit;int(5)\nbool(true)\n' });
});

test.each([false, true])('publishes partial user sort results on exit with ArrayObject=%s', (wrapped) => {
  const sort = wrapped
    ? '$values = new ArrayObject($values); $values->uasort($compare);'
    : 'uasort($values, $compare);';
  expect(
    run(`<?php
class Reader {
  public function __destruct() { global $values; echo json_encode(is_array($values) ? $values : $values->getArrayCopy()); }
}
$values = [9, 5, 2, 8, 7, 1, 6, 4, 3, 0];
$reader = new Reader;
$compare = function ($a, $b) { static $calls = 0; if (++$calls === 2) exit('exit;'); return $a <=> $b; };
${sort}
`)
  ).toMatchObject({ kind: 'executed', stdout: 'exit;{"1":5,"0":9,"2":2,"3":8,"4":7,"5":1,"6":6,"7":4,"8":3,"9":0}' });
});

test('releases temporary debug tables within each object inspection', () => {
  const result = run(`<?php
class TemporaryDebugValue { public function __destruct() { echo 'released;'; } }
class Displayed { public function __debugInfo(): array { return ['value' => new TemporaryDebugValue]; } }
$object = new Displayed;
var_dump($object, 'next');
print_r([$object, 'next']);
`);
  expect(result.kind === 'executed' && result.stdout).toContain('released;}\nstring(4) "next"\nreleased;Array\n');
});

test.each([
  ['print_r(new Displayed, true);', '[internal function]'],
  ['array_filter([1], fn() => new TemporaryValue);', '[internal function]'],
  ['$value = new TemporaryValue; unset($value);', '/main.php(5)'],
])('uses the release origin in a destructor stack frame after %s', (action, origin) => {
  expect(
    run(`<?php
class TemporaryValue { public function __destruct() { throw new Exception('drop'); } }
class Displayed { public function __debugInfo(): array { return [new TemporaryValue]; } }
try {
    ${action}
} catch (Exception $error) { echo $error->getTraceAsString(); }
`)
  ).toMatchObject({ kind: 'executed', stdout: expect.stringContaining(`#0 ${origin}: TemporaryValue->__destruct()`) });
});

test('keeps the native offsetSet frame in SplObjectStorage append errors', () => {
  expect(run('<?php\n$storage = new SplObjectStorage;\n$storage[] = new stdClass;')).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('#0 /main.php(3): SplObjectStorage->offsetSet(NULL, Object(stdClass))'),
  });
});

test.each(['new TemporaryValue($number)', '[new TemporaryValue($number)]'])(
  'uses the native frame when retiring a reduce result held as %s',
  (carry) => {
    expect(
      run(`<?php
class TemporaryValue {
  public function __construct(private int $number) {}
  public function __destruct() { if ($this->number === 1) throw new Exception('drop'); }
}
try { array_reduce([1, 2], fn($carry, $number) => ${carry}); }
catch (Exception $error) { echo $error->getTraceAsString(); }
`)
    ).toMatchObject({
      kind: 'executed',
      stdout: expect.stringContaining('#0 [internal function]: TemporaryValue->__destruct()'),
    });
  }
);

test('retires the retained reduce accumulator inside the native frame after callback exit', () => {
  expect(
    run(`<?php
class TemporaryValue { public function __destruct() { throw new Exception('drop'); } }
try { array_reduce([1, 2], fn($carry, $number) => $number === 1 ? [[new TemporaryValue]] : exit('exit;')); }
catch (Exception $error) { echo $error->getTraceAsString(); }
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'exit;#0 [internal function]: TemporaryValue->__destruct()\n#1 /main.php(3): array_reduce(Array, Object(Closure))\n#2 {main}',
  });
});

test.each([
  ['1, 2', '2:#0 /main.php(6): TemporaryValue->__destruct()'],
  ['1, 2, 3', '2:#0 [internal function]: TemporaryValue->__destruct()'],
])('uses the correct frame for a successor reduce result after exit with %s', (items, frame) => {
  expect(
    run(`<?php
class TemporaryValue {
  public function __construct(private int $number) {}
  public function __destruct() { echo $this->number, ':'; debug_print_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS); if ($this->number === 1) exit('exit;'); }
}
array_reduce([${items}], fn($carry, $number) => new TemporaryValue($number));
`)
  ).toMatchObject({ kind: 'executed', stdout: expect.stringContaining(frame) });
});

test.each([
  "json_encode(array_fill(0,100000,str_repeat('x',10000)));",
  "json_encode(array_fill(0,100,str_repeat('x',10000)),JSON_PRETTY_PRINT);",
  'json_encode(str_repeat(chr(1),200000));',
  "mb_convert_encoding([str_repeat('x',300000)],'UTF-32BE','UTF-8');",
  "mb_convert_encoding([str_repeat('x',300000)=>1],'UTF-32BE','UTF-8');",
])('bounds native encoded strings before constructing oversized results: %s', (call) => {
  const result = run(`<?php ${call}echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  'strlen($a[]);',
  'abs($a[]);',
  'function f($x){} f($a[]);',
  'strlen(string: $a[]);',
  'function f(&$x,...$values){} f($a[], $b[]);',
  'SplFixedArray::fromArray($a[]);',
  'class A extends SplFixedArray{} A::fromArray(array: $a[]);',
])('rejects append reads in known value arguments before output: %s', (source) => {
  expect(run(`<?php echo 'before'; ${source}`).kind).toBe('compileError');
});

test.each(['ArrayIterator', 'ArrayObject'])('iterates native array storage in linear time: %s', (name) => {
  vi.restoreAllMocks();
  expect(run(`<?php $a=new ${name}(range(1,20000));$sum=0;foreach($a as $v)$sum+=$v;echo $sum;`)).toMatchObject({
    kind: 'executed',
    stdout: '200010000',
  });
});

test.each(['return 1;', 'echo "finally";throw new Exception("replacement");'])(
  'catch-body memory failure bypasses finally replacement: %s',
  (body) => {
    const result = run(
      `<?php function f(){try{throw new Exception;}catch(Throwable $e){str_repeat('x',1000000000);}finally{${body}}}echo f(),'never';`
    );
    expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
    expect(result.kind === 'executed' && result.stdout).not.toMatch(/finally|replacement|never/);
  }
);

test('stream resources cannot retain learner state between executions', () => {
  expect(run('<?php $s=STDOUT;try{$s->marker="local";}catch(Throwable $e){echo $e->getMessage();}')).toMatchObject({
    kind: 'executed',
    stdout: 'Attempt to assign property "marker" on resource',
  });
  expect(run('<?php $s=STDOUT;echo $s->marker ?? "absent";')).toMatchObject({ kind: 'executed', stdout: 'absent' });
});

test('typed property constraints stay bounded under repeated reference binding', () => {
  vi.restoreAllMocks();
  expect(
    run('<?php class A{public int $x=1;}$a=new A;$r=&$a->x;for($i=0;$i<12000;$i++){$a->x=&$r;$r++;}echo $a->x;')
  ).toMatchObject({ kind: 'executed', stdout: '12001' });
});

test('temporary releases stay bounded with a large live object collection', () => {
  vi.restoreAllMocks();
  expect(
    run(
      '<?php class P{function __construct(public int $x){}}$live=[];for($i=0;$i<10000;$i++)$live[]=new P($i);for($i=0;$i<20000;$i++)$q=new P($i);echo count($live);'
    )
  ).toMatchObject({ kind: 'executed', stdout: '10000' });
});

test('destructor-created temporaries do not rescan the remaining object chain', () => {
  vi.restoreAllMocks();
  expect(
    run(
      '<?php class Node{public $next;function __construct($next){$this->next=$next;}function __destruct(){$t=new stdClass;}}$n=null;for($i=0;$i<10000;$i++)$n=new Node($n);unset($n);echo "done";'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'done' });
});

test.each([
  'echo "before";namespace A;echo "after";',
  'namespace A;echo "before";namespace B{echo "after";}',
  'namespace A{}echo "after";',
  'namespace A{}declare(ticks=1);',
  'echo "before"; $a=["x"=>["y"=>1]]; echo "${a[\'x\'][\'y\']}";',
  'echo "before"; $a=[]; echo "${a[\'x\']->p}";',
  'echo "before"; class A{function __construct(public readonly $x){}}',
  'echo "before"; class A{function __construct(public callable $x){}}',
  'echo "before"; class A{function __get(int $name):mixed{return 1;}}',
  'echo "before"; class A{function __isset(int $name):bool{return true;}}',
  'echo "before"; class A{function __call(string $name,string $args):mixed{return 1;}}',
])('rejects invalid file structure and declaration contracts before output: %s', (source) => {
  expect(run(`<?php ${source}`).kind).toBe('compileError');
});

test.each([`$a=new ArrayObject([1]);$a->exchangeArray($a);`, `$a=new ArrayIterator([1]);$a->__construct($a);`])(
  'rejects self property-backed native storage explicitly: %s',
  (source) => {
    expect(run(`<?php ${source} echo 'never';`)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
);

test.each([
  `'["'.str_repeat(chr(255),400000).'"]'`,
  `'{"x":"'.str_repeat(chr(255),400000).'"}'`,
  `'{"'.str_repeat(chr(255),400000).'":1}'`,
])('bounds malformed JSON strings inside containers before storing them: %s', (json) => {
  const result = run(`<?php json_decode(${json},true,512,JSON_INVALID_UTF8_SUBSTITUTE);echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  ['$a=range(1,20000);$sum=0;while(count($a)>0){$sum+=array_pop($a);}echo $sum;', '200010000'],
  ['$a=range(1,20000);$sum=0;while(next($a)!==false)$sum++;echo $sum;', '19999'],
  [
    '$a=range(1,20000);$sum=0;for($i=0;$i<20000;$i++)$sum+=end($a)+array_key_last($a)+array_last($a);echo $sum;',
    '1199980000',
  ],
])('keeps array order operations linear across a loop: %s', (source, stdout) => {
  vi.restoreAllMocks();
  expect(run(`<?php ${source}`)).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  '$s=new SplQueue;for($i=0;$i<10000;$i++)$s->enqueue($i);',
  '$s=new SplQueue;for($i=0;$i<10000;$i++)$s->enqueue(new stdClass);',
  '$s=new SplStack;for($i=0;$i<10000;$i++)$s->push($i);',
  '$s=new SplFixedArray(20000);',
  '$s=new SplMinHeap;for($i=0;$i<10000;$i++)$s->insert($i);',
])('does not rescan native storage during unrelated object churn: %s', (source) => {
  vi.restoreAllMocks();
  expect(run(`<?php ${source} for($i=0;$i<10000;$i++)$z=new stdClass;echo 'ok';`)).toMatchObject({
    kind: 'executed',
    stdout: 'ok',
  });
});

test.each([
  'goto L;try{}finally{L:echo "never";}',
  'try{}finally{goto L;}L:echo "never";',
  'while(true){try{}finally{break;}}',
  'while(true){try{}finally{continue;}}',
  'while(true){try{}finally{while(true){break 2;}}}',
  'function f(true|false $x){}',
  'class A{public true|false|null $x;}',
  'function f():true|false{}',
  'use function strlen as x;use function count as X;',
  'use const PHP_VERSION as X;use const PHP_EOL as X;',
  'class X{}use Foo as X;',
  'use Foo as X;class X{}',
  'function x(){}use function strlen as x;',
  'use function strlen as x;if(false){function x(){}}',
  'const X=1;use const PHP_EOL as X;',
  'use const PHP_EOL as X;const X=1;',
])('rejects invalid symbol declarations and finally transfers before output: %s', (source) => {
  expect(run(`<?php echo 'never';${source};`).kind).toBe('compileError');
});

test.each([
  'class A{public int $x=null;}',
  'class A{public static int $x=null;}',
  'class A{public int|string $x=null;}',
  'class A{public iterable $x=null;}',
])('reports a non-nullable property default before output: %s', (source) => {
  expect(run(`<?php echo 'never';${source};`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('may not be null. Use the nullable type') }],
  });
});

test.each([
  [
    'interface A{const X=1;}interface B{const X=2;}class C implements A,B{}',
    'inherits both A::X and B::X, which is ambiguous',
  ],
  ['interface A{final const X=1;}class B implements A{const X=2;}', 'cannot override final constant A::X'],
  [
    'class A{const int X=1;}class B extends A{const string X="x";}',
    'Type of B::X must be compatible with A::X of type int',
  ],
  ['class A{const int X=1;}class B extends A{const X=1;}', 'Type of B::X must be compatible with A::X of type int'],
  [
    'interface A{const int X=1;}class B implements A{const X=2;}',
    'Type of B::X must be compatible with A::X of type int',
  ],
  ['trait T{const X=1;}class A{use T;const X=2;}', 'definition differs and is considered incompatible'],
  ['trait T{const X=1;}trait U{const X=2;}class A{use T,U;}', 'definition differs and is considered incompatible'],
  [
    'trait T{public const X=1;}class A{use T;protected const X=1;}',
    'definition differs and is considered incompatible',
  ],
  ['trait T{const int X=1;}class A{use T;const X=1;}', 'definition differs and is considered incompatible'],
  [
    'class A{public int $x=1;}class B extends A{public protected(set) int $x=2;}',
    'Set access level of B::$x must be omitted',
  ],
  [
    'class A{public protected(set) int $x=1;}class B extends A{public private(set) int $x=2;}',
    'Set access level of B::$x must be protected(set)',
  ],
])('rejects incompatible member contracts: %s', (source, message) => {
  const result = run(`<?php ${source}echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toContain(message);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  'function f(true $x=![1]){}',
  'class A{public true $x=![1];}',
  'function f(false $x=!![1]){}',
  'class A{public true $x=![...[],1];}',
  'switch(1): ?>\n    <?php case 1:echo 1;endswitch;',
  'switch(1){ ?>x<?php case 1:echo 1;}',
])('rejects invalid known array defaults and switch prefixes before output: %s', (source) => {
  expect(run(`<?php echo 'never';${source};`).kind).toBe('compileError');
});

test.each([
  ['abstract class A implements I{public string $x;}', 'Type of A::$x must be subtype of int'],
  ['abstract class A implements I{protected int $x;}', 'Access level to A::$x must be public'],
  ['abstract class A implements I{public static int $x;}', 'Cannot redeclare non static I::$x as static A::$x'],
  ['class A implements I{public static int $x;}', 'Cannot redeclare non static I::$x as static A::$x'],
])('checks property contracts for every consumer: %s', (declaration, message) => {
  const result = run(`<?php interface I{public int $x{get;}}${declaration}echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toContain(message);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  ['static', 'Cannot use "static" as method modifier in trait alias'],
  ['abstract', 'Cannot use "abstract" as method modifier in trait alias'],
  ['readonly', 'Cannot use the readonly modifier on a method'],
])('rejects the %s modifier on a trait adaptation', (modifier, message) => {
  expect(
    run(`<?php
trait Role { function run() {} }
class C {
    use Role { run as ${modifier}; }
}
echo 'never';`)
  ).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message }],
  });
});

test.each([
  ['public class A {}', 'unexpected token "public", expecting end of file'],
  ['static class A {}', 'unexpected token "class", expecting "::"'],
  ['final public class A {}', 'unexpected token "public", expecting "abstract"'],
  ['private const A = 1;', 'unexpected token "private", expecting end of file'],
  ['echo "a".1 + 2;', 'unexpected floating-point number ".1", expecting "," or ";"'],
  ['$a = 1; echo $a.5;', 'unexpected floating-point number ".5"'],
  ['echo 1.2.3;', 'unexpected floating-point number ".3"'],
  [
    'class A { function __construct(public int $a = null) {} }',
    'Cannot use null as default value for parameter $a of type int',
  ],
  [
    'class A { function __construct(public int|string $a = null) {} }',
    'Cannot use null as default value for parameter $a of type string|int',
  ],
])('reports PHP lexical and declaration errors: %s', (source, message) => {
  const result = run(`<?php\n${source}`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain(message);
});

test('handles duplicate named arguments when a call executes', () => {
  expect(
    run(`<?php
function named($argument) {}
echo 'start;';
if (false) named(argument: 1, argument: 2);
try { named(argument: 1, argument: 2); } catch (Error $error) { echo $error->getMessage(), ';'; }
try { missing(argument: 1, argument: 2); } catch (Error $error) { echo $error->getMessage(); }
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'start;Named parameter $argument overwrites previous argument;Call to undefined function missing()',
  });
});

test.each(['T,U', 'U,T'])('retains abstract trait contracts despite precedence: %s', (order) => {
  const result = run(
    `<?php trait T{abstract function f(int $x):int;}trait U{function f(string $x):int{return 1;}}class A{use ${order}{U::f insteadof T;}}echo 'never';`
  );
  expect(result.kind === 'executed' && result.stdout).toContain(
    'Declaration of A::f(string $x): int must be compatible with T::f(int $x): int'
  );
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  ['class A{use T{f as final g;}function f(){}function g(){}}', 'g'],
  ['class B{function f(){}}class A extends B{use T{f as final;}}', 'f'],
  ['trait U{function f(){}}class A{use T,U{T::f as final;}}', 'f'],
])('enforces final abstract trait contracts against visible implementations: %s', (source, name) => {
  const result = run(`<?php trait T{abstract function f();} ${source} echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toContain(`Cannot override final method T::${name}()`);
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  ['self', 'A'],
  ['self', 'self'],
  ['?self', '?A'],
  ['parent', 'P'],
])('compares trait property declaration scopes: %s / %s', (traitType, classType) => {
  const result = run(
    `<?php class P{}trait T{public ${traitType} $x;}class A extends P{use T;public ${classType} $x;}echo 'never';`
  );
  expect(result.kind === 'executed' && result.stdout).toContain('definition differs and is considered incompatible');
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test.each([
  ['$a=range(1,10000);$sum=0;while(count($a)>1){$sum+=array_shift($a);}echo count($a),":",$sum;', '1:49995000'],
  ['$a=[];for($i=0;$i<20000;$i++)array_unshift($a,$i);echo count($a),":",$a[0],":",$a[19999];', '20000:19999:0'],
  [
    '$a=range(1,3000);$sum=0;for($i=0;$i<6000;$i++){$sum+=array_shift($a);$a[]=3001+$i;}echo count($a),":",$sum;',
    '3000:18003000',
  ],
])('keeps packed queues within the execution budget: %s', (source, stdout) => {
  vi.restoreAllMocks();
  expect(run(`<?php ${source}`)).toMatchObject({ kind: 'executed', stdout });
});

test.each(['rewind', 'current'])('releasing ArrayIterator %s watchers keeps storage exchanges bounded', (method) => {
  expect(
    run(
      `<?php $array=new ArrayObject([1]);for($i=0;$i<10000;$i++){$it=$array->getIterator();$it->${method}();unset($it);$array->exchangeArray([$i]);}echo $array[0];`
    )
  ).toMatchObject({ kind: 'executed', stdout: '9999' });
});

test.each(['array_walk', 'array_walk_recursive'])('repeated %s releases cursors before array mutations', (walk) => {
  expect(
    run(
      `<?php function visit(&$value){$value++;}$a=[1];for($i=0;$i<10000;$i++){${walk}($a,'visit');$a[]=0;array_pop($a);}echo $a[0];`
    )
  ).toMatchObject({ kind: 'executed', stdout: '10001' });
});

test('completes object churn with buffered cyclic containers within the operation limit', () => {
  const source = `<?php gc_disable();class Node{public $prev;public $next;public $data;function __construct($v){$this->data=['v'=>$v,'tag'=>new stdClass];}}function build($n){$head=new Node(0);$cur=$head;for($i=1;$i<$n;$i++){$x=new Node($i);$x->prev=$cur;$cur->next=$x;$cur=$x;}$s=0;for($c=$head;$c;$c=$c->next)$s+=$c->data['v'];return $s;}$t=0;for($k=0;$k<120;$k++)$t+=build(100);echo $t,":",gc_enabled()?1:0,":";$sum=0;for($i=0;$i<20000;$i++){$p=new stdClass;$p->v=$i;$sum+=$p->v;}echo $sum;`;
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '594000:0:199990000' });
});

test.each(['?self', '?A'])('preserves trait constant declaration type scope: %s', (type) => {
  const result = run(`<?php trait T{const ?self X=null;}class A{use T;const ${type} X=null;}echo 'never';`);
  expect(result.kind === 'executed' && result.stdout).toContain('definition differs and is considered incompatible');
  expect(result.kind === 'executed' && result.stdout).not.toContain('never');
});

test('keeps repeated short UTF-8 matches bounded on large subjects', () => {
  vi.restoreAllMocks();
  expect(run('<?php $s=str_repeat("a",1000000);for($i=0;$i<100;$i++)preg_match("/a/u",$s);echo "done";')).toMatchObject(
    {
      kind: 'executed',
      stdout: 'done',
    }
  );
});

test.each([
  ['class C{public self $x=null;}', 'type C may not be null'],
  ['class P{}class C extends P{public parent $x=null;}', 'type P may not be null'],
  ['class C{public self $x="s";}', 'property C::$x of type C'],
  ['trait T{public self $x=null;}', 'type self may not be null'],
])('checks compile-time declaration diagnostics: %s', (source, message) => {
  const result = run(`<?php ${source}`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain(message);
});

test.each([
  ["echo 'before';declare(encoding='UTF-8');", 'Encoding declaration pragma must be the very first statement'],
  [";declare(encoding='UTF-8');", 'Encoding declaration pragma must be the very first statement'],
  ["if(true){declare(encoding='UTF-8');}", 'Encoding declaration pragma must be the very first statement'],
  ['declare(encoding=true);', 'Encoding must be a literal'],
  ['declare(encoding=1+2);', 'Encoding must be a literal'],
])('checks compile-time declaration diagnostics: %s', (source, message) => {
  const result = run(`<?php ${source}`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain(message);
});

test.each(['![...[]]', '![...[...[]]]', '![...[1]]'])('validates resolved spread-array default truth: %s', (value) => {
  const result = run(`<?php class A{public int $x=${value};}echo 'never';`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain('Cannot use bool as default value');
});

test.each([
  ['while(false){class C{public int $x{get{break;}}}}', "not in the 'loop' or 'switch' context"],
  ['while(false){class C{public int $x{get{continue;}}}}', "not in the 'loop' or 'switch' context"],
  ['class C{public int $x{get{goto absent;}}}', "'goto' to undefined label"],
  ['function f(){static $this;}', 'Cannot use $this as static variable'],
  ['try{}catch(E $this){}', 'Cannot re-assign $this'],
  [
    'abstract class A{abstract function __construct(public $x);}',
    'Cannot declare promoted property in an abstract constructor',
  ],
  ['class A{readonly function f(){}}', 'Cannot use the readonly modifier on a method'],
  ['class A{function __construct(static $x){}}', 'Cannot use the static modifier on a parameter'],
  ['class A{function __construct(abstract $x){}}', 'Cannot use the abstract modifier on a parameter'],
  ['class A{var static $x;}', 'expecting variable'],
  [String.raw`use Project\Item as self;`, "because 'self' is a special class name"],
  ['function __autoload($name){}', '__autoload() is no longer supported'],
  ['declare(ticks=$x);', 'declare(ticks) value must be a literal'],
  ['try{}catch(parent $e){}', 'Bad class name in the catch statement'],
  ['const NULL=1;', "Cannot redeclare constant 'NULL'"],
  ['function f((A&B)|A $x){}', 'Type A&B is redundant as it is more restrictive than type A'],
  ['function f(?A&B $x){}', 'unexpected token "&"'],
  ['function f(){const A=1;}', 'unexpected token "const"'],
  ['if(true){use stdClass as S;}', 'unexpected token "use"'],
  ['class A{function f(){class B{}}}', 'Class declarations may not be nested'],
])('checks declaration and function boundaries before execution: %s', (source, message) => {
  const result = run(`<?php echo 'never'; ${source}`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain(message);
});

test.each([
  ['T::f insteadof U;', "Required Trait U wasn't added to Combined"],
  ['T::f insteadof Missing;', 'Could not find trait Missing'],
  ['Missing::f insteadof T;', 'Could not find trait Missing'],
  ['T::missing insteadof T;', 'A precedence rule was defined for T::missing but this method does not exist'],
  ['T::f insteadof T;', 'Inconsistent insteadof definition'],
  ['U::f as alias;', "Required Trait U wasn't added to Combined"],
  ['Missing::f as alias;', 'Could not find trait Missing'],
  ['T::missing as alias;', 'An alias was defined for T::missing but this method does not exist'],
  ['missing as alias;', 'An alias (alias) was defined for method missing(), but this method does not exist'],
])('rejects invalid trait adaptations: %s', (adaptation, message) => {
  const result = run(
    `<?php trait T{function f(){}} trait U{function f(){}} class Combined{use T{${adaptation}}}echo 'never';`
  );
  expect(result.kind).toBe('executed');
  if (result.kind === 'executed') {
    expect(result.stdout).toContain(message);
    expect(result.stdout).not.toContain('never');
  }
});

test.each([
  ['try{$arr=[...1];}catch(TypeError $e){echo "caught";}', 'int given'],
  ['function f($arr=[...null]){}', 'null given'],
  ['class C{const ARRAY=[...true];}', 'true given'],
])('rejects non-array unpacking in constant array literals: %s', (source, detail) => {
  const result = run(`<?php echo 'never'; ${source}`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError')
    expect(result.diagnostics[0]?.message).toContain(`Only arrays and Traversables can be unpacked, ${detail}`);
});

test('rejects references in the fixed arity signatures of magic methods', () => {
  const result = run("<?php echo 'never'; class C { function __get(&$name) {} }");
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError')
    expect(result.diagnostics[0]?.message).toContain('Method C::__get() cannot take arguments by reference');
});

test.each([
  ['$object?->method(...);', 'Cannot combine nullsafe operator with Closure creation'],
  ['$object?->property->method(...);', 'Cannot combine nullsafe operator with Closure creation'],
  ['function &result($object) { return $object?->property; }', 'Cannot take reference of a nullsafe chain'],
  ['$result = fn&($object) => $object?->property;', 'Cannot take reference of a nullsafe chain'],
  ['$array[] ??= 1;', 'Cannot use [] for reading'],
  ['$array[]->property ??= 1;', 'Cannot use [] for reading'],
  ['$array[][0] ??= 1;', 'Cannot use [] for reading'],
  ['[$value] = $array[];', 'Cannot use [] for reading'],
  ['$object->{1 + 1}();', 'Method name must be a string'],
  ['stdClass::{[]}();', 'Method name must be a string'],
  ['[&$value] = [[1]][0];', 'Cannot use temporary expression in write context'],
  ['class C { public $p = [1]; } [&$value] = (new C())->p;', 'Cannot use temporary expression in write context'],
  ['function f(&$arg) {} f((new stdClass())->p);', 'Cannot use temporary expression in write context'],
  ['{ function f(&$arg) {} } f((new stdClass())->p);', 'Cannot use temporary expression in write context'],
  ['{ function f(&$arg) {} f((new stdClass())->p); }', 'Cannot use temporary expression in write context'],
  [
    'new class { static function f(&$arg) {} static function g() { self::f((new stdClass())->p); } };',
    'Cannot use temporary expression in write context',
  ],
  [
    'new class { private function f(&$arg) {} function g() { $this->f((new stdClass())->p); } };',
    'Cannot use temporary expression in write context',
  ],
  ['class C extends A, B {}', 'unexpected token ","'],
])('validates write and declaration syntax: %s', (source, message) => {
  const result = run(`<?php echo 'never'; ${source}`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') expect(result.diagnostics[0]?.message).toContain(message);
});

test.each([
  ['namespace {\n  class G {}\n}\ninterface I {}\nnamespace Q {}', 'No code may exist outside of namespace {}'],
  ['namespace P;\nclass A {}\n\nnamespace Q { class B {} }', 'Cannot mix bracketed namespace declarations'],
  [
    'namespace {\n  class G {}\n}\ndeclare(strict_types=1);',
    'strict_types declaration must be the very first statement',
  ],
])('reports the offending namespace statement: %s', (source, message) => {
  const result = run(`<?php\n${source}`);
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0]?.row).toBe(4);
    expect(result.diagnostics[0]?.message).toContain(message);
  }
});

test.each([
  ['echo $a[];', 'Cannot use [] for reading'],
  ['unset($a[]);', 'Cannot use [] for unsetting'],
  ['function readIt() { echo $a[]; }', 'Cannot use [] for reading'],
])('reports earlier invalid array syntax before a later early-binding error: %s', (source, message) => {
  const result = run(
    `<?php\n${source}\nclass P { function method(callable $x) {} } class C extends P { function method(Closure $x) {} }`
  );
  expect(result.kind).toBe('compileError');
  if (result.kind === 'compileError') {
    expect(result.diagnostics[0]?.row).toBe(1);
    expect(result.diagnostics[0]?.message).toContain(message);
  }
});

test('mutates arrays held by many objects within the operation limit', () => {
  const source =
    '<?php class Student{public array $scores=[];}$students=[];for($i=0;$i<2000;$i++)$students[]=new Student;foreach($students as $s){$s->scores[]=1;$s->scores[]=2;}$sum=0;foreach($students as $s)$sum+=array_sum($s->scores);echo $sum;';
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '6000' });
});

test.each([false, true])('drains linked queues within the operation limit (doubly linked: %s)', (doublyLinked) => {
  const source = `<?php class N{public $next=null;public $prev=null;function __construct(public $v){}}class Q{public $head=null;public $tail=null;public $n=0;function push($v){$x=new N($v);if(!$this->tail){$this->head=$this->tail=$x;}else{${doublyLinked ? '$x->prev=$this->tail;' : ''}$this->tail->next=$x;$this->tail=$x;}$this->n++;}function shift(){$h=$this->head;$this->head=$h->next;if(!$this->head)$this->tail=null;${doublyLinked ? 'else $this->head->prev=null;' : ''}$this->n--;return $h->v;}}$q=new Q;for($i=0;$i<4000;$i++)$q->push($i);$sum=0;while($q->n>0)$sum+=$q->shift();echo $sum;`;
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '7998000' });
});

test('completes packed splice and keyed queues with time to spare', () => {
  vi.restoreAllMocks();
  const source =
    '<?php $people=range(1,4000);$i=0;while(count($people)>1){$i=($i+2)%count($people);array_splice($people,$i,1);}echo $people[0],"|";$tasks=[];for($i=0;$i<5000;$i++)$tasks["task$i"]=$i%7;$sum=0;while($tasks)$sum+=array_shift($tasks);echo $sum;';
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '3910|14995' });
});

test.each([
  ['new class{public self $x=null;}', 'type self may not be null'],
  ['new class{public self $x="s";}', 'property class@anonymous::$x of type self'],
  ['class P{} new class extends P{public parent $x=null;}', 'type parent may not be null'],
  ['class P{} new class extends P{public parent $x="s";}', 'property P@anonymous::$x of type parent'],
  ...['private', 'protected'].flatMap((visibility) =>
    ['get;', 'set;', 'get;set;'].map((hooks) => [
      `interface I{${visibility} int $x{${hooks}}}`,
      'Property in interface cannot be protected or private',
    ])
  ),
  ...['public(set)', 'protected(set)', 'private(set)'].flatMap((visibility) => [
    [`class A{public ${visibility} $x=1;}`, 'Property with asymmetric visibility A::$x must have type'],
    [
      `class A{function __construct(public ${visibility} $x=1){}}`,
      'Property with asymmetric visibility A::$x must have type',
    ],
  ]),
])('checks scoped property declaration contracts: %s', (source, message) => {
  const result = run(`<?php ${source};`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain(message);
});

test.each(['__FILE__', '__DIR__', '__LINE__', '__NAMESPACE__', "'a'.__LINE__", '(__FILE__)'])(
  'rejects nonliteral encoding origins: %s',
  (value) => {
    const result = run(`<?php declare(encoding=${value});echo 'never';`);
    expect(result.kind).toBe('compileError');
    expect(JSON.stringify(result)).toContain('Encoding must be a literal');
  }
);

test.each([
  '![...(true?[1]:[])]',
  '![...([1]+[])]',
  '![...(array)1]',
  '![...(false?MISSING:[1])]',
  '![...(array)(true?1:null)]',
  '![...((1===1)?[1]:[])]',
  '![...(([1]==[1])?[1]:[])]',
  '![...([[1]][0])]',
  '![...(array)Missing::class]',
])('folds complete constant default expressions: %s', (value) => {
  const result = run(`<?php echo 'never';function f(true $x=${value}){}echo 'never';`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain('Cannot use bool as default value');
});

test('drains indexed queues and packed deques with time to spare', () => {
  vi.restoreAllMocks();
  const source =
    '<?php $a=range(1,6000);next($a);$s=0;while($a)$s+=array_shift($a);echo $s,"|";$a=range(1,8000);unset($a[3]);$s=0;while($a)$s+=array_shift($a);echo $s,"|";$a=range(1,6000);$s=0;while($a){$s+=array_pop($a);if($a)$s+=array_shift($a);}echo $s;';
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '18003000|32003996|18003000' });
});

test.each([
  "'9223372036854775808' == '9223372036854775809'",
  "'1e999' == '2e999'",
  "[['1e999']] == [['2e999']]",
  "'9223372036854775807' == '9223372036854775808'",
])('folds overflowing numeric string comparisons in parameter defaults: %s', (condition) => {
  const result = run(`<?php echo 'never'; function f(int $x = (${condition}) ? 1 : 'x') {} f();`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain('Cannot use string as default value for parameter $x of type int');
});

test.each(['"01"', '"+1"', '"-0"', '" 1"', '"1 "', '"1x"', '"1ex"'])(
  'folds PHP compile-time string offsets: %s',
  (offset) => {
    const result = run(`<?php echo 'never';function f(int $x="abc"[${offset}]){}f(1);`);
    expect(result.kind).toBe('compileError');
    expect(JSON.stringify(result)).toContain('Cannot use string as default value');
  }
);

test.each(['0.0', '1.0', '-1.0', 'false', 'true', 'null', '"1.0"', '"1e0x"', '-1', '"-1x"'])(
  'defers PHP runtime string offsets when the default is unused: %s',
  (offset) => {
    expect(run(`<?php echo 'run';function f(int $x="abc"[${offset}]){}f(1);echo 'ok';`)).toMatchObject({
      kind: 'executed',
      stdout: 'runok',
    });
  }
);

test.each(['0.0', 'false', 'true', 'null'])(
  'defers noninteger array offsets when the default is unused: %s',
  (offset) => {
    expect(run(`<?php function f(string $x=[1,2][${offset}]){}f('ok');echo 'ok';`)).toMatchObject({
      kind: 'executed',
      stdout: 'ok',
    });
  }
);

test.each(['1.5<=>"x"', '"x"<=>1.5', '1.5=="x"', '1.5<"x"', '1.5>"x"', '1.5==""', '1.5<=>"1x"'])(
  'validates folded float/string comparisons before executing: %s',
  (value) => {
    expect(run(`<?php echo 'never';function f(string $x=${value}){}`).kind).toBe('compileError');
    expect(run(`<?php echo 'never';class C{public string $x=${value};}`).kind).toBe('compileError');
  }
);

test('folds float/string comparisons inside spread defaults', () => {
  expect(run('<?php echo "never";function f(true $x=![...((1.5<"x")?[1]:[])]){}').kind).toBe('compileError');
});

test.each([6, 14].flatMap((flags) => ['a', '0', '1', ' '].map((text) => [flags, text] as const)))(
  'interrupts natural multisort byte walks (flags: %s, text: %s)',
  (flags, text) => {
    expect(
      run(`<?php $a=array_fill(0,2000,str_repeat('${text}',256));array_multisort($a,${flags});echo 'never';`)
    ).toEqual({
      kind: 'limitExceeded',
      limit: 'operations',
    });
  }
);

test.each([
  'class A { protected(set) private int $p; }',
  'class A { public(set) protected int $p; }',
  'class A { public(set) protected readonly int $p; }',
  'class A { protected(set) private static int $p; }',
  'class A { function __construct(public(set) private readonly int $p) {} }',
  'new class { protected(set) private int $p; }',
])('rejects setters wider than property reads: %s', (source) => {
  const result = run(`<?php echo 'never';${source};`);
  expect(result.kind).toBe('compileError');
  expect(JSON.stringify(result)).toContain('must not be weaker than set visibility');
});

test('releases objects holding shared arrays with time to spare', () => {
  vi.restoreAllMocks();
  expect(
    run(
      '<?php class N{function __construct(public $meta){}}$meta=range(1,30000);$sum=0;for($i=0;$i<2000;$i++){$x=new N($meta);$sum+=$x->meta[4];}echo $sum;'
    )
  ).toMatchObject({ kind: 'executed', stdout: '10000' });
});

test.each(
  ['(-1)**0.5', '1e999-1e999'].flatMap((nan) => [
    `(${nan})=="NAN"`,
    `"NAN"==(${nan})`,
    `(${nan})<"x"`,
    `"x">(${nan})`,
    `(${nan})>""`,
    `""<(${nan})`,
    `(${nan})<="NAN"`,
    `"NAN">=(${nan})`,
  ])
)('folds unordered NaN comparisons in defaults: %s', (value) => {
  expect(run(`<?php function f(false $x=${value}){var_dump($x);}f();`)).toMatchObject({
    kind: 'executed',
    stdout: 'bool(false)\n',
  });
  expect(run(`<?php echo 'never';function f(true $x=${value}){}`).kind).toBe('compileError');
});

test.each([
  '"A".true',
  '"A".-1',
  '"A".+1',
  '"A".false',
  '"A".null',
  '"A".(1+2)',
  'true||missing()',
  'false&&missing()',
  '1',
  '[]',
])('rejects compiler-folded class receivers before executing: %s', (receiver) => {
  expect(run(`<?php echo 'never';try{var_dump((${receiver})::class);}catch(Throwable $e){echo 'caught';}`).kind).toBe(
    'compileError'
  );
});

test.each(['"A".(string)1', '"A"??"B"', 'true?"A":"B"', '"A"[0]'])(
  'keeps dynamic class receivers catchable: %s',
  (receiver) => {
    expect(
      run(`<?php echo 'run';try{var_dump((${receiver})::class);}catch(Throwable $e){echo 'caught';}`)
    ).toMatchObject({ kind: 'executed', stdout: 'runcaught' });
  }
);

test.each([
  'class C{public int $x{get=>1;get=>2;}}',
  'class C{public int $x{set{}set{}}}',
  'class C{public readonly int $x{get=>1;}}',
  'readonly class C{public int $x{get=>1;}}',
  'class C{public readonly int $x=1{get{return $this->x;}}}',
])('rejects invalid property hook contracts before executing: %s', (declaration) => {
  expect(run(`<?php echo 'never';${declaration}`).kind).toBe('compileError');
});

test.each(['mb_detect_encoding($text,$encodings)', 'mb_convert_encoding($text,"UTF-8",$encodings)'])(
  'bounds encoding detection across candidates: %s',
  (call) => {
    expect(
      run(`<?php $text=str_repeat("a",10000);$encodings=array_fill(0,20000,"UTF-8");${call};echo 'never';`)
    ).toEqual({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test.each([
  '<?php class Item{function __construct(public $id,public array $cfg){}}$cfg=range(1,3);$items=[];for($i=0;$i<6000;$i++)$items[]=new Item($i,$cfg);echo count($items);',
  '<?php function items(){$cfg=range(1,3);$items=[];for($i=0;$i<6000;$i++)$items[]=["cfg"=>$cfg];return $items;}function size($cfg){return count($cfg);}$n=0;foreach(items() as $item)$n+=size($item["cfg"]);echo $n/3;',
])('retains shared arrays without scanning every holder: %s', (program) => {
  vi.restoreAllMocks();
  expect(run(program)).toMatchObject({ kind: 'executed', stdout: '6000' });
});

test('a timed-out pattern compilation does not affect the next run', () => {
  const pattern = `/${'b'.repeat(256)}${crypto.randomUUID()}/`;
  const program = `<?php var_dump(preg_match('${pattern}', 'no match'));`;
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(3000);
  expect(run(program)).toEqual({ kind: 'limitExceeded', limit: 'time' });
  expect(run(program)).toMatchObject({ kind: 'executed', stdout: 'int(0)\n' });
});

test.each(['PHP_EOL', 'PHP_EOL . "A"', 'PHP_INT_MAX', 'PHP_INT_MAX + 1'])(
  'rejects compile-time native constants as class receivers: %s',
  (value) => {
    expect(run(`<?php echo 'never';try {var_dump((${value})::class);}catch(Throwable $e){echo 'caught';}`).kind).toBe(
      'compileError'
    );
  }
);

test('keeps runtime-defined class receivers catchable', () => {
  expect(
    run('<?php define("VV","X");echo "start;";try{var_dump((VV . "")::class);}catch(Throwable $e){echo "caught;";}')
  ).toMatchObject({ kind: 'executed', stdout: 'start;caught;' });
});

test.each([
  '0&&missing()',
  '1||missing()',
  '-1||missing()',
  '""&&missing()',
  '"a"||missing()',
  '"0"&&missing()',
  '[]&&missing()',
  '[1]||missing()',
])('rejects short-circuit class receivers after folding PHP truthiness: %s', (receiver) => {
  expect(run(`<?php echo 'never';try{var_dump((${receiver})::class);}catch(Throwable $e){echo 'caught';}`).kind).toBe(
    'compileError'
  );
});

test.each([
  'class A{const K="x";} (A::K)::class;',
  'class A{const K=42;}function f(){(A::K)::class;}',
  'class A{const K=[1];}class B extends A{}(B::K)::class;',
  'interface A{const K="x";}(A::K)::class;',
  'class A{private const K="x";function f(){(self::K)::class;}}',
  'class A{const X="x",K=self::X;}(A::K)::class;',
  'class A{const float K=1;}(A::K)::class;',
  '(ArrayIterator::STD_PROP_LIST)::class;',
])('folds source-order class constants before checking class receivers: %s', (program) => {
  expect(run(`<?php echo 'never';${program}`).kind).toBe('compileError');
});

test.each([
  'try{(A::K)::class;}catch(Throwable $e){echo "caught";}class A{const K="x";}',
  'if(true){class A{const K="x";}}try{(A::K)::class;}catch(Throwable $e){echo "caught";}',
  'interface I{const K="x";}class A implements I{}try{(A::K)::class;}catch(Throwable $e){echo "caught";}',
  'class A{private const K="x";}try{(A::K)::class;}catch(Throwable $e){echo "caught";}',
  'class A{const K="x";}class B extends A{function f(){try{(self::K)::class;}catch(Throwable $e){echo "caught";}}}(new B)->f();',
  'class A{const K=B::K;}class B{const K="x";}try{(A::K)::class;}catch(Throwable $e){echo "caught";}',
])('leaves unresolved class constant receivers catchable: %s', (program) => {
  expect(run(`<?php echo 'start;';${program}`)).toMatchObject({ kind: 'executed', stdout: 'start;caught' });
});

test.each([
  '[,"b"=>$value] = ["b"=>3];',
  'list("a"=>$a,,"c"=>$c) = ["a"=>1,"c"=>3];',
  'foreach ([["b"=>3]] as [,"b"=>$value]) {}',
])('rejects a skipped entry in keyed destructuring: %s', (statement) => {
  expect(run(`<?php echo 'never'; ${statement}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'Cannot use empty array entries in keyed array assignment' }],
  });
});

test.each(['mixed', 'int'])('rejects a %s setter parameter on an untyped property', (type) => {
  expect(run(`<?php echo 'never'; if (false) { class C { public $field { set(${type} $value) {} } } }`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [
      { row: 0, message: 'Type of parameter $value of hook C::$field::set must be compatible with property type' },
    ],
  });
});

test.each([
  ['1 ? 2 : 3 ? 4 : 5', '(a ? b : c) ? d : e', 'a ? b : (c ? d : e)'],
  ['1 ? 2 : 3 ?: 4', '(a ? b : c) ?: d', 'a ? b : (c ?: d)'],
  ['1 ?: 2 ? 3 : 4', '(a ?: b) ? c : d', 'a ?: (b ? c : d)'],
])('explains unparenthesized ternaries: %s', (expression, left, right) => {
  const execution = run(`<?php echo ${expression};`);
  expect(execution.kind).toBe('compileError');
  if (execution.kind === 'compileError') {
    expect(execution.diagnostics[0].message).toContain(`Use either \`${left}\` or \`${right}\``);
  }
});

test.each([
  'strlen("a")->p = 1;',
  'count([])[0] = 1;',
  'sprintf("%d", 1)->p = 1;',
  'in_array("a", ["a"])->p = 1;',
  '(clone $object)->p = 1;',
  'namespace Example; use function strlen; strlen("a")->p = 1;',
])('rejects writes to a compiler builtin result: %s', (statement) => {
  expect(run(`<?php ${statement}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'Cannot use result of built-in function in write context' }],
  });
});

test('leaves ordinary call results writable', () => {
  const program = `<?php
    namespace Example;
    function make() { return new \\stdClass(); }
    make()->p = 1;
    \\array_map(fn($v) => $v, [])[0] = 1;
    echo 'done';
  `;
  expect(run(program)).toMatchObject({ kind: 'executed', stdout: 'done' });
});

test.each(['static', '?static'])('rejects %s parameter types independently of return types', (type) => {
  expect(run(`<?php class C { function f(${type} $value): static { return $this; } }`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: 'Cannot use the static modifier on a parameter' }],
  });
  expect(run('<?php class C { function f(): static { return $this; } } echo (new C())->f()::class;')).toMatchObject({
    kind: 'executed',
    stdout: 'C',
  });
});

test.each([
  ['fopen', 'fopen("file.txt", "r")'],
  ['file_get_contents', 'file_get_contents("file.txt")'],
])('reports unsupported %s from a replacement throwable stringifier', (name, expression) => {
  const program = `<?php
    class First extends Exception { function __toString(): string { throw new Second(); } }
    class Second extends Exception { function __toString(): string { return ${expression}; } }
    echo "before";
    throw new First();
  `;
  expect(run(program)).toMatchObject({
    kind: 'executed',
    stdout: 'before',
    uncaughtException: `ファイルの読み書き（${name}）は、この採点環境では使えません。`,
  });
});

test.each([
  ["$text = str_repeat('a', 600000); echo strspn($text, str_repeat('b', 599999).'a');", '600000'],
  ["$text = str_repeat('a', 600000); echo strcspn($text, str_repeat('b', 600000));", '600000'],
  ["var_dump(strpbrk(str_repeat('a', 600000), str_repeat('b', 600000)));", 'bool(false)\n'],
  ["echo strlen(ucwords(str_repeat('a', 600000), str_repeat('b', 600000)));", '600000'],
  ["echo strlen(wordwrap(str_repeat('a', 900000), 900000, str_repeat('a', 450000).'b'));", '900000'],
  ["echo strlen(strip_tags(str_repeat('<a>', 200000), str_repeat('x', 600000).'<b>'));", '0'],
])('bounds native byte scan work: %s', (source, stdout) => {
  vi.restoreAllMocks();
  expect(run(`<?php ${source}`)).toMatchObject({ kind: 'executed', stdout });
});

test('bounds combined allowed tags before strip_tags builds the list', () => {
  const result = run(`<?php $tag = str_repeat('a', 600000); strip_tags('hello', [$tag, $tag]); echo 'unreachable';`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(/^\nFatal error: Allowed memory size/),
  });
});

test.each(['PHP_INT_MAX', '1e40'])('counts every thousands separator in the formatted length for %s', (value) => {
  const result = run(`<?php number_format(${value}, 0, '.', str_repeat('x', 200000)); echo 'unreachable';`);
  expect(result.kind === 'executed' && result.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test('counts matches without spending slots on omitted preg_match_all output', () => {
  vi.restoreAllMocks();
  const result = run(`<?php echo preg_match_all('/(a)()()()()()/', str_repeat('a', 200000));`);
  expect(result).toMatchObject({ kind: 'executed', stdout: '200000' });
});

test('advances linked object and array heads while their nodes share an otherwise unheld object', () => {
  vi.restoreAllMocks();
  const result = run(`<?php
    class Link { public $next; public $shared; }
    function makeList($count, $array) {
      $shared = new stdClass;
      $head = null;
      for ($index = 0; $index < $count; $index++) {
        if ($array) $head = ['shared' => $shared, 'next' => $head];
        else {
          $node = new Link;
          $node->next = $head;
          $node->shared = $shared;
          $head = $node;
        }
      }
      return $head;
    }
    foreach ([false, true] as $array) {
      $head = makeList(2500, $array);
      $count = 0;
      while ($head) {
        $head = $array ? $head['next'] : $head->next;
        ++$count;
      }
      echo $count, "\\n";
    }`);
  expect(result).toMatchObject({ kind: 'executed', stdout: '2500\n2500\n' });
});

test.each([
  ['int&C&float', 'Type int cannot be part of an intersection type'],
  ['iterable&array', 'Type Traversable|array cannot be part of an intersection type'],
  ['void|int', 'Void can only be used as a standalone type'],
  ['bool|false', 'Duplicate type false is redundant'],
  ['iterable|Traversable', 'Duplicate type Traversable is redundant'],
  ['object|C', 'Type C|object contains both object and a class type, which is redundant'],
  ['int|INT', 'Duplicate type int is redundant'],
])('reports the offending PHP type in %s', (type, diagnostic) => {
  expect(run(`<?php class Q { function m(${type} $value) {} } echo 'unexpected';`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: diagnostic }],
  });
});

test.each(['(NAN xor true)::class', '(("x".(1.5+1))||missing())::class'])(
  'rejects folded class receivers %s',
  (expression) => {
    expect(
      run(`<?php echo 'never'; try { var_dump(${expression}); } catch (Throwable $e) { echo 'caught'; }`)
    ).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 0, message: expect.stringContaining('Cannot use "::class"') }],
    });
  }
);

test.each([
  ['const F = static function () { var_dump((NAN || true)::class); };', 'Cannot use "::class" on true'],
  ['class A { const F = static function () { var_dump((NAN || true)::class); }; }', 'Cannot use "::class" on true'],
  ['class A { const VALUE = 1; } isset(A::VALUE);', 'Cannot use isset() on the result of an expression'],
  ['var_dump(1 < 2 < 3);', 'unexpected token "<"'],
  ['var_dump(1 <=> 2 == 3);', 'unexpected token "=="'],
  ['var_dump(match(1) { 1, default => 3 });', 'syntax error, unexpected token "default", expecting "=>"'],
  ['var_dump(match(1) { , });', 'syntax error, unexpected token ",", expecting "}"'],
  [String.raw`echo "\u{}";`, 'Invalid UTF-8 codepoint escape sequence'],
  [String.raw`echo b"\u{g}";`, 'Invalid UTF-8 codepoint escape sequence'],
  [String.raw`echo "\u{110000}";`, 'Invalid UTF-8 codepoint escape sequence: Codepoint too large'],
  ['class A { function f(): self&A {} }', 'Duplicate type A is redundant'],
  ['class B {} class A extends B { function f(): parent|B {} }', 'Duplicate type B is redundant'],
  ['class A { function f(): parent&B {} }', 'Cannot use "parent" when current class scope has no parent'],
  ['class A { function f(static&B $value) {} }', 'Cannot use the static modifier on a parameter'],
  ['class A { function f(object|self $value) {} }', 'Type A|object contains both object and a class type'],
])('rejects invalid PHP expression or type syntax: %s', (source, message) => {
  expect(run(`<?php echo 'never'; ${source}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining(message) }],
  });
});

test('bounds chunk_split before building an oversized result', () => {
  const execution = run('<?php echo chunk_split(str_repeat("a", 1000), 1, str_repeat("b", 1000));');
  expect(execution.kind === 'executed' && execution.stdout).toMatch(/^\nFatal error: Allowed memory size/);
});

test('folds comparisons of shared class constant arrays within the compiler budget', () => {
  const declarations = ['const A0 = [1], B0 = [1];'];
  for (let level = 1; level <= 22; level++) {
    const previous = level - 1;
    declarations.push(
      `const A${level} = [self::A${previous}, self::A${previous}];`,
      `const B${level} = [self::B${previous}, self::B${previous}];`
    );
  }
  const source = `<?php class SharedArrays { ${declarations.join(' ')} }
  var_dump((SharedArrays::A22 === SharedArrays::B22) && true);`;
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: 'bool(true)\n' });
});

test.each(['get', 'set'])('rejects overriding a final property %s hook through another subclass', (hook) => {
  const body = hook === 'get' ? 'get => 1;' : 'set => $value;';
  const program = `<?php
class ParentHook { public int $value { final ${body} } }
class MiddleHook extends ParentHook {}
class ChildHook extends MiddleHook {
  public int $value { ${body} }
}
echo 'unreachable';`;
  expect(run(program)).toMatchObject({
    kind: 'executed',
    stdout: expect.stringContaining(
      `Cannot override final property hook ParentHook::$value::${hook}() in /main.php on line 4`
    ),
  });
});

test.each([String.raw`namespace\self::K`, String.raw`namespace\parent::K`, String.raw`namespace\static::{'K'}`])(
  'rejects the relative namespace spelling for ordinary class constant fetches in %s',
  (expression) => {
    const name = expression.split('::', 1)[0];
    expect(run(`<?php\nclass C { const K=1; function fetch() { return ${expression}; } }`)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 1, message: `'${name}' is an invalid class name` }],
    });
  }
);

test.each([
  ['$GLOBALS = 1;', '${"GLO" . "BALS"} = 1;'],
  ['$ref =& $GLOBALS;', '$ref =& ${"GLOBALS"};'],
  ['unset($GLOBALS);', 'unset(${"GLOBALS"});'],
])('applies the ordinary globals write rules to a constant variable name: %s', (plain, literal) => {
  const expected = run(`<?php ${plain}`);
  expect(expected.kind).toBe('compileError');
  expect(run(`<?php ${literal}`)).toEqual(expected);
});

test.each(['(?<n>x)(?&n(1))', '(?<n>x)(?P>n(<n>))', '(x)(?R(1))'])(
  'parses a valid capture list before reporting that recursive PCRE patterns are unavailable: %s',
  (pattern) => {
    expect(run(`<?php preg_match('~${pattern}~', 'x');`)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('再帰'),
    });
  }
);

test('decodes PHP exception bytes for the user-facing error summary', () => {
  const result = run('<?php throw new RuntimeException("前に進めない！");');
  expect(result).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('RuntimeException: 前に進めない！'),
    stdout: expect.stringContaining('RuntimeException: 前に進めない！'),
  });
});

test.each([
  "1 ? 'K' : 'L'",
  "null ?? 'K'",
  '__FUNCTION__',
  String.raw`__CLASS__ === "N\\C" ? "K" : "L"`,
  String.raw`\PHP_EOL`,
  'self::S',
  'D::S',
  '["K"][0]',
  '(string)"K"',
])('checks the relative namespace spelling after folding a braced constant name: %s', (name) => {
  const program = String.raw`<?php
namespace N;
class D { const S = 'K'; }
class C { const S = 'K', K = 1; function f() { return namespace\self::{${name}}; } }
`;
  expect(run(program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: String.raw`'namespace\self' is an invalid class name` }],
  });
});
