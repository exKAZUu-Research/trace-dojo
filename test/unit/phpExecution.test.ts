import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

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
echo namespace\\readonly() ? 'ok' : 'fail';
try { readonly(); } catch (\\Error $e) { echo ';', $e->getMessage(); }`;
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: 'ok;Call to undefined function readonly()' });
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
  ['a range larger than the operations budget covers', '<?php\n$a = range(1, 20000000);', 'range'],
  ['a range of fractional steps', '<?php\n$a = range(0, 1, 1e-8);', 'range'],
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
  expect(run('<?xml version="1.0"?>\n<?php echo 1; ?><?xml?><? echo 2; ?><?php?><?phpx\n<?PHP echo 3;')).toMatchObject({
    kind: 'executed',
    stdout: '<?xml version="1.0"?>\n1<?xml?><? echo 2; ?><?php?><?phpx\n3',
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

test.each([
  ['ArrayObject', '$settings->item = 20;', 5],
  ['ArrayIterator', '$settings->item = 20;', 5],
  ['ArrayObject', "$settings->exchangeArray(['item' => 20]);", 20],
  ['ArrayIterator', "$settings->__construct(['item' => 20], ArrayIterator::ARRAY_AS_PROPS);", 20],
])('finishes %s property replacement after %s', (name, change, expected) => {
  const execution = run(`<?php
class ReplacedSetting {
    function __destruct() {
        global $settings, $releasing;
        echo 'drop;';
        if ($releasing) return;
        $releasing = true;
        ${change}
    }
}
$releasing = false;
$settings = new ${name}(['item' => new ReplacedSetting], ${name}::ARRAY_AS_PROPS);
$settings->item = 5;
echo json_encode($settings->getArrayCopy());`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: `drop;{"item":${expected}}` });
});

test.each(['ArrayObject', 'ArrayIterator'])('publishes %s property replacement before shutdown on exit', (name) => {
  const execution = run(`<?php
class RetiredSetting {
    function __destruct() { exit('exit;'); }
}
class SettingsObserver {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy());
    }
}
$settings = new ${name}(['item' => new RetiredSetting], ${name}::ARRAY_AS_PROPS);
$observer = new SettingsObserver;
$settings->item = 5;
echo 'after';`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'exit;{"item":5}' });
});

test.each([
  ['ArrayObject', '$settings->item', "echo 'second;';", 'second;'],
  ['ArrayIterator', '$settings->item', "echo 'second;';", 'second;'],
  ['ArrayObject', '$settings->item', "exit('second-exit;');", 'second-exit;'],
  ['ArrayIterator', '$settings->item', "exit('second-exit;');", 'second-exit;'],
  ['ArrayObject', "$settings['item']", "echo 'second;';", 'second;'],
  ['ArrayIterator', "$settings['item']", "exit('second-exit;');", 'second-exit;'],
])('defers a displaced %s value on %s to shutdown when its destructor will %s', (name, target, action, output) => {
  const execution = run(`<?php
class DisplacedSetting {
    function __destruct() { ${action} }
}
class RetiredSetting {
    function __destruct() {
        global $settings, $releasing;
        echo 'first;';
        if (!$releasing) {
            $releasing = true;
            ${target} = new DisplacedSetting;
        }
        exit('exit;');
    }
}
class SettingsObserver {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy());
    }
}
$releasing = false;
$settings = new ${name}(['item' => new RetiredSetting], ${name}::ARRAY_AS_PROPS);
$observer = new SettingsObserver;
${target} = 5;`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: `first;exit;{"item":5}${output}` });
});

test.each([
  ['ArrayObject', '$settings->item = 5;', '$x = new C;', 'A;exit;{"item":5};B;observer;C;'],
  ['ArrayIterator', '$settings->item = 5;', '$x = new C;', 'A;exit;{"item":5};B;observer;C;'],
  ['ArrayObject', "$settings['item'] = 5;", '$x = new C;', 'A;exit;{"item":5};B;observer;C;'],
  ['ArrayIterator', "$settings->offsetSet('item', 5);", '$x = new C;', 'A;exit;{"item":5};B;observer;C;'],
  ['ArrayObject', '$settings->item = 5;', 'unset($x);', 'A;exit;{"item":5};observer;B;'],
])('preserves displaced %s reference semantics for %s and %s during shutdown', (name, write, observe, stdout) => {
  const execution = run(`<?php
class B { function __destruct() { echo 'B;'; } }
class C { function __destruct() { echo 'C;'; } }
class A {
    function __destruct() {
        global $settings, $once, $x;
        echo 'A;';
        if (!$once) {
            $once = true;
            $x = new B;
            $settings['item'] = &$x;
        }
        exit('exit;');
    }
}
class R {
    function __destruct() {
        global $settings, $x;
        echo json_encode($settings->getArrayCopy()) . ';';
        ${observe}
        echo 'observer;';
    }
}
$once = false;
$settings = new ${name}(['item' => new A], ${name}::ARRAY_AS_PROPS);
$reader = new R;
${write}`);
  expect(execution).toMatchObject({ kind: 'executed', stdout });
});

test('keeps a displaced shared array separated during shutdown', () => {
  const execution = run(`<?php
class B { function __destruct() { echo 'B;'; } }
class A {
    function __destruct() {
        global $settings, $once, $items;
        echo 'A;';
        if (!$once) {
            $once = true;
            $items = [new B];
            $settings->item = $items;
        }
        exit('exit;');
    }
}
class R {
    function __destruct() {
        global $settings, $items;
        echo json_encode($settings->getArrayCopy()) . ';';
        $items[0] = 99;
        echo 'observer;';
    }
}
$once = false;
$settings = new ArrayObject(['item' => new A], ArrayObject::ARRAY_AS_PROPS);
$reader = new R;
$settings->item = 5;`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'A;exit;{"item":5};observer;B;' });
});

test.each([
  ['ArrayObject', "$settings['item'] = 5;", "echo 'end;';", 'new B', 'A;end;after;{"item":5};B;'],
  ['ArrayIterator', "$settings->offsetSet('item', 5);", "echo 'end;';", '[new B]', 'A;end;after;{"item":5};B;'],
  ['ArrayObject', "$settings['item'] = 5;", "throw new Exception('err');", 'new B', 'A;caught;after;{"item":5};B;'],
  ['ArrayIterator', '$settings->item = 5;', "echo 'end;';", 'new B', 'A;end;after;{"item":5};B;'],
])('defers a displaced %s value on %s after %s installs %s', (name, write, end, value, stdout) => {
  const execution = run(`<?php
class B { function __destruct() { echo 'B;'; } }
class A {
    function __destruct() {
        global $settings, $once;
        echo 'A;';
        if (!$once) {
            $once = true;
            $settings['item'] = ${value};
        }
        ${end}
    }
}
class R {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy()) . ';';
    }
}
$once = false;
$settings = new ${name}(['item' => new A], ${name}::ARRAY_AS_PROPS);
$reader = new R;
try { ${write} } catch (Throwable $e) { echo 'caught;'; }
echo 'after;';`);
  expect(execution).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  ['ArrayObject', '$settings->item = 5;', "unset($settings['item']);", "exit('exit;');", 'exit;[]'],
  ['ArrayIterator', "$settings['item'] = 5;", "unset($settings['item']);", "exit('exit;');", 'exit;[]'],
  ['ArrayObject', "$settings->offsetSet('item', 5);", "unset($settings['item']);", '', '[]'],
  [
    'ArrayIterator',
    "$settings['item'] = 5;",
    "unset($settings['item']); $settings['item'] = 7;",
    "exit('exit;');",
    'exit;{"item":5}',
  ],
])(
  'preserves deleted or recreated %s bucket state for %s when destructor runs %s (%s)',
  (name, write, action, end, stdout) => {
    const execution = run(`<?php
class A {
    function __destruct() {
        global $settings;
        ${action}
        ${end}
    }
}
class R {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy());
    }
}
$settings = new ${name}(['item' => new A], ${name}::ARRAY_AS_PROPS);
$reader = new R;
${write}`);
    expect(execution).toMatchObject({ kind: 'executed', stdout });
  }
);

test.each([
  ['ArrayObject', '$settings->item = 5;', "['item' => new A]", "'other'", "exit('exit;');", 'A;exit;{"other":5};B;'],
  [
    'ArrayIterator',
    "$settings['item'] = 5;",
    "['keep' => 1, 'item' => new A]",
    '10',
    "throw new Exception('stop');",
    'A;caught;after;{"keep":1,"10":5};B;',
  ],
  [
    'ArrayObject',
    "$settings->offsetSet('item', 5);",
    "['item' => new A]",
    "'other'",
    "exit('exit;');",
    'A;exit;{"other":5};B;',
  ],
])(
  'finishes pending %s write into reused physical bucket for %s (%s -> %s, %s)',
  (name, write, seed, key, tail, stdout) => {
    const execution = run(`<?php
class B { function __destruct() { echo 'B;'; } }
class A {
    function __destruct() {
        global $settings;
        echo 'A;';
        unset($settings['item']);
        $settings[${key}] = new B;
        ${tail}
    }
}
class R {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy()), ';';
    }
}
$settings = new ${name}(${seed}, ${name}::ARRAY_AS_PROPS);
$reader = new R;
try { ${write} } catch (Throwable $e) { echo 'caught;'; }
echo 'after;';`);
    expect(execution).toMatchObject({ kind: 'executed', stdout });
  }
);

test.each([
  ['ArrayObject', '$settings[0] = 5;', '$settings[] = new B;', "exit('exit;');", 'A;exit;[5,{}];B;'],
  [
    'ArrayIterator',
    '$settings->{0} = 5;',
    '$settings[] = new B;',
    "throw new Exception('stop');",
    'A;caught;after;[5,{}];B;',
  ],
  ['ArrayObject', '$settings->offsetSet(0, 5);', '', "exit('exit;');", 'A;exit;[];'],
  ['ArrayObject', '$settings[0] = 5;', '$settings[10] = new B;', "exit('exit;');", 'A;exit;{"10":{}};B;'],
  ['ArrayIterator', '$settings->{0} = 5;', "$settings['new'] = new B;", "exit('exit;');", 'A;exit;{"new":{}};B;'],
])(
  'handles packed hole visibility and packed-to-mixed conversion on %s (%s, %s, %s)',
  (name, write, action, tail, stdout) => {
    const execution = run(`<?php
class B { function __destruct() { echo 'B;'; } }
class A {
    function __destruct() {
        global $settings;
        echo 'A;';
        unset($settings[0]);
        ${action}
        ${tail}
    }
}
class R {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy()), ';';
    }
}
$settings = new ${name}([new A], ${name}::ARRAY_AS_PROPS);
$reader = new R;
try { ${write} } catch (Throwable $e) { echo 'caught;'; }
echo 'after;';`);
    expect(execution).toMatchObject({ kind: 'executed', stdout });
  }
);

test.each([
  ['ArrayObject', '$settings[0] = 9;', '$settings[1] = 5;', '', "exit('exit;');", 'A;B;exit;[9,5,{}];C;'],
  [
    'ArrayIterator',
    '$settings->{0} = 9;',
    '$settings->offsetSet(1, 5);',
    '',
    "throw new Exception('stop');",
    'A;B;caught;after;[9,5,{}];C;',
  ],
  [
    'ArrayObject',
    '$settings[0] = 9;',
    '$settings[1] = 5;',
    'unset($settings[0]);',
    "exit('exit;');",
    'A;B;exit;[9,5,{}];C;',
  ],
])(
  'keeps outer packed writes valid when inner destructor fills a packed hole on %s (%s, %s, %s, %s)',
  (name, write, inner, extraUnset, tail, stdout) => {
    const execution = run(`<?php
class C { function __destruct() { echo 'C;'; } }
class B {
    function __destruct() {
        global $settings;
        echo 'B;';
        ${extraUnset}
        unset($settings[1]);
        $settings[] = new C;
        ${tail}
    }
}
class A {
    function __destruct() {
        global $settings;
        echo 'A;';
        ${inner}
    }
}
class R {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy()), ';';
    }
}
$settings = new ${name}([new A, new B], ${name}::ARRAY_AS_PROPS);
$reader = new R;
try { ${write} } catch (Throwable $e) { echo 'caught;'; }
echo 'after;';`);
    expect(execution).toMatchObject({ kind: 'executed', stdout });
  }
);

test.each([
  [
    'ArrayObject',
    "$settings['k0'] = 5;",
    "$settings['new'] = 99;",
    "exit('exit;');",
    'A;exit;{"k0":5,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"new":99}',
  ],
  [
    'ArrayIterator',
    '$settings->k0 = 5;',
    '$settings[] = 99;',
    "throw new Exception('stop');",
    'A;caught;after;{"k0":5,"k3":3,"k4":4,"k5":5,"k6":6,"k7":7,"0":99}',
  ],
])('keeps fetched %s writes valid across in-place compaction (%s, %s, %s)', (name, write, add, tail, stdout) => {
  const execution = run(`<?php
class A {
    function __destruct() {
        global $settings;
        echo 'A;';
        unset($settings['k1'], $settings['k2']);
        ${add}
        ${tail}
    }
}
class R {
    function __destruct() {
        global $settings;
        echo json_encode($settings->getArrayCopy());
    }
}
$settings = new ${name}(['k0' => new A, 'k1' => 1, 'k2' => 2, 'k3' => 3, 'k4' => 4, 'k5' => 5, 'k6' => 6, 'k7' => 7], ${name}::ARRAY_AS_PROPS);
$reader = new R;
try { ${write} } catch (Throwable $e) { echo 'caught;'; }
echo 'after;';`);
  expect(execution).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  ['ArrayObject', 'new stdClass', 10_000],
  ['ArrayIterator', 'new stdClass', 10_000],
  ['ArrayObject', 'new D', 5000],
])('replaces %s objects in linear time (%s x %i)', (type, ctor, count) => {
  vi.restoreAllMocks();
  const execution = run(`<?php
class D { function __destruct() {} }
$a = new ${type};
for ($i = 0; $i < ${count}; $i++) $a[$i] = ${ctor};
for ($i = 0; $i < ${count}; $i++) $a[$i] = 0;
echo 'done';`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'done' });
});

test.each([
  ['ArrayIterator', 'new ArrayIterator([])'],
  ['SplFixedArray', 'new SplFixedArray(1)'],
  ['Closure', 'function () {}'],
])('releases temporary objects without scanning 15000 live %s instances', (_name, ctor) => {
  vi.restoreAllMocks();
  const execution = run(`<?php
$items = [];
for ($i = 0; $i < 15000; $i++) $items[] = ${ctor};
for ($i = 0; $i < 15000; $i++) { $tmp = new stdClass; unset($tmp); }
echo 'done';`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'done' });
});

test('tracks objects held by lazily initialized closure static variables', () => {
  const execution = run(`<?php
class Box { function __destruct() { echo 'D;'; } }
$f = function () { static $b; $b = new Box; };
$f();
echo 'alive;';
$f = null;
echo 'after;';`);
  expect(execution).toMatchObject({ kind: 'executed', stdout: 'alive;D;after;' });
});

test.each([
  ["preg_match_all('/(a?)+/', str_repeat('a ', 50000))", '100001'],
  ["strlen(preg_replace('/(a?)+/', 'x', str_repeat('a ', 50000)))", '150001'],
  ["strlen(preg_replace_callback('/(a?)+/', fn($m) => 'x', str_repeat('a ', 20000)))", '60001'],
  ["count(preg_split('/(a?)+/', str_repeat('a ', 30000), 30001, PREG_SPLIT_NO_EMPTY))", '30000'],
  ["preg_match_all('/(あ?)+/u', str_repeat('あ ', 10000))", '20001'],
])('completes bounded native regex scan within time budget: %s', (expression, stdout) => {
  vi.restoreAllMocks();
  const execution = run(`<?php echo ${expression};`);
  expect(execution).toMatchObject({ kind: 'executed', stdout });
});

test.each([
  [
    'callback exit',
    "preg_replace_callback('/(a+)+b|c/', function($m) use (&$i) { if (++$i === 578) exit('done;'); return 'x'; }, $s);",
    'done;',
  ],
  ['replacement limit', "echo strlen(preg_replace('/(a+)+b|c/', 'x', $s, 578));", '38578'],
  ['split limit', "echo count(preg_split('/(a+)+b|c/', $s, 579));", '579'],
])('does not speculatively match past early stop in %s', (_label, action, stdout) => {
  vi.restoreAllMocks();
  const execution = run(`<?php
$s = str_repeat('c', 578) . str_repeat(str_repeat('a', 18) . 'c', 2000);
$i = 0;
${action}`);
  expect(execution).toMatchObject({ kind: 'executed', stdout });
});

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

test.each([
  '<?php file_put_contents("a.txt","x",FILE_APPEND|LOCK_EX);',
  '<?php mb_strlen("abc","sjis");',
  '<?php echo defined("PHP_OS") ? "y" : "n";',
  '<?php echo defined("SEEK_SET") ? "y" : "n";',
  '<?php echo constant("PHP_OS");',
  '<?php echo defined("DateTimeInterface::ATOM") ? "y" : "n";',
  '<?php var_dump(method_exists("DateTime", "format"));',
  '<?php echo constant("DateTime::ATOM");',
  '<?php var_dump(is_subclass_of("DateTime", "DateTimeInterface"));',
  '<?php var_dump(interface_exists("DateTimeInterface"));',
  '<?php var_dump(class_exists("Attribute"));',
])('unsupported arguments produce the unsupported-feature message: %s', (source) => {
  expect(run(source)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません。'),
  });
});

const uncaughtReleaseProgram = (handler: string): string =>
  `<?php class D { function __construct(public $id) {} function __destruct() { echo "d{$this->id};"; } } function f($p) { throw new Exception("x"); } $x = new D(14); ${handler} f(new D(1));`;

test('releases an uncaught exception after reporting or handling it, before shutdown', () => {
  expect(run(uncaughtReleaseProgram(''))).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(/thrown in \/main\.php on line 1\nd1;d14;$/),
  });
  expect(run(uncaughtReleaseProgram('set_exception_handler(function ($e) { echo "handler;"; });'))).toMatchObject({
    kind: 'executed',
    stdout: 'handler;d1;d14;',
  });
  expect(
    run(uncaughtReleaseProgram('set_exception_handler(function ($e) { echo "handler;"; throw new Exception("y"); });'))
  ).toMatchObject({ kind: 'executed', stdout: expect.stringMatching(/d14;d1;$/) });
  expect(
    run(
      '<?php class D { function __construct(public $id, public $throws = false) {} function __destruct() { echo "d{$this->id};"; if ($this->throws) throw new Exception("t"); } } function f($o) { throw new Exception("x"); } set_exception_handler(function ($e) { echo "H;"; }); $x = new D(14); f(new D(1, true));'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(
      /^H;d1;\nFatal error: Uncaught Exception: t in .*\[internal function\]: D->__destruct\(\).*d14;$/s
    ),
  });
  expect(
    run(
      '<?php class D { function __construct(public $id, public $throws = false) {} function __destruct() { echo "d{$this->id};"; if ($this->throws) throw new Exception("t{$this->id}"); } } function f($o) { throw new Exception("x"); } $x = new D(14); f([new D(1, true), new D(2, true)]);'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(
      /d1;\nFatal error: Uncaught Exception: t1 .*d14;d2;\nFatal error: Uncaught Exception: t2 /s
    ),
  });
  expect(
    run(
      '<?php class D { function __construct(public $id) {} function __destruct() { echo "d{$this->id};"; } } function k($a) { throw new Exception("k"); } set_exception_handler(function ($e) { echo "H;"; k(new D(6)); }); $x = new D(14); throw new Exception("first");'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(/^H;\nFatal error: Uncaught Exception: k .*\nd6;d14;$/s),
  });
  expect(
    run(
      '<?php class D { function __destruct() { echo "d;"; exit("bye;"); } } class T { function __destruct() { echo "T;"; throw new Exception("shut"); } } function f($o) { throw new Exception("x"); } set_exception_handler(function ($e) { echo "H;"; }); $t = new T; f(new D);'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(/^H;d;bye;T;\nFatal error: Uncaught Exception: shut /),
  });
});

test.each([
  ['new D(2);', /^outer;inner;d2;d1;d14;$/],
  [
    'set_exception_handler(function ($e) { echo "last;"; }); function g($p) { throw new Exception("z"); } g(new D(2));',
    /^outer;inner;last;d2;d1;d14;$/,
  ],
  ['exit("bye;");', /^outer;inner;bye;d14;d1;$/],
  ['throw new Exception("z");', /^outer;inner;\nFatal error: Uncaught Exception: z .*d14;d1;$/s],
])('releases a handled exception after a replacement handler finishes: %s', (body, stdout) => {
  const handler = `set_exception_handler(function ($e) {
    echo "outer;";
    set_exception_handler(function ($e) { echo "inner;"; ${body} });
    throw new Exception("y");
  });`;
  expect(run(uncaughtReleaseProgram(handler))).toMatchObject({
    kind: 'executed',
    stdout: expect.stringMatching(stdout),
  });
});

test('a first-class callable of a closure is the closure itself', () => {
  expect(
    run(
      '<?php class H { function m() {} } function uf() {} $c = fn() => 1; $f = uf(...); $m = (new H)->m(...); var_dump($c(...) === $c, $f(...) === $f, $m(...) === $m); echo spl_object_id(new stdClass);'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'bool(true)\nbool(true)\nbool(true)\n5' });
});

test('unhandled match cases escape strings and name types as PHP does', () => {
  expect(
    run(String.raw`<?php
foreach (["こ", "it's", "a\x01b\\", "\f\v\e\x7F", "abcdefghijklmnopq", STDERR] as $v) {
  try { echo match($v) { 'z' => 1 }; } catch (UnhandledMatchError $e) { echo $e->getMessage(), "\n"; }
}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`Unhandled match case '\xE3\x81\x93'
Unhandled match case 'it's'
Unhandled match case 'a\x01b\\'
Unhandled match case '\f\v\e\x7F'
Unhandled match case 'abcdefghijklmno...'
Unhandled match case of type resource
`,
  });
});

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
  [String.raw`/(\w+\s*)+/`, 'this is a typical sentence', 1],
  [String.raw`/(\d+)+/`, '12345678901234567', 1],
  [String.raw`/^(?:(?:north|northbound)\s*)+$/`, 'northbound northbound north', 1],
  [String.raw`/^(?:\p{L}+\s*)+$/u`, 'este es un café típico', 1],
  [String.raw`/^(?:hello\s*|hello world\s*)+$/`, 'hello world hello world hello', 1],
  [String.raw`/(\d+)+/`, 'this subject contains no numbers', 0],
  [String.raw`/\[(\d+)+\]/`, 'serial [12345678901234567] ready', 1],
])('matches ordinary subjects with possible repetition overlap: %s', (pattern, subject, count) => {
  const expression = JSON.stringify(pattern);
  expect(run(`<?php var_dump(preg_match(${expression}, ${JSON.stringify(subject)}));`)).toMatchObject({
    kind: 'executed',
    stdout: `int(${count})\n`,
  });
});

test('preserves captures from repeated patterns used in multiple matches', () => {
  expect(
    run(String.raw`<?php
preg_match_all('/\[(\d+)+\]/', 'serial [12345678901234567] and [900]', $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE);
echo json_encode($matches);
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '[[["[12345678901234567]",7],["12345678901234567",8]],[["[900]",31],["900",32]]]',
  });
});

test('reports a regex deadline and runs the next program', () => {
  vi.spyOn(Atomics, 'wait').mockReturnValueOnce('timed-out');
  const source = String.raw`<?php echo preg_match('/(\w+\s*)+/', 'this is a typical sentence');`;
  expect(run(source)).toEqual({ kind: 'limitExceeded', limit: 'time' });
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: '1' });
});

test('reports exhausted PCRE match limits independently of the execution deadline', () => {
  expect(
    run(`<?php
$pattern = '/(*LIMIT_MATCH=0)(cat|dog)/';
$subject = 'a cat and a dog';
var_dump(preg_match($pattern, $subject), preg_last_error(), preg_last_error_msg());
var_dump(preg_match_all($pattern, $subject), preg_last_error());
var_dump(preg_replace($pattern, 'pet', $subject, -1, $count), $count, preg_last_error());
var_dump(preg_split($pattern, $subject), preg_last_error());
var_dump(preg_match('/cat/', 'cat'), preg_last_error());
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'bool(false)\nint(2)\nstring(25) "Backtrack limit exhausted"\nbool(false)\nint(2)\nNULL\nint(0)\nint(2)\nbool(false)\nint(2)\nint(1)\nint(0)\n',
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

test.each([
  ['/(?<=(a{1,3})(a{1,3}))b/', 'aaaab', '["b","aaa","a"]'],
  ['/(?<=a{1,3}(a{1,3}))b/', 'aaaab', '["b","a"]'],
  ['/(?<=(a)|bc)d/', 'ad', '["d","a"]'],
])('preserves PHP capture order for variable-length and uneven lookbehinds: %s', (pattern, subject, stdout) => {
  expect(run(`<?php preg_match('${pattern}','${subject}',$m);echo json_encode($m);`)).toMatchObject({
    kind: 'executed',
    stdout,
  });
});

test.each([
  [String.raw`preg_match('/(?<=(a)\1)b/', 'aab', $m); echo json_encode($m);`, '["b","a"]'],
  [String.raw`echo preg_match('/(?<!(a)\1)b/', 'aab');`, '0'],
  [String.raw`echo preg_replace('/(?<=(.)\1)x/', 'Y', 'aax bcx');`, 'aaY bcx'],
  [String.raw`preg_match_all('/(?<=(\d)\1)-/', '11-23-', $m); echo json_encode($m);`, '[["-"],["1"]]'],
  [String.raw`preg_match('/(?<=(?<x>a)\k<x>)b/', 'aab', $m); echo json_encode($m);`, '{"0":"b","x":"a","1":"a"}'],
])('matches backreferences within lookbehinds via native PCRE: %s', (call, stdout) => {
  expect(run(`<?php ${call}`)).toMatchObject({
    kind: 'executed',
    stdout,
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
  ['public static int $x', 'protected readonly int $x', 'Cannot redeclare static A::$x as non static B::$x'],
  ['public readonly int $x', 'protected int $x', 'Cannot redeclare readonly property A::$x as non-readonly B::$x'],
  ['public int $x', 'protected readonly int $x', 'Cannot redeclare non-readonly property A::$x as readonly B::$x'],
  ['public int $x', 'protected private(set) int $x', 'Set access level of B::$x must be omitted (as in class A)'],
  ['protected int $x', 'public private(set) int $x', 'Set access level of B::$x must be omitted (as in class A)'],
  ['public readonly int $x', 'private readonly int $x', 'Access level to B::$x must be public (as in class A)'],
])('reports the first incompatible inherited property modifier: %s to %s', (parent, child, message) => {
  expect(run(`<?php\nclass A { ${parent}; }\nclass B extends A { ${child}; }\necho "unreachable";`)).toMatchObject({
    kind: 'executed',
    stdout: `\nFatal error: ${message} in /main.php on line 3\nStack trace:\n#0 {main}\n`,
  });
});

test.each([
  ['abstract class A { public abstract int $x { get; } }', 'public readonly int $x'],
  ['class A { public int $x { get => 1; } }', 'public protected(set) int $x'],
])('allows a storage property to satisfy the inherited get-only property: %s', (parent, child) => {
  expect(run(`<?php ${parent} class B extends A { ${child}; } echo "accepted";`)).toMatchObject({
    kind: 'executed',
    stdout: 'accepted',
  });
});

test.each([
  ['public private(set) int', 'public int', '2'],
  ['public int', 'public private(set) int', 'blocked;1'],
  ['public private(set) int', 'public protected(set) int', 'blocked;1'],
  ['final public int', 'public int', '2'],
  ['public int', 'final public int', '2'],
])(
  'keeps the class setter and finality when composing a compatible trait property: %s and %s',
  (trait, own, stdout) => {
    expect(
      run(`<?php
trait T { ${trait} $x = 1; }
class C { use T; ${own} $x = 1; }
$object = new C;
try { $object->x = 2; } catch (Error) { echo "blocked;"; }
echo $object->x;`)
    ).toMatchObject({ kind: 'executed', stdout });
  }
);

test('retains the class property finality after composing a compatible trait property', () => {
  expect(
    run(
      '<?php trait T { public int $x = 1; } class C { use T; final public int $x = 1; } class D extends C { public int $x = 2; }'
    )
  ).toMatchObject({ kind: 'executed', stdout: expect.stringContaining('Cannot override final property C::$x') });
});

test.each([
  ['class A { private private(set) int $x = 1; }', 'ok'],
  ['class A { public function __construct(private private(set) int $x = 1) {} }', 'ok'],
  ['class A { public function __construct(final private int $x = 1) {} }', 'Cannot override final property A::$x'],
  ['class A { protected private(set) int $x = 1; }', 'Cannot override final property A::$x'],
])('derives property finality from actual asymmetric visibility: %s', (parent, expected) => {
  const result = run(`<?php ${parent} class B extends A { public int $x = 2; } echo "ok";`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: expected === 'ok' ? expected : expect.stringContaining(expected),
  });
});

test.each([
  ['class A', 'public int $x { get; }', 'Non-abstract property hook must have a body'],
  ['abstract class A', 'public int $x { set; }', 'Non-abstract property hook must have a body'],
  ['trait T', 'public int $x { get => 1; set; }', 'Non-abstract property hook must have a body'],
  ['interface I', 'public int $x { get => 1; }', 'Abstract property hook cannot have body'],
  ['interface I', 'public int $x { get; set => $value; }', 'Abstract property hook cannot have body'],
  ['abstract class A', 'abstract public int $x { final get; }', 'Property hook cannot be both abstract and final'],
  ['abstract class A', 'abstract private int $x { get; }', 'Property hook cannot be both abstract and private'],
  ['class A', 'private int $x { final get => 1; }', 'Property hook cannot be both final and private'],
])('validates hook bodies against their property declaration: %s with %s', (owner, property, message) => {
  expect(run(`<?php\n${owner} {\n  ${property}\n}\necho "unreachable";`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message }],
  });
});

test.each([
  ['public int $x { set => $value * 2; }', 'echo (new A(2))->x;', '4'],
  ['public int $x = 2 { set => $value * 2; }', 'echo (new A)->x;', '4'],
  ['int $x = 3 { set => $value * 2; }', 'echo (new A)->x;', '6'],
  ['public int $x { get => $this->x + 1; }', 'echo (new A(2))->x;', '3'],
  [
    'public int $x { get => 1; set => throw new Exception("setter"); }',
    'try { new A(1); } catch (Exception $e) { echo $e->getMessage(); }',
    'setter',
  ],
  [
    'public int $x { get => 1; }',
    'try { new A(1); } catch (Error $e) { echo $e->getMessage(); }',
    'Property A::$x is read-only',
  ],
])('executes hooks on promoted constructor parameters: %s', (param, source, stdout) => {
  expect(run(`<?php class A { public function __construct(${param}) {} } ${source}`)).toMatchObject({
    kind: 'executed',
    stdout,
  });
});

test.each([
  ['public int $x { get; }', 'Non-abstract property hook must have a body'],
  ['public int $x { get => 1; set; }', 'Non-abstract property hook must have a body'],
  ['private int $x { final get => 1; }', 'Property hook cannot be both final and private'],
  [
    'public private(set) int $x { get => 1; }',
    'Read-only virtual property A::$x must not specify asymmetric visibility',
  ],
  ['public readonly int $x { get => 1; }', 'Hooked properties cannot be readonly'],
])('validates hooks on promoted constructor parameters: %s', (param, message) => {
  expect(run(`<?php\nclass A { public function __construct(${param}) {} }\necho "unreachable";`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message }],
  });
});

test('names the declaring class for an inherited property that violates an interface contract', () => {
  expect(
    run(`<?php
interface I { public int $x { get; } }
class P { public string $x = ""; }
class C extends P implements I {}`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Type of P::$x must be subtype of int (as in class I) in /main.php on line 4\nStack trace:\n#0 {main}\n',
  });
});

test('allows a concrete hook on an abstract property with another abstract hook', () => {
  expect(run('<?php abstract class A { abstract public int $x { get => 1; set; } } echo "accepted";')).toMatchObject({
    kind: 'executed',
    stdout: 'accepted',
  });
});

test.each([
  ['get => 1;', 'Read-only'],
  ['set { echo $value; }', 'Write-only'],
])('rejects asymmetric visibility on a single virtual hook: %s', (hook, mode) => {
  expect(run(`<?php\necho "unreachable";\nclass A { public private(set) int $x { ${hook} } }`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: `${mode} virtual property A::$x must not specify asymmetric visibility` }],
  });
});

test.each([
  'class A { public public(set) int $x { get => 1; } }',
  'class A { public private(set) int $x { get => $this->x; } }',
  'class A { public private(set) int $x { get => 1; set { echo $value; } } }',
  'class Base { protected int $x = 1; } class A extends Base { public protected(set) int $x { get => 1; } }',
  'class Base { public protected(set) int $x { get => 1; set { echo $value; } } } class A extends Base { public protected(set) int $x { get => 1; } }',
  'trait T { private private(set) int $x; } class A { use T; private int $x; }',
])('accepts backed properties and effective hook visibility: %s', (source) => {
  expect(run(`<?php ${source} echo "accepted";`)).toMatchObject({ kind: 'executed', stdout: 'accepted' });
});

test('checks single-hook visibility after inherited hooks are linked', () => {
  expect(
    run('<?php\nclass Base {}\nclass A extends Base { public protected(set) int $x { get => 1; } }')
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Read-only virtual property A::$x must not specify asymmetric visibility in /main.php on line 3\nStack trace:\n#0 {main}\n',
  });
});

test.each([
  ['get; set;', 'protected private(set) int $p', 'Set access level of B::$p must be omitted (as in class A)'],
  ['set;', 'protected private(set) string $p', 'Set access level of B::$p must be omitted (as in class A)'],
  ['get; set;', 'protected private(set) readonly int $p', 'Set access level of B::$p must be omitted (as in class A)'],
  ['get;', 'protected private(set) int $p', 'Access level to B::$p must be public (as in class A)'],
])('reports property modifier precedence for interface hooks %s', (hooks, property, message) => {
  expect(
    run(`<?php\ninterface A { public int $p { ${hooks} } }\nclass B implements A { ${property}; }\necho "unreachable";`)
  ).toMatchObject({
    kind: 'executed',
    stdout: `\nFatal error: ${message} in /main.php on line 3\nStack trace:\n#0 {main}\n`,
  });
});

test.each([
  [
    'get;',
    'string $x { get => "a"; }',
    'Declaration of C::$x::get(): string must be compatible with I::$x::get(): int',
  ],
  [
    'set;',
    'string $x { set { echo $value; } }',
    'Declaration of C::$x::set(string $value): void must be compatible with I::$x::set(int $value): void',
  ],
  [
    'get; set;',
    '?int $x { get => 1; set { echo $value; } }',
    'Declaration of C::$x::get(): ?int must be compatible with I::$x::get(): int',
  ],
  ['get;', 'string $x;', 'Type of C::$x must be subtype of int (as in class I)'],
])('checks interface hook signatures before the property type: %s', (hooks, property, message) => {
  expect(
    run(`<?php\ninterface I { public int $x { ${hooks} } } class C implements I { public ${property} }`)
  ).toMatchObject({
    kind: 'executed',
    stdout: `\nFatal error: ${message} in /main.php on line 2\nStack trace:\n#0 {main}\n`,
  });
});

test.each([
  [
    'int $x { get; }',
    'string $x { get; }',
    'interface K extends I, J {}',
    'Declaration of I::$x::get(): int must be compatible with J::$x::get(): string',
  ],
  [
    'int $x { get; }',
    'int|string $x { get; }',
    'class C implements I, J {}',
    'Class C contains 1 abstract method and must therefore be declared abstract or implement the remaining method (I::$x::get)',
  ],
  [
    'int $x { get; }',
    'int $x { set; }',
    'interface K extends I, J {} class C implements K { public int $x { get => 1; } }',
    'Class C contains 1 abstract method and must therefore be declared abstract or implement the remaining method (J::$x::set)',
  ],
])('binds inherited interface property hooks for %s and %s', (first, second, declaration, message) => {
  const source = `<?php\ninterface I { public ${first} }\ninterface J { public ${second} }\n${declaration}`;
  expect(run(source)).toMatchObject({
    kind: 'executed',
    stdout: `\nFatal error: ${message} in /main.php on line 4\nStack trace:\n#0 {main}\n`,
  });
});

test('allows one property to satisfy independent interface getter types', () => {
  expect(
    run(`<?php
      interface X {}
      interface Y {}
      class XY implements X, Y {}
      interface I { public X $x { get; } }
      interface J { public Y $x { get; } }
      class C implements I, J { public XY $x; }
      echo 'ok';`)
  ).toMatchObject({ kind: 'executed', stdout: 'ok' });
});

test.each([
  [
    'public function m() {}',
    'abstract protected function M(int $x);',
    'Cannot make non abstract method A::M() abstract in class B',
  ],
  [
    'public static function m() {}',
    'abstract protected function m();',
    'Cannot make static method A::m() non static in class B',
  ],
  [
    'public function __construct() {}',
    'abstract public function __construct();',
    'Cannot make non abstract method A::__construct() abstract in class B',
  ],
])('checks inherited methods before abstract redeclarations can take effect: %s', (parent, child, message) => {
  expect(
    run(`<?php\nclass A { ${parent} }\nabstract class B extends A { ${child} }\necho "unreachable";`)
  ).toMatchObject({
    kind: 'executed',
    stdout: `\nFatal error: ${message} in /main.php on line 3\nStack trace:\n#0 {main}\n`,
  });
});

test('an abstract method can reuse the name of a private inherited method', () => {
  expect(
    run(`<?php
class A { private function m() {} }
abstract class B extends A { abstract public function m(); }
class C extends B { public function m() { return 2; } }
echo (new C)->m();`)
  ).toMatchObject({ kind: 'executed', stdout: '2' });
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

test('orders binary operand diagnostics by the compiled call result', () => {
  const source = String.raw`<?php
namespace Example;
$text = 'x';
foreach ([
  fn() => ($text . 'x') * \max(2, 3),
  fn() => ($text . 'x') * max(2, 3),
  fn() => ($text . 'x') * ('m' . 'ax')(2, 3),
  fn() => ($text . 'x') * \strlen(...),
  fn() => (array) false & \strlen('a'),
  fn() => (array) false & \count([1]),
  fn() => (array) false & \count(value: [1]),
  fn() => (array) false & \abs(3),
  fn() => (array) false & \call_user_func('abs', 3),
  fn() => 'abc' * \strlen('a' . 'b'),
  fn() => 'abc' * \defined('PHP_VERSION_ID'),
] as $example) {
  try { $example(); } catch (\TypeError $error) { echo $error->getMessage(), "\n"; }
}`;
  expect(run(source)).toMatchObject({
    kind: 'executed',
    stdout:
      'Unsupported operand types: string * int\n' +
      'Unsupported operand types: int * string\n' +
      'Unsupported operand types: string * int\n' +
      'Unsupported operand types: string * Closure\n' +
      'Unsupported operand types: array & int\n'.repeat(2) +
      'Unsupported operand types: int & array\n'.repeat(3) +
      'Unsupported operand types: string * int\n' +
      'Unsupported operand types: string * bool\n',
  });
});

test('uses compiled operand rows for expression diagnostics', () => {
  const source = `<?php
set_error_handler(function ($level, $message, $file, $line) { echo $message, ':', $line, "\\n"; });
try { count(
  $missing
); } catch (Throwable $error) { echo $error->getLine(), "\\n"; }
try { call_user_func(
  $callback,
  $skipped
); } catch (Throwable $error) { echo $error->getLine(), "\\n"; }
try { call_user_func(
  'intdiv',
  1,
  0
); } catch (Throwable $error) { echo $error->getLine(), "\\n"; }
try { intdiv(
  1,
  0
); } catch (Throwable $error) { echo $error->getLine(), "\\n"; }
sprintf('%s-%s',
  $first,
  $second
);
function receive(...$args) {}
try { receive(
  ...$unpack
); } catch (Throwable $error) { echo $error->getLine(), "\\n"; }
$object = new stdClass;
try { [$object,
  'missing']();
} catch (Throwable $error) { echo $error->getLine(), "\\n"; }
try { throw
  $thrown;
} catch (Throwable $error) { echo $error->getLine(), "\\n"; }`;
  expect(run(source)).toMatchObject({
    kind: 'executed',
    stdout:
      'Undefined variable $missing:4\n4\nUndefined variable $callback:7\n7\n13\n15\n' +
      'Undefined variable $first:21\nUndefined variable $second:21\n' +
      'Undefined variable $unpack:25\n25\n29\nUndefined variable $thrown:32\n32\n',
  });
});

test.each([
  ['zero(\n  b: 5,\n  a: 5\n)', '6'],
  ['[\n  1,\n  2\n]', '5'],
  ['[\n  $value,\n  2\n]', '6'],
  ['Example::\n  VALUE', '4'],
  ['match ($value) {\n  default => 0,\n  1 => 4\n}', '6'],
])('reports an enclosing binary error at the compiled operand line for %s', (operand, stdout) => {
  expect(
    run(`<?php
function zero($a, $b) { return $a - $b; } class Example { const VALUE = 0; }
$value = 5;
try { 5 % ${operand}; } catch (Throwable $error) { echo $error->getLine(); }`)
  ).toMatchObject({ kind: 'executed', stdout });
});

test('uses the same compiled line for both warnings from a binary operator', () => {
  expect(
    run(`<?php
function value($number) { return $number; }
set_error_handler(function ($level, $message, $file, $line) { echo $message, ':', $line, "\\n"; });
echo $missing + value(
  '12x'
);`)
  ).toMatchObject({ kind: 'executed', stdout: 'Undefined variable $missing:5\nA non-numeric value encountered:5\n12' });
});

test('casts constant concatenation operands after calls and before deferred reads', () => {
  expect(
    run(`<?php
set_error_handler(function ($level, $message) { echo $message, ';'; });
function operand() { echo 'call;'; return 'ok'; }
echo $missing . [] . ';';
echo [1, 2] . $alsoMissing . ';';
echo [] . operand() . ';';
try {
  set_error_handler(function ($level, $message) { throw new Exception($message); });
  $result = $neverRead . [];
} catch (Throwable $error) { echo $error->getMessage(); }`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'Array to string conversion;Undefined variable $missing;Array;' +
      'Array to string conversion;Undefined variable $alsoMissing;Array;' +
      'call;Array to string conversion;Arrayok;Array to string conversion',
  });
});

test('rounds integer operands before computing an overflowing result', () => {
  const source = `<?php
    class NumberBox { public static float $product = 9007199254740993 * 9007199254740993; }
    $a = 2842708560640077593;
    $b = 8063126569282620044;
    $a += $b;
    $n = 9007199254740993;
    var_dump($a, -2842708560640077593 - $b, $n * $n, array_product([$n, $n]), NumberBox::$product, $n + 1);
  `;
  expect(run(source)).toMatchObject({
    kind: 'executed',
    stdout:
      'float(1.09058351299227E+19)\nfloat(-1.09058351299227E+19)\nfloat(8.112963841460668E+31)\n' +
      'float(8.112963841460668E+31)\nfloat(8.112963841460668E+31)\nint(9007199254740994)\n',
  });
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

test('a RegexIterator constructor propagates the execution deadline', () => {
  vi.spyOn(performance, 'now').mockReturnValue(3000).mockReturnValueOnce(0);
  const program =
    '<?php try { new RegexIterator(new ArrayIterator([]), "/abcdef/"); } catch (Throwable $e) { echo "caught"; }';
  expect(run(program)).toEqual({ kind: 'limitExceeded', limit: 'time' });
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

test('preserves array elements created or shared by undefined-key handlers during updates', () => {
  const result = run(String.raw`<?php
foreach (['post++', 'pre++', 'post--', 'pre--', '+=1'] as $op) {
  $a = [];
  set_error_handler(function () use (&$a) { $a['x'] = 5; return true; });
  $r = match ($op) {
    'post++' => $a['x']++,
    'pre++' => ++$a['x'],
    'post--' => $a['x']--,
    'pre--' => --$a['x'],
    '+=1' => $a['x'] += 1,
  };
  restore_error_handler();
  echo "$op:" . json_encode([$r, $a]) . "\n";
}
$a = ['init' => 1];
$b = null;
set_error_handler(function () use (&$a, &$b) { $b = $a; return true; });
$r1 = $a['x']++;
restore_error_handler();
echo 'share:' . json_encode([$r1, $a, $b]) . "\n";

$a = [];
$n = 0;
set_error_handler(function () use (&$a, &$n) { if (++$n === 1) $a['x'] = ['y' => 5]; return true; });
$r2 = $a['x']['y'] += 1;
restore_error_handler();
echo 'nested:' . json_encode([$n, $r2, $a]) . "\n";

$o = new stdClass();
set_error_handler(function () use ($o) { $o->p = 5; return true; });
$r3 = $o->p++;
restore_error_handler();
echo 'prop:' . json_encode([$r3, $o->p]) . "\n";

$ao = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
set_error_handler(function () use ($ao) { $ao['p'] = 5; return true; });
$r4 = $ao->p += 1;
restore_error_handler();
echo 'ao:' . json_encode([$r4, $ao->getArrayCopy()]) . "\n";

$ai = new ArrayIterator([]);
set_error_handler(function () use ($ai) { $ai['x'] = 5; return true; });
$r5 = $ai['x']++;
restore_error_handler();
echo 'ai:' . json_encode([$r5, $ai['x']]) . "\n";

set_error_handler(function () { $GLOBALS['missingForeach'] = [1, 2]; return true; });
foreach ($missingForeach as &$fv) { echo 'visited;'; }
restore_error_handler();
echo 'foreach:' . (isset($fv) ? 'bound' : 'unbound') . ':' . count($missingForeach) . "\n";

function takeRef(&$x) {}
set_error_handler(function () { echo 'warn;'; $GLOBALS['missingUnpack'] = [1]; return true; });
try { takeRef(...$missingUnpack); } catch (TypeError $e) { echo $e->getMessage() . ';'; }
restore_error_handler();
echo 'unpack:' . (isset($missingUnpack) ? 'set' : 'unset') . "\n";

set_error_handler(function () { throw new Exception('handler'); });
try { takeRef(...$missingUnpack2); } catch (TypeError $e) { echo 'unpackThrow:' . $e->getMessage() . '|' . $e->getPrevious()?->getMessage() . "\n"; }
restore_error_handler();

$p1 = new stdClass();
set_error_handler(function () use ($p1) { $p1->x = 5; throw new Exception('stop'); });
try { $p1->x += 2; } catch (Exception $e) {}
restore_error_handler();
echo 'propThrow:' . json_encode($p1) . "\n";

$ao2 = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
set_error_handler(function () { throw new Exception('stop'); });
try { $ao2->x--; } catch (Exception $e) {}
try { $ao2->y++; } catch (Exception $e) {}
restore_error_handler();
echo 'aoThrow:' . json_encode($ao2->getArrayCopy()) . "\n";

$ao3 = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
$ext = 5;
set_error_handler(function () use ($ao3, &$ext) { $ao3['x'] = &$ext; return true; });
$ao3['x']++;
$ao4 = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
set_error_handler(function () use ($ao4, &$ext) { $ao4['y'] = &$ext; return true; });
$ao4->y += 2;
restore_error_handler();
echo 'aoRef:' . json_encode([$ext, $ao3['x'], $ao4['y']]) . "\n";

$p2 = new stdClass();
set_error_handler(function () use ($p2) { unset($p2->x); throw new Exception('stop'); });
try { $p2->x--; } catch (Exception $e) {}
restore_error_handler();
class UnsetPropDecl { public $x; }
$p3 = new UnsetPropDecl();
unset($p3->x);
set_error_handler(function () use ($p3) { unset($p3->x); throw new Exception('stop'); });
try { --$p3->x; } catch (Exception $e) {}
restore_error_handler();
echo 'propUnsetThrow:' . json_encode([$p2, $p3]) . "\n";

$p4 = (object)['x' => null];
set_error_handler(function () use ($p4) { unset($p4->x); throw new Exception('e'); });
try { $p4->x--; } catch (Exception $e) {}
restore_error_handler();
echo 'nullDynUnset:' . json_encode($p4) . "\n";

class MagicGetOnly { function __get($n) { echo 'get;'; return null; } }
$p5 = new MagicGetOnly();
@$p5->x = null;
set_error_handler(function () use ($p5) { unset($p5->x); throw new Exception('e'); });
try { $p5->x--; } catch (Exception $e) {}
restore_error_handler();
echo 'magicDynUnset:' . json_encode($p5) . "\n";

class MagicGetSet {
  function __get($n) { echo 'get;'; return null; }
  function __set($n, $v) { echo 'set;'; }
}
$p6 = new MagicGetSet();
set_error_handler(function () { throw new Exception('e'); });
try { $p6->x--; } catch (Exception $e) { echo 'caught;'; }
restore_error_handler();
echo "\n";

class ThrowOnReset { function __destruct() { throw new Exception('d'); } }
$ao5 = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
set_error_handler(function () use ($ao5) { $ao5['x'] = new ThrowOnReset(); return true; });
try { $ao5->x++; } catch (Exception $e) {}
set_error_handler(function () use ($ao5) { $ao5['y'] = new ThrowOnReset(); throw new Exception('h'); });
$chain = '';
try { $ao5->y += 2; } catch (Exception $e) { $chain = $e->getMessage() . '->' . $e->getPrevious()?->getMessage(); }
restore_error_handler();
echo 'aoResetThrow:' . $chain . ':' . json_encode($ao5->getArrayCopy()) . "\n";
`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: [
      'post++:[null,{"x":5}]',
      'pre++:[1,{"x":5}]',
      'post--:[null,{"x":5}]',
      'pre--:[null,{"x":5}]',
      '+=1:[null,{"x":5}]',
      'share:[null,{"init":1},{"init":1}]',
      'nested:[2,1,{"x":{"y":5}}]',
      'prop:[5,6]',
      'ao:[1,{"p":1}]',
      'ai:[null,1]',
      'foreach:unbound:2',
      'warn;Only arrays and Traversables can be unpacked, array given;unpack:set',
      'unpackThrow:Only arrays and Traversables can be unpacked, null given|handler',
      'propThrow:{"x":5}',
      'aoThrow:{"x":null,"y":1}',
      'aoRef:[5,1,2]',
      'propUnsetThrow:[{"x":null},{"x":null}]',
      'nullDynUnset:{}',
      'magicDynUnset:{}',
      'get;caught;',
      'aoResetThrow:d->h:{"x":1,"y":2}',
      '',
    ].join('\n'),
  });
});

test('leaves deferred closure static initializers null in debug output before first call', () => {
  const result = run(String.raw`<?php
class Prior { const K = 3; }
function makeForward() {
  return function () {
    static $fw = Forward::K + 1;
    static $pr = Prior::K + 1;
  };
}
class Forward { const K = 3; }
class P { const PK = 7; }
trait T {
  function tf() {
    return function () { static $x = __CLASS__; };
  }
}
class C extends P {
  use T;
  const K = 3;
  function cf() {
    return function () {
      static $s = self::K;
      static $p = parent::PK;
      static $n = C::K;
    };
  }
}
$c = new C();
$f1 = $c->cf();
$f2 = $c->tf();
$f3 = makeForward();
var_dump($f1, $f2, $f3);
$f1();
$f2();
$f3();
var_dump($f1, $f2, $f3);
`);
  expect(result.kind).toBe('executed');
  if (result.kind === 'executed') {
    const statics = [...result.stdout.matchAll(/\["(s|p|n|x|fw|pr)"\]=>\n\s+(NULL|int\(\d+\)|string\(1\) "C")/g)].map(
      (match) => `${match[1]}=${match[2]}`
    );
    expect(statics).toEqual([
      's=NULL',
      'p=NULL',
      'n=int(3)',
      'x=NULL',
      'fw=NULL',
      'pr=int(4)',
      's=int(3)',
      'p=int(7)',
      'n=int(3)',
      'x=string(1) "C"',
      'fw=int(4)',
      'pr=int(4)',
    ]);
  }
});

test('finishes SPL property updates before propagating exit or bucket reuse from a displaced destructor', () => {
  const exitResult = run(String.raw`<?php
class ExitOnReset { function __destruct() { exit('exit;'); } }
class Observer { function __destruct() { global $a; echo json_encode($a->getArrayCopy()); } }
$a = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
$obs = new Observer();
set_error_handler(function () use ($a) { $a['x'] = new ExitOnReset(); return true; });
$a->x += 2;
`);
  expect(exitResult).toMatchObject({ kind: 'executed', stdout: 'exit;{"x":2}' });

  const reuseResult = run(String.raw`<?php
class ReuseBucket { function __destruct() { global $a; unset($a['x']); $a['y'] = 9; } }
class Observer { function __destruct() { global $a; echo json_encode($a->getArrayCopy()); } }
$a = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
$obs = new Observer();
set_error_handler(function () use ($a) { $a['x'] = new ReuseBucket(); return true; });
$a->x .= 'b';
`);
  expect(reuseResult).toMatchObject({ kind: 'executed', stdout: '{"y":"b"}' });

  const reuseExitInc = run(String.raw`<?php
class ReuseExit { function __destruct() { global $a; unset($a['x']); $a['y'] = 9; exit('exit;'); } }
class Observer { function __destruct() { global $a; echo json_encode($a->getArrayCopy()); } }
$a = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
$obs = new Observer();
set_error_handler(function () use ($a) { $a['x'] = new ReuseExit(); return true; });
$a->x++;
`);
  expect(reuseExitInc).toMatchObject({ kind: 'executed', stdout: 'exit;{"y":1}' });

  const reuseExitDec = run(String.raw`<?php
class ReuseExit { function __destruct() { global $a; unset($a['x']); $a[10] = 9; exit('exit;'); } }
class Observer { function __destruct() { global $a; echo json_encode($a->getArrayCopy()); } }
$a = new ArrayIterator([], ArrayObject::ARRAY_AS_PROPS);
$obs = new Observer();
set_error_handler(function () use ($a) { $a['x'] = new ReuseExit(); return true; });
--$a->x;
`);
  expect(reuseExitDec).toMatchObject({ kind: 'executed', stdout: 'exit;{"10":null}' });

  const secondWarnExit = run(String.raw`<?php
class Observer { function __destruct() { global $a; echo json_encode($a->getArrayCopy()); } }
$a = new ArrayObject([], ArrayObject::ARRAY_AS_PROPS);
$obs = new Observer();
$n = 0;
set_error_handler(function () use ($a, &$n) {
  if (++$n === 1) { $a['x'] = 5; return true; }
  unset($a['x']);
  $a['y'] = 9;
  exit('exit;');
});
$a->x--;
`);
  expect(secondWarnExit).toMatchObject({ kind: 'executed', stdout: 'exit;{"y":null}' });

  const overloadedGet = run(String.raw`<?php
class CustomAO extends ArrayObject {
  function offsetGet(mixed $key): mixed { echo 'get;'; return null; }
  function offsetSet(mixed $key, mixed $value): void { echo 'set;'; }
}
$a = new CustomAO([], ArrayObject::ARRAY_AS_PROPS);
set_error_handler(function () { echo 'warn;'; return true; });
$a->x--;
restore_error_handler();
`);
  expect(overloadedGet).toMatchObject({ kind: 'executed', stdout: 'get;warn;set;' });
});

test('exposes SPL __debugInfo() as callable methods with tentative return-type contracts', () => {
  const result = run(String.raw`<?php
class SubAO extends ArrayObject { function __debugInfo(): ?array { return []; } }
foreach (['ArrayObject', 'ArrayIterator', 'SplObjectStorage', 'SplStack', 'SplMinHeap', 'SplPriorityQueue', 'MultipleIterator'] as $cls) {
  $x = new $cls();
  echo $cls . ':' . count($x->__debugInfo()) . '@' . array_search('__debugInfo', get_class_methods($cls), true) . "\n";
}
`);
  expect(result).toMatchObject({
    kind: 'executed',
    stdout: [
      '',
      String.raw`Deprecated: Return type of SubAO::__debugInfo(): ?array should either be compatible with ArrayObject::__debugInfo(): array, or the #[\ReturnTypeWillChange] attribute should be used to temporarily suppress the notice in /main.php on line 2`,
      'ArrayObject:1@24',
      'ArrayIterator:1@26',
      'SplObjectStorage:1@24',
      'SplStack:2@7',
      'SplMinHeap:3@12',
      'SplPriorityQueue:3@15',
      'MultipleIterator:1@12',
      '',
    ].join('\n'),
  });
});

test('completes CachingIterator cache transitions when a destructor exits', () => {
  const setFlagsExit = run(String.raw`<?php
class Probe { function __construct(public $it) {} function __destruct() { echo 'flags:' . $this->it->getFlags() . ';'; } }
class ExitItem { function __construct(public $n) {} function __destruct() { echo 'd' . $this->n . ';'; if ($this->n === 1) exit; } }
$it = new CachingIterator(new ArrayIterator([]), CachingIterator::FULL_CACHE);
$p = new Probe($it);
$it['a'] = new ExitItem(1);
$it['b'] = new ExitItem(2);
$it->setFlags(0);
$it->setFlags(CachingIterator::FULL_CACHE | CachingIterator::TOSTRING_USE_KEY);
`);
  expect(setFlagsExit).toMatchObject({ kind: 'executed', stdout: 'd1;d2;flags:258;' });

  const rewindExit = run(String.raw`<?php
class Probe { function __construct(public $it) {} function __destruct() { echo 'valid:' . (int)$this->it->valid() . ';'; } }
class ExitItem { function __destruct() { echo 'exit;'; exit; } }
$it = new CachingIterator(new ArrayIterator([1]), CachingIterator::FULL_CACHE);
$p = new Probe($it);
$it->rewind();
$it['x'] = new ExitItem();
$it->rewind();
`);
  expect(rewindExit).toMatchObject({ kind: 'executed', stdout: 'exit;valid:0;' });
});

test('completes native SPL and dynamic property writes after interrupted getter inc/dec warnings', () => {
  const splThrow = run(String.raw`<?php
class C extends ArrayObject { function offsetGet(mixed $n): mixed { echo 'get;'; return null; } }
class R { function __construct(public $a) {} function __destruct() { echo json_encode($this->a->getArrayCopy()); } }
$a = new C([], ArrayObject::ARRAY_AS_PROPS);
$r = new R($a);
set_error_handler(function () { throw new Exception('e'); });
try { $a->x--; } catch (Throwable $e) { echo 'caught;'; }
`);
  expect(splThrow).toMatchObject({ kind: 'executed', stdout: 'get;caught;{"x":null}' });

  const splBoolExit = run(String.raw`<?php
class C extends ArrayIterator { function offsetGet(mixed $n): mixed { echo 'get;'; return true; } }
class R { function __construct(public $a) {} function __destruct() { echo json_encode($this->a->getArrayCopy()); } }
$a = new C([], ArrayObject::ARRAY_AS_PROPS);
$r = new R($a);
set_error_handler(function () { exit('exit;'); });
$a->x++;
`);
  expect(splBoolExit).toMatchObject({ kind: 'executed', stdout: 'get;exit;{"x":true}' });

  const magicGetNoSet = run(String.raw`<?php
class A { function __get($n) { echo 'get;'; return null; } }
class R { function __construct(public $o) {} function __destruct() { echo json_encode(get_object_vars($this->o)); } }
$a = new A();
$r = new R($a);
set_error_handler(function ($no) { echo "err:$no;"; throw new Exception('e'); });
try { $a->x--; } catch (Throwable $e) { echo 'caught;'; }
`);
  expect(magicGetNoSet).toMatchObject({ kind: 'executed', stdout: 'get;err:2;caught;{"x":null}' });

  const displacedDestructorThrow = run(String.raw`<?php
class D { function __destruct() { echo 'drop;'; throw new Exception('drop'); } }
class C extends ArrayObject { function offsetGet(mixed $n): mixed { echo 'get;'; return null; } }
class R { function __construct(public $a) {} function __destruct() { echo json_encode($this->a->getArrayCopy()); } }
$a = new C(['x' => new D()], ArrayObject::ARRAY_AS_PROPS);
$r = new R($a);
set_error_handler(function () { exit('exit;'); });
try { $a->x--; } catch (Throwable $e) { echo 'caught:' . $e->getMessage() . ';'; }
`);
  expect(displacedDestructorThrow).toMatchObject({ kind: 'executed', stdout: 'get;exit;drop;caught:drop;{"x":null}' });

  const displacedDestructorWarning = run(String.raw`<?php
class D { function __destruct() { trigger_error('second', E_USER_WARNING); } }
class C extends ArrayIterator { function offsetGet(mixed $n): mixed { echo 'get;'; return null; } }
$a = new C(['x' => new D()], ArrayObject::ARRAY_AS_PROPS);
set_error_handler(function ($no, $msg) { echo "h:$msg;"; throw new Exception('first'); });
try { $a->x--; } catch (Throwable $e) { echo 'caught:' . $e->getMessage() . ';'; }
`);
  expect(displacedDestructorWarning).toMatchObject({
    kind: 'executed',
    stdout:
      'get;h:Decrement on type null has no effect, this will change in the next major version of PHP;h:second;caught:first;',
  });

  const operandExitPrecedence = run(String.raw`<?php
set_error_handler(function () { echo 'handler;'; exit('exit;'); });
try { $missing / 0; echo 'after;'; } catch (Throwable $e) { echo 'caught:' . $e->getMessage() . ';'; }
`);
  expect(operandExitPrecedence).toMatchObject({ kind: 'executed', stdout: 'handler;exit;' });
});

test('emits &#xFFFD; for disallowed ISO-8859-1 characters under ENT_DISALLOWED', () => {
  const result = run(String.raw`<?php
echo htmlspecialchars("A\x01B", ENT_QUOTES | ENT_DISALLOWED, 'ISO-8859-1'), "\n";
echo htmlentities("A\x80B", ENT_QUOTES | ENT_DISALLOWED, 'ISO-8859-1'), "\n";
`);
  expect(result).toMatchObject({ kind: 'executed', stdout: 'A&#xFFFD;B\nA&#xFFFD;B\n' });
});

test('preserves cycle destructor order across a live gc_collect_cycles() inside a closure', () => {
  const twoCycle = run(String.raw`<?php
class N { public $p; function __construct(public $id) {} function __destruct() { echo $this->id; } }
(function () { $a = new N('a'); $b = new N('b'); $a->p = $b; gc_collect_cycles(); $b->p = $a; })();
echo '|', gc_collect_cycles(), "\n";
`);
  expect(twoCycle).toMatchObject({ kind: 'executed', stdout: '|ab2\n' });

  const threeCycle = run(String.raw`<?php
class N { public $p; function __construct(public $id) {} function __destruct() { echo $this->id; } }
(function () { $a = new N('a'); $b = new N('b'); $c = new N('c'); $a->p = $b; gc_collect_cycles(); $b->p = $c; $c->p = $a; })();
echo '|', gc_collect_cycles(), "\n";
`);
  expect(threeCycle).toMatchObject({ kind: 'executed', stdout: '|abc3\n' });
});

test('matches PHP array internal pointer and packed append-key transitions across copy, unset, and insert', () => {
  const copyInvalid = run(String.raw`<?php
$a = [10, 20];
prev($a);
$b = $a;
$a[] = 30;
var_dump(key($a), current($a), key($b), current($b));
`);
  expect(copyInvalid).toMatchObject({ kind: 'executed', stdout: 'int(0)\nint(10)\nNULL\nbool(false)\n' });

  const emptiedPacked = run(String.raw`<?php
$a = [1, 2, 3];
unset($a[0], $a[1], $a[2]);
$a[0] = 7;
$a[] = 9;
echo json_encode($a);
`);
  expect(emptiedPacked).toMatchObject({ kind: 'executed', stdout: '[7,9]' });

  const invalidPhysicalPointer = run(String.raw`<?php
$a = [1, 2, 3];
unset($a[0]);
prev($a);
$a[0] = 7;
var_dump(key($a), current($a));
$a[9] = 8;
var_dump(key($a), current($a));
`);
  expect(invalidPhysicalPointer).toMatchObject({
    kind: 'executed',
    stdout: 'NULL\nbool(false)\nint(9)\nint(8)\n',
  });
});

test('preserves cycle root order across by-reference foreach and cursor positions across unpack and shift', () => {
  const byRefForeachGc = run(String.raw`<?php
class N { public $p; function __construct(public $id) {} function __destruct() { echo $this->id; } }
(function () {
  $a = new N('a'); $b = new N('b'); $c = new N('c');
  $x = [$a, $b];
  $a->p = $c;
  foreach ($x as &$v) { gc_collect_cycles(); break; }
  $b->p = $a; $c->p = $b;
})();
echo '|', gc_collect_cycles();
`);
  expect(byRefForeachGc).toMatchObject({ kind: 'executed', stdout: '|cab3' });

  const replacedSubjectGc = run(String.raw`<?php
class N { public $p; function __construct(public $id) {} function __destruct() { echo $this->id; } }
(function () {
  $a = new N('a'); $b = new N('b'); $c = new N('c');
  $x = [$a, $b];
  foreach ($x as &$v) { $x = [$c]; gc_collect_cycles(); break; }
  unset($v);
  $b->p = $c; $c->p = $b; $a->p = $b;
})();
echo '|', gc_collect_cycles();
`);
  expect(replacedSubjectGc).toMatchObject({ kind: 'executed', stdout: 'a|bc2' });

  const sparseSortCursor = run(String.raw`<?php
$a = [0 => 1, 3 => 2, 5 => 3, 7 => 4];
foreach ($a as $k => &$v) { echo "$v;"; if ($v === 2) ksort($a); }
unset($v);
`);
  expect(sparseSortCursor).toMatchObject({ kind: 'executed', stdout: '1;2;3;4;' });

  const packedShiftCursor = run(String.raw`<?php
$a = [1, 2, 3];
foreach ($a as &$v) { echo "$v;"; if ($v === 3) { array_shift($a); $a[] = 8; } }
unset($v);
`);
  expect(packedShiftCursor).toMatchObject({ kind: 'executed', stdout: '1;2;3;' });

  const mixedShiftCursor = run(String.raw`<?php
$a = ['a' => 1, 2 => 2, 'c' => 3];
foreach ($a as &$v) { echo "$v;"; if ($v === 3) { array_shift($a); $a[] = 9; } }
unset($v);
`);
  expect(mixedShiftCursor).toMatchObject({ kind: 'executed', stdout: '1;2;3;9;' });

  const sparsePackedShiftCursor = run(String.raw`<?php
$a = [0 => 1, 2 => 2];
foreach ($a as &$v) { echo "$v;"; if ($v === 2) { array_shift($a); $a[] = 9; } }
unset($v);
`);
  expect(sparsePackedShiftCursor).toMatchObject({ kind: 'executed', stdout: '1;2;' });

  const compactedPointerCopy = run(String.raw`<?php
$a = ['a' => 1, 'b' => 2, 'c' => 3, 'd' => 4];
unset($a['a']); reset($a); unset($a['b']);
$b = $a; $a['new'] = 5;
echo key($a), ':', current($a), ',', key($b), ':', current($b), ';';
$c = ['k0' => 0, 'k1' => 1, 'k2' => 2, 'k3' => 3, 'k4' => 4];
unset($c['k0'], $c['k1']); reset($c); unset($c['k2'], $c['k3']);
$d = $c; $c['new1'] = 10;
echo key($c) ?? 'null', ',';
$c['new2'] = 20;
echo key($c), ',', key($d);
`);
  expect(compactedPointerCopy).toMatchObject({ kind: 'executed', stdout: 'd:4,c:3;null,new2,k4' });

  const nestedDestructorGc = run(String.raw`<?php
class N { public $p; function __construct(public $n) {} function __destruct() { echo $this->n; } }
class A { function __destruct() {
  $a = new N('a'); $b = new N('b'); $c = new N('c');
  $a->p = $b; $b->p = $c; $c->p = $a;
  gc_collect_cycles(); unset($c, $b, $a); echo '|', gc_collect_cycles();
} }
$x = new A; unset($x);
`);
  expect(nestedDestructorGc).toMatchObject({ kind: 'executed', stdout: '|cba3' });

  const arrayAccessRefKeys = run(String.raw`<?php
class A implements ArrayAccess {
  function offsetExists($k): bool { return true; }
  function offsetGet($k): mixed { echo get_debug_type($k), ';'; return 1; }
  function offsetSet($k, $v): void {}
  function offsetUnset($k): void {}
}
$s = new A; $x = 4;
foreach ([new stdClass, 1.5] as $k) {
  try { @$s[$k] =& $x; } catch (Throwable $e) { echo get_class($e), '|'; }
}
$ao = new ArrayObject;
try { $ao[new stdClass] =& $x; } catch (Throwable $e) { echo get_class($e), ':', $e->getMessage(); }
`);
  expect(arrayAccessRefKeys).toMatchObject({
    kind: 'executed',
    stdout: 'stdClass;Error|float;Error|TypeError:Cannot access offset of type stdClass on ArrayObject',
  });

  const mixedHoleShift = run(String.raw`<?php
$a = [1, 2, 3]; $a['x'] = 4; unset($a[1]);
foreach ($a as &$v) { echo "$v;"; if ($v === 1) array_shift($a); }
unset($v);
echo '|';
$b = [1, 2, 3, 4]; unset($b[1]);
foreach ($b as &$v) { echo "$v;"; if ($v === 1) array_shift($b); }
unset($v);
`);
  expect(mixedHoleShift).toMatchObject({ kind: 'executed', stdout: '1;3;4;|1;4;' });

  for (const replacement of ['[$c, $a]', "['z' => $c, 'q' => $a]", "(object)['z' => $c, 'q' => $a]"]) {
    const replacedWithLoopValue = run(String.raw`<?php
class N { public $p; function __construct(public $id) {} function __destruct() { echo $this->id; } }
(function () {
  $a = new N('a'); $b = new N('b'); $c = new N('c'); $x = [$a, $b];
  foreach ($x as &$v) { $x = ${replacement}; gc_collect_cycles(); break; }
  unset($v); $b->p = $c; $c->p = $b; $a->p = $b;
})();
echo '|', gc_collect_cycles();
`);
    expect(replacedWithLoopValue).toMatchObject({ kind: 'executed', stdout: 'a|cb2' });
  }

  const capturedLookbehind = run(String.raw`<?php
preg_match('/(?<=(a)|bc)d/', 'ad', $m1);
preg_match('/(?<=(a{1,2}))b/', 'aab', $m2);
preg_match('/(?<=(a{1,2}?))b/', 'aab', $m3);
echo json_encode([$m1, $m2, $m3]);
`);
  expect(capturedLookbehind).toMatchObject({
    kind: 'executed',
    stdout: '[["d","a"],["b","aa"],["b","aa"]]',
  });

  const liveLocalCleanup = run(String.raw`<?php
class D { function __construct(public $n) {} function __destruct() { echo $this->n; } }
class A {
  public $r;
  function __construct(&$r, public $replacement) { $this->r =& $r; }
  function __destruct() { echo 'A'; $this->r = $this->replacement; echo 'Z'; }
}
function f($replacement) {
  $a = null; $b = new D('b'); $c = new D('c');
  $a = new A($b, $replacement);
}
f(null); echo '|'; f(new D('x'));
`);
  expect(liveLocalCleanup).toMatchObject({ kind: 'executed', stdout: 'AbZc|AbZxc' });

  const retiredObjectFreeWrapper = run(String.raw`<?php
$a = [4]; next($a); $b = [[$a]]; unset($b); $a['b'] = 8;
echo key($a), ':', current($a), ';';
$c = [4]; next($c); count([$c]); $c['b'] = 8;
echo key($c), ':', current($c), ';';
$d = [4]; next($d); array_merge([$d], [new stdClass]); $d['b'] = 8;
echo key($d), ':', current($d), ';';
$e = [4]; next($e); $w = [[$e]]; $o = new stdClass; $o->w = $w; unset($w); unset($o); $e['b'] = 8;
echo key($e), ':', current($e);
`);
  expect(retiredObjectFreeWrapper).toMatchObject({ kind: 'executed', stdout: 'b:8;b:8;b:8;b:8' });

  const nestedCycleArrayCount = run(String.raw`<?php
$x = [1]; $y = [$x]; $a = [$y]; $a[] =& $a; unset($x, $y, $a);
echo gc_collect_cycles(), ',';
$x = [1]; $y = [$x]; $z = [$y]; $a = [$z]; $a[] =& $a; unset($x, $y, $z, $a);
echo gc_collect_cycles(), ',';
$v = 1; $a = [[$v]]; $a[] =& $a; unset($a);
echo gc_collect_cycles();
`);
  expect(nestedCycleArrayCount).toMatchObject({ kind: 'executed', stdout: '2,3,2' });

  const cycleBehindDestructor = run(String.raw`<?php
class N { public $p; function __destruct() { echo 'D'; } }
$a = []; $b = []; $n = new N; $b[0] =& $b; $b[1] = $n; $a[0] =& $a; $n->p =& $a;
unset($a, $n, $b);
echo '|', gc_collect_cycles(), ';';
$a = []; $b = []; $d1 = new N; $d2 = new N; $b[0] =& $b; $b[1] = $d1; $d1->p = $d2; $a[0] =& $a; $d2->p =& $a;
unset($a, $d1, $d2, $b);
echo '|', gc_collect_cycles(), ';';
$v = 1; $b = []; $d = new N; $b[0] =& $b; $b[1] = $d; $d->p = [$v];
unset($d, $b);
echo '|', gc_collect_cycles();
`);
  expect(cycleBehindDestructor).toMatchObject({ kind: 'executed', stdout: '|D2;|DD2;|D1' });

  const splByRefForeach = run(String.raw`<?php
$ao = new ArrayObject([1, 2, 3]);
foreach ($ao as $k => &$v) { echo "$v;"; if ($k === 0) unset($ao[$k]); }
unset($v);
echo '|';
$ai = new ArrayIterator([1, 2, 3]);
foreach ($ai as $k => &$v) { echo "$v;"; if ($k === 0) unset($ai[$k]); }
unset($v);
echo '|';
$ao2 = new ArrayObject([1, 2, 3]);
foreach ($ao2 as $k => &$v) { echo "$v;"; if ($k === 0) $ao2->exchangeArray([10, 20, 30]); }
unset($v);
echo '|';
$ao3 = new ArrayObject([0 => 1, 2 => 2, 5 => 3]);
$i = 0;
foreach ($ao3 as $k => &$v) { echo "$k:$v;"; if (++$i === 2) $ao3->asort(); }
unset($v);
echo '|', json_encode($ao3->getArrayCopy()), '|';
$ai2 = new ArrayIterator(['a' => 1, 'b' => 2, 'c' => 3]);
foreach ($ai2 as $k => &$v) { if ($k === 'b') break; }
unset($v);
echo $ai2->key(), ':', $ai2->current(), '|';
$ai3 = new ArrayIterator(['a' => 1, 'b' => 2, 'c' => 3, 'd' => 4]);
foreach ($ai3 as $k => &$v) { echo "$k:$v;"; if ($k === 'a') $ai3->next(); }
unset($v);
echo '|';
class SubValid extends ArrayIterator { function valid(): bool { return false; } }
$s = new SubValid([1, 2]);
try { foreach ($s as &$v) { $v = 9; } } catch (Error $e) { echo 'err:'; }
echo json_encode($s->getArrayCopy());
`);
  expect(splByRefForeach).toMatchObject({
    kind: 'executed',
    stdout: '1;3;|1;3;|1;20;30;|0:1;2:2;|{"0":1,"2":2,"5":3}|b:2|a:1;c:3;d:4;|err:[1,2]',
  });

  const shiftPreservesStorage = run(String.raw`<?php
$a = [19]; unset($a[0]); $a[] = 3; $a[0] = 5;
array_shift($a); $a[7] = 2; prev($a); $a[] = 16;
echo var_export(key($a), true), ':', var_export(current($a), true), '|';
$b = [19]; unset($b[0]); $b[] = 3; $b[0] = 5;
array_shift($b); $b[6] = 2; prev($b); $b[8] = 16;
echo var_export(key($b), true), ':', var_export(current($b), true), '|';
$c = [19]; unset($c[0]); $c[] = 3; $c[0] = 5; unset($c[1]);
array_shift($c); $c[0] = 5; $c[7] = 2; prev($c); $c[] = 16;
echo var_export(key($c), true), ':', var_export(current($c), true), '|';
$d = [0 => 1, 2 => 2];
array_shift($d); $d[7] = 2; prev($d); $d[] = 16;
echo var_export(key($d), true), ':', var_export(current($d), true);
`);
  expect(shiftPreservesStorage).toMatchObject({
    kind: 'executed',
    stdout: '8:16|8:16|8:16|NULL:false',
  });

  const liveScanCycleOrder = run(String.raw`<?php
class N {
  public $x;
  function __construct(public $id) {}
  function __destruct() { echo $this->id; }
}
$a = new N('a'); $b = new N('b'); $c = new N('c'); $d = new N('d');
$a->x = $d; $b->x = [$a]; $c->x =& $a; $d->x = $c;
unset($a); gc_collect_cycles();
unset($b, $c, $d);
echo '|', gc_collect_cycles(), ';';
$a = new N('a'); $b = new N('b'); $c = new N('c'); $d = new N('d');
$a->x = [$d]; $b->x = [$a]; $c->x =& $a; $d->x = [$c];
unset($a); gc_collect_cycles();
unset($b, $c, $d);
echo '|', gc_collect_cycles(), ';';
$a = new N('a'); $b = new N('b'); $c = new N('c'); $d = new N('d');
$a->x = $d; $b->x = [[$a]]; $c->x =& $a; $d->x = $c;
unset($a); gc_collect_cycles();
unset($b, $d, $c);
echo '|', gc_collect_cycles();
`);
  expect(liveScanCycleOrder).toMatchObject({
    kind: 'executed',
    stdout: 'b|cad3;b|cad5;b|dac3',
  });

  const collectedCycleSurvivors = run(String.raw`<?php
class N {
  public $a; public $b;
  function __construct(public $id) {}
  function __destruct() { echo $this->id; }
}
foreach ([0, 1, 2] as $depth) {
  $v1 = new N('1'); $v2 = new N('2'); $v3 = new N('3');
  $v1->b = $v1; $v2->a = $v2; $v3->b = $v3;
  $v2->b = $depth === 0 ? $v3 : ($depth === 1 ? [$v3] : [[$v3]]);
  unset($v2);
  echo '|', gc_collect_cycles(), ';';
  unset($v1, $v3);
  echo '|', gc_collect_cycles(), ',';
}
$v1 = new N('1'); $v2 = new stdClass(); $v3 = new N('3');
$v1->b = $v1; $v2->a = $v2; $v2->b = $v3; $v3->b = $v3;
unset($v2); echo '|', gc_collect_cycles(), ';';
unset($v1, $v3); echo '|', gc_collect_cycles(), ',';
$v1 = new N('1'); $v3 = new N('3');
$v1->b = $v1; $v3->b = $v3;
$a = []; $a[0] =& $a; $a[1] = $v3;
unset($a); echo '|', gc_collect_cycles(), ';';
unset($v1, $v3); echo '|', gc_collect_cycles();
`);
  expect(collectedCycleSurvivors).toMatchObject({
    kind: 'executed',
    stdout: '|21;|312,|22;|312,|23;|312,|1;|312,|1;|312',
  });

  for (const [disable, stdout] of [
    [true, 'b|dac3'],
    [false, 'b|acd3'],
  ] as const) {
    expect(
      run(String.raw`<?php
${disable ? 'gc_disable();' : ''}
class N { public $x; function __construct(public $id) {} function __destruct() { echo $this->id; } }
$a = new N('a'); $b = new N('b'); $c = new N('c'); $d = new N('d');
$a->x = $d; $b->x = [$a]; $c->x =& $a; $d->x = $c;
unset($a); gc_collect_cycles();
$keep = [];
for ($i = 0; $i < 10000; $i++) { $o = new stdClass; $o->x = $o; $keep[] = $o; }
unset($b, $c, $d); echo '|', gc_collect_cycles();
`)
    ).toMatchObject({ kind: 'executed', stdout });
  }

  for (const [setup, expected] of [
    ['$a->x = $d; $q = [$a]; $b->x = $q;', 'b|acd3'],
    ['$a->x = $d; $q = [$a]; $b->x =& $q;', 'b|acd3'],
    ['$a->x = $d; $q = [[$a]]; $b->x = $q;', 'b|acd3'],
    ['$a->x = $d; $q = [$a]; $b->x = [$q];', 'b|acd3'],
    ['$a->x = $d; $q = [$a]; $b->x = [&$q];', 'b|acd3'],
    ['$a->x = [$d]; $q = [$a]; $b->x = $q;', 'b|acd4'],
  ] as const) {
    expect(
      run(String.raw`<?php
class N { public $x; function __construct(public $id) {} function __destruct() { echo $this->id; } }
$a = new N('a'); $b = new N('b'); $c = new N('c'); $d = new N('d');
${setup} $c->x =& $a; $d->x = $c;
unset($a); gc_collect_cycles();
unset($q, $b, $c, $d);
echo '|', gc_collect_cycles();
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  const extractEmptyKeys = run(String.raw`<?php
$input = ['' => 'wrong', 'name' => 'Ada', 0 => 'zero'];
echo extract($input, EXTR_PREFIX_ALL, 'row'), '|', $row_name, '|', $row_0, '|', isset($row_) ? $row_ : 'absent', ';';
$input2 = ['' => 'wrong', 'name' => 'Ada'];
echo extract($input2, EXTR_PREFIX_ALL | EXTR_REFS, 'ref'), '|', $ref_name, '|', isset($ref_) ? $ref_ : 'absent', ';';
$input3 = ['' => 'empty', 'ok' => 'good'];
echo extract($input3, EXTR_PREFIX_INVALID, 'inv'), '|', $inv_, '|', $ok;
`);
  expect(extractEmptyKeys).toMatchObject({
    kind: 'executed',
    stdout: '2|Ada|zero|absent;1|Ada|absent;2|empty|good',
  });

  const parenthesizedBreakContinue = run(String.raw`<?php
for ($i = 0; $i < 3; $i++) { echo $i; break (1); }
echo '|';
for ($i = 0; $i < 3; $i++) { if ($i === 1) continue ((1)); echo $i; }
`);
  expect(parenthesizedBreakContinue).toMatchObject({ kind: 'executed', stdout: '0|02' });
  expect(run('<?php for ($i = 0; $i < 3; $i++) { break (+1); }').kind).toBe('compileError');
  expect(run('<?php for ($i = 0; $i < 3; $i++) { break (1 + 1); }').kind).toBe('compileError');
  expect(run('<?php for ($i = 0; $i < 3; $i++) { break (0); }').kind).toBe('compileError');

  const arrayCompoundUnionPointer = run(String.raw`<?php
$a = [1, 2, 3]; next($a); next($a); next($a); $a += [3 => 4];
echo json_encode([key($a), current($a)]), '|';
$b = ['a' => 1, 'b' => 2]; end($b); next($b); $b += ['a' => 9];
echo var_export(key($b), true), '|';
$c = [1, 2, 3]; next($c); next($c); next($c); $copy = $c; $c += [3 => 4];
echo json_encode([key($c), current($c), key($copy), current($copy)]), '|';
$d = [1, 2, 3]; next($d); next($d); next($d); $d += $d;
echo json_encode([key($d), current($d)]), '|';
$o = (object)['a' => [1, 2]]; end($o->a); next($o->a); $o->a += [2 => 3];
echo json_encode([key($o->a), current($o->a)]), '|';
$e = [1, 2, 3]; next($e); next($e); next($e); $e = $e + [3 => 4];
echo json_encode([key($e), current($e)]);
`);
  expect(arrayCompoundUnionPointer).toMatchObject({
    kind: 'executed',
    stdout: '[3,4]|NULL|[0,1,null,false]|[null,false]|[2,3]|[0,1]',
  });

  for (const [held, expected] of [
    ['$d', 'ca|db2;'],
    ['[$d]', 'ca|db3;'],
  ] as const) {
    expect(
      run(String.raw`<?php
class N { public $p; public $q; function __construct(public $id) {} function __destruct() { echo $this->id; } }
$a = new N('a'); $b = new N('b'); $c = new N('c'); $d = new N('d');
gc_collect_cycles();
$c->q =& $a; $d->p = $b; $c->q =& $a; $b->p = ${held};
unset($b, $d, $a, $c);
echo '|', gc_collect_cycles(), ';';
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  const arrayValuesPointer = run(String.raw`<?php
$a = [1, 2, 3]; ksort($a); next($a); $a = array_values($a);
echo json_encode([key($a), current($a)]), '|';
$b = [1, 2, 3]; asort($b); next($b); $b = array_values($b);
echo json_encode([key($b), current($b)]), '|';
$c = [1, 2, 3]; $c[] = 4; unset($c[3]); next($c); $c = array_values($c);
echo json_encode([key($c), current($c)]), '|';
$d = [1, 2, 3]; sort($d); next($d); $d = array_values($d);
echo json_encode([key($d), current($d)]);
`);
  expect(arrayValuesPointer).toMatchObject({
    kind: 'executed',
    stdout: '[0,1]|[0,1]|[0,1]|[1,2]',
  });

  const mixedCycleHandleReuse = run(String.raw`<?php
class Node { public $next; function __destruct() { echo "D"; } }
class Plain { public $next; }
$p1 = new Plain; $p1->next = $p1;
$a = new Node; $a->next = $a;
$p2 = new Plain; $p2->next = $p2;
unset($p1, $a, $p2);
echo gc_collect_cycles(), '|', spl_object_id(new Plain), '|';
$x = new Plain; $y = new Plain; $z = new Plain;
echo spl_object_id($x), spl_object_id($y), spl_object_id($z);
`);
  expect(mixedCycleHandleReuse).toMatchObject({ kind: 'executed', stdout: 'D3|2|231' });

  const destructibleBeforePlainHandles = run(String.raw`<?php
class Node { public $next; function __destruct() { echo "D"; } }
class Plain { public $next; }
$a = new Node; $p1 = new Plain; $p2 = new Plain;
$a->next = [$a, $p1]; $p2->next = $p2;
unset($a, $p1, $p2);
echo gc_collect_cycles(), '|';
$x = new Plain; $y = new Plain; $z = new Plain;
echo spl_object_id($x), spl_object_id($y), spl_object_id($z);
`);
  expect(destructibleBeforePlainHandles).toMatchObject({ kind: 'executed', stdout: 'D4|123' });

  for (const [body, expected] of [
    [
      '$p = new Plain; $p->next = $p; $p->o = new Node(1); $p2 = new Plain; $p2->next = $p2; unset($p, $p2);',
      '~1 2 3,1,2,4',
    ],
    ['$p = new Plain; $p->next = $p; $a = new Node(1); $a->next = $a; $a->o = $p; unset($a, $p);', '~1 2 1,2,3,4'],
    [
      '$a = new Node(1); $b = new Plain; $c = new Plain; $a->next = $a; $a->o = $b; $b->next = $b; $b->o = $c; unset($a, $b, $c);',
      '~1 3 2,3,1,4',
    ],
    [
      '$a = new Node(1); $c = new Plain; $b = new Plain; $a->next = $a; $a->o = $c; $c->o = $b; $b->next = $b; unset($a, $c, $b);',
      '~1 3 3,1,2,4',
    ],
  ] as const) {
    expect(
      run(String.raw`<?php
class Node { public $next; public $o; function __construct(public $n = 0) {} function __destruct() { echo "~{$this->n} "; } }
class Plain { public $next; public $o; }
${body}
echo gc_collect_cycles(), ' ';
$ids = [];
for ($i = 0; $i < 4; $i++) { $k[] = new Plain; $ids[] = spl_object_id(end($k)); }
echo implode(',', $ids);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  const arrayMergeStorageLayout = run(String.raw`<?php
foreach ([
  array_merge([5 => 1, 3 => 2, 9 => 3], [4]),
  array_merge([5 => 1, 3 => 2], []),
  array_merge([1, 2, 3], [4]),
  array_merge([1, 2, 3], [5 => 1, 3 => 2]),
  array_merge([], [], [1, 2, 3]),
] as $m) {
  end($m);
  $v = array_values($m);
  echo json_encode([key($v), current($v)]), '|';
}
`);
  expect(arrayMergeStorageLayout).toMatchObject({
    kind: 'executed',
    stdout: '[0,1]|[0,1]|[3,4]|[4,2]|[0,1]|',
  });

  const dimensionRefValueFallback = run(String.raw`<?php
error_reporting(0);
class BagSet extends ArrayObject {
  function offsetSet(mixed $key, mixed $value): void { echo 'setter;'; }
}
class BagGet extends ArrayObject {
  function offsetGet(mixed $key): mixed { echo 'getter;'; return 3; }
}
function values() { return [1]; }
$b = new BagSet;
$b['x'] =& values();
echo json_encode($b->getArrayCopy()), '|';
$g = new BagGet;
try { $g['x'] =& values(); } catch (Throwable $e) { echo $e->getMessage(), ';'; }
echo json_encode($g->getArrayCopy()), '|';
$x = 10; $ao = new ArrayObject(); $ao['k'] =& $x;
$ao['k'] =& values();
echo json_encode($x), ':', json_encode($ao->getArrayCopy());
`);
  expect(dimensionRefValueFallback).toMatchObject({
    kind: 'executed',
    stdout: '{"x":[1]}|getter;Cannot assign by reference to an array dimension of an object;[]|[1]:{"k":[1]}',
  });

  for (const [assignment, expected] of [
    ['$n2->a = [$n1, $n3]; $n2->b = $n2; $n3->next = $n4;', '|D2;5|4,1,2,3,'],
    ['$n2->a = [$n3, $n1]; $n2->b = $n2; $n3->next = $n4;', '|D2;5|1,4,2,3,'],
  ]) {
    expect(
      run(`<?php
class D { public $a; public $b; function __construct(public $name) {} function __destruct() { echo "D" . $this->name . ";"; } }
class P { public $self; public $next; }
$n1 = new P; $n2 = new D(2); $n3 = new P; $n4 = new P;
$n1->self = $n1; $n4->self = $n4;
${assignment}
unset($n1, $n2, $n3, $n4);
echo "|", gc_collect_cycles(), "|";
$out = [];
for ($i = 0; $i < 4; $i++) { $o = new P; $out[] = $o; echo spl_object_id($o), ","; }
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [wrapped, expected] of [
    [false, '2|2,1'],
    [true, '4|2,1'],
  ] as const) {
    expect(
      run(`<?php
class Node { public $self; public $child; }
$a = new Node; $b = new Node;
$a->self = $a;
$a->child = ${wrapped ? '[$b]' : '$b'};
$b->self = ${wrapped ? '[$b]' : '$b'};
unset($a, $b);
echo gc_collect_cycles(), '|';
$x = new Node; $y = new Node;
echo spl_object_id($x), ',', spl_object_id($y);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(
    run(String.raw`<?php
$s = "x";
foreach ([
  fn() => assert($s === "a\n"),
  fn() => assert($s === "{$s}1"),
  fn() => assert($s === "{$s}[0]"),
  fn() => assert($s === "a\x01"),
  fn() => assert($s === "a\e"),
] as $f) {
  try { $f(); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: String.raw`assert($s === "a\n")
assert($s === "{$s}1")
assert($s === "{$s}[0]")
assert($s === "a\001")
assert($s === "a\e")
`,
  });

  expect(
    run(`<?php
class P { function __construct(public $x) {} }
class Seg { function __construct(public $a, public $b) {} }
$pts = [];
for ($i = 0; $i < 8000; $i++) $pts[] = new P($i);
$s = 0;
for ($i = 1; $i < 4000; $i++) { $g = new Seg($pts[$i % 8000], $pts[0]); $s += $g->b->x; }
echo $s;
`)
  ).toMatchObject({ kind: 'executed', stdout: '0' });

  expect(
    run(`<?php
foreach ([
  array_merge_recursive([5 => 1, 3 => 2, 9 => 3], [4]),
  array_merge_recursive([5 => 1, 3 => 2, 9 => 3]),
  array_merge_recursive([], [5 => 1, 3 => 2]),
  array_merge_recursive([1, 2, 3], [4]),
  array_merge_recursive([1, 2, 3]),
  array_merge([], [5 => 1, 3 => 2]),
] as $m) {
  end($m);
  $v = array_values($m);
  echo json_encode([key($v), current($v)]), '|';
}
`)
  ).toMatchObject({ kind: 'executed', stdout: '[0,1]|[0,1]|[0,1]|[3,4]|[2,3]|[0,1]|' });

  for (const container of ['[]', 'new ArrayObject']) {
    expect(
      run(`<?php
error_reporting(0);
class C { public int $x = 0; }
function f() { return '3'; }
$c = new C;
$a = ${container};
$a[0] =& $c->x;
$r = ($a[0] =& f());
var_dump($r, $a[0], $c->x);
`)
    ).toMatchObject({ kind: 'executed', stdout: 'int(3)\nint(3)\nint(3)\n' });
  }

  const assertVarInterp = '"{$' + "{'s'}}\"";
  expect(
    run(String.raw`<?php
class Foo { public $x = 1; function x() { return 1; } static function bar() { return 1; } }
$s = "x"; $u = null; $a = new Foo; $b = "x";
foreach ([
  fn() => assert($s === TRUE),
  fn() => assert(Null === $s),
  fn() => assert("a" . "b" === $s),
  fn() => assert("a" . 1 === $s),
  fn() => assert("a" . true === $s),
  fn() => assert(isset($s, $u)),
  fn() => assert(!isset($s, $s)),
  fn() => assert(!$a instanceof Foo),
  fn() => assert($a->{$b} === 2),
  fn() => assert($a?->{$b} === 2),
  fn() => assert($a->{$b}() === 2),
  fn() => assert(Foo::{"bar"}() === 2),
  fn() => assert(${assertVarInterp} === "y"),
] as $f) {
  try { $f(); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: `assert($s === TRUE)
assert(Null === $s)
assert('ab' === $s)
assert('a1' === $s)
assert('a' . true === $s)
assert(isset($s) && isset($u))
assert(!(isset($s) && isset($s)))
assert(!$a instanceof Foo)
assert($a->$b === 2)
assert($a?->$b === 2)
assert($a->$b() === 2)
assert(Foo::bar() === 2)
assert("$s" === 'y')
`,
  });

  expect(
    run(`<?php
class P { public $o; function __construct(public $x) {} }
$pts = [];
for ($i = 0; $i < 3000; $i++) $pts[] = new P($i);
for ($i = 0; $i + 1 < 3000; $i++) $pts[$i]->o = $pts[$i + 1];
for ($i = 0; $i < 3000; $i++) { $k = $i % 2999; $pts[$k]->o = $pts[$k + 1]; }
echo "ok";
`)
  ).toMatchObject({ kind: 'executed', stdout: 'ok' });

  for (const [body, expected] of [
    [
      '$p = new Plain; $q = new Plain; $p->next = $q; $q->next = $p; $p->o = new Node(1); $q->o = new Node(2); unset($p, $q);',
      '~1 ~2 2 1,3,2,4,5,6',
    ],
    [
      '$p = new Plain; $p->next = $p; $n = new Node(1); $n->o = new Plain; $n->o->next = $n->o; $p->o = $n; unset($p, $n);',
      '~1 2 3,1,2,4,5,6',
    ],
    [
      '$p = new Plain; $p->next = $p; $n = new Node(1); $c = new Plain; $c->next = $c; $c->o = new Node(2); $n->o = $c; $p->o = $n; unset($p, $n, $c);',
      '~1 ~2 3 3,4,1,2,5,6',
    ],
    [
      '$p = new Plain; $p->next = $p; $n = new Node(1); $c = new Plain; $c->next = $c; $c->o = new Node(2); $n->o = $c; $n2 = new Node(3); $e = new Plain; $e->next = $e; $n2->o = $e; $p->o = $n; $p->p = $n2; unset($p, $n, $c, $n2, $e);',
      '~1 ~2 ~3 4 3,4,6,1,5,2',
    ],
    [
      '$p = new Plain; $p->next = $p; $n = new Node(1); $n->o = new Plain; $n->o->next = $n->o; $n->p = new Plain; $n->p->next = $n->p; $p->o = $n; unset($p, $n);',
      '~1 3 4,3,1,2,5,6',
    ],
    [
      '$p = new Plain; $p->next = $p; $n = new Node(1); $a = new Plain; $a->next = $a; $b = new Plain; $b->next = $b; $c = new Plain; $c->next = $c; $n->o = $a; $n->p = $b; $n->q = $c; $p->o = $n; unset($p, $n, $a, $b, $c);',
      '~1 4 5,3,4,1,2,6',
    ],
    [
      '$p = new Plain; $p->next = $p; $n = new Node(1); $a = new Plain; $a->next = $a; $b = new Plain; $b->next = $b; $n->o = $a; $n->p = $b; $m = new Node(2); $c = new Plain; $c->next = $c; $m->o = $c; $p->o = $n; $p->p = $m; unset($p, $n, $a, $b, $m, $c);',
      '~1 ~2 4 4,3,6,1,5,2',
    ],
    [
      '$z = new Node(0); $p = new Plain; $q = new Plain; $p->q = $q; $q->q = $p; $a = new Node(3); $a->o = $a; $b = new Node(4); $b->q = $b; unset($b, $a, $p, $q, $z);',
      '~0 ~3 ~4 4 4,5,3,2,1,6',
    ],
    [
      '$v1 = new Plain; $v2 = new Plain; $v4 = new Node(4); $v5 = new Plain; $v1->o = $v4; $v4->q = $v2; $v5->o = $v5; $v5->p = $v1; $v5->q = [$v2, $v2]; unset($v5, $v2, $v1, $v4);',
      '~4 3 4,2,1,3,5,6',
    ],
    [
      '$v1 = new Plain; $v2 = new Plain; $v4 = new Node(4); $v5 = new Plain; $v1->o = $v4; $v4->q = $v2; $v5->o = $v5; $v5->p = $v1; $v5->q = $v2; unset($v5, $v2, $v1, $v4);',
      '~4 2 4,2,1,3,5,6',
    ],
    [
      '$v0 = new Node(0); $v1 = new Node(1); $v2 = new Node(2); $v3 = new Plain; $v4 = new Node(4); $v5 = new Plain; $v6 = new Plain; $v0->o = $v1; $v0->p = $v5; $v0->q = $v6; $v1->o = [$v3, $v5]; $v2->p = $v5; $v2->q = $v0; $v3->o = $v5; $v3->p = [$v2, $v1]; $v4->p = $v6; $v5->o = [$v4, $v5]; $v6->o = [$v4, $v0]; $v6->p = [$v6, $v0]; $v6->q = $v3; unset($v4, $v3, $v1, $v6, $v5, $v2, $v0);',
      '~0 ~1 ~2 ~4 12 6,7,4,5,3,2',
    ],
  ]) {
    expect(
      run(`<?php
class Node { public $next; public $o; public $p; public $q; function __construct(public $n = 0) {} function __destruct() { echo "~{$this->n} "; } }
class Plain { public $next; public $o; public $p; public $q; }
${body}
echo gc_collect_cycles(), " ";
$ids = [];
for ($i = 0; $i < 6; $i++) { $k[] = new Plain; $ids[] = spl_object_id(end($k)); }
echo implode(",", $ids);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [container, expected] of [
    ['[]', '[4,[]]'],
    ['new ArrayObject', '[4,{}]'],
    ['new ArrayIterator', '[4,{}]'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = ${container};
$a['x'] = 3;
set_error_handler(function () use (&$a) { unset($a['x']); return true; });
$r = ($a['x'] =& f());
restore_error_handler();
echo json_encode([$r, $a]);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(
    run(String.raw`<?php
class Foo {}
$a = 1;
foreach ([
  fn() => assert(-$a instanceof Foo),
  fn() => assert((int)$a instanceof Foo),
  fn() => assert(@$a instanceof Foo),
  fn() => assert(++$a instanceof Foo),
] as $f) {
  try { $f(); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: `assert(-$a instanceof Foo)
assert((int)$a instanceof Foo)
assert(@$a instanceof Foo)
assert(++$a instanceof Foo)
`,
  });

  expect(
    run(String.raw`<?php
$o = new stdClass;
$b = 'x';
foreach ([
  fn() => assert(false && $o->{'a b'}),
  fn() => assert(false && A::{'a b'}()),
  fn() => assert(false && A::{'a'.$b}),
  fn() => assert(false && A::{1}),
] as $f) {
  try { $f(); } catch (AssertionError $e) { echo $e->getMessage(), "\n"; }
}
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: `assert(false && $o->{a b})
assert(false && A::{a b}())
assert(false && A::'a' . $b)
assert(false && A::1)
`,
  });

  for (const [unsetOrder, expected] of [
    ['unset($a, $c, $b);', '3|2,3,1'],
    ['unset($c, $b, $a);', '3|1,2,3'],
  ]) {
    expect(
      run(`<?php
class P { public $self; public $next; }
$a = new P; $b = new P; $c = new P;
$a->self = $a; $b->self = $b; $c->self = $c;
$a->next = $b; $c->next = $a;
${unsetOrder}
echo gc_collect_cycles(), '|';
$x = new P; $y = new P; $z = new P;
echo spl_object_id($x), ',', spl_object_id($y), ',', spl_object_id($z);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [container, assignOp] of [
    ['[]', '=&'],
    ['new ArrayObject', '=&'],
    ['new ArrayIterator', '=&'],
    ['[]', '='],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
class C { public string $x = "old"; }
class S { function __toString() { global $a, $other; $a[0] =& $other; return "3"; } }
function f() { return new S; }
$c = new C; $other = "other"; $a = ${container};
$a[0] =& $c->x;
$r = ($a[0] ${assignOp} f());
echo json_encode([$r, $c->x, $a[0] ?? null, $other]);
`)
    ).toMatchObject({ kind: 'executed', stdout: '["3","old","3","3"]' });
  }

  for (const [container, emptyJson] of [
    ['[]', '[]'],
    ['new ArrayObject', '{}'],
    ['new ArrayIterator', '{}'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
class C { public string $x = 'old'; }
class S { function __toString() { global $a; unset($a[0]); return '3'; } }
function f() { return new S; }
$c = new C; $a = ${container}; $a[0] =& $c->x;
$r = ($a[0] =& f());
echo json_encode([$r, $c->x, $a]);
`)
    ).toMatchObject({ kind: 'executed', stdout: `["3","3",${emptyJson}]` });

    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = ${container};
set_error_handler(function () use (&$a) { unset($a['x']); $a['z'] = 9; return true; });
$r = ($a['x'] =& f());
restore_error_handler();
echo json_encode([$r, $a]);
`)
    ).toMatchObject({ kind: 'executed', stdout: '[4,{"z":4}]' });
  }

  expect(
    run(`<?php
class P { public $x; }
$a0 = []; $a0[0] =& $a0; $a0[1] = new P;
$a1 = []; $a1[0] =& $a1; $a1[1] = new P;
unset($a1, $a0);
echo gc_collect_cycles(), '|';
$v = [];
for ($i = 0; $i < 2; $i++) { $v[] = new P; echo spl_object_id(end($v)), ','; }
`)
  ).toMatchObject({ kind: 'executed', stdout: '4|1,2,' });

  expect(
    run(`<?php
class P { public $a; public $b; }
$n0 = new P; $n1 = new P; $n2 = new P; $n3 = new P;
$n0->a = [[$n1]]; $n0->b = [$n3]; $n1->a = [[$n2]]; $n1->b = [$n2];
$n2->a = [$n2]; $n2->b = $n2; $n3->a = [$n0]; $n3->b = $n3;
unset($n1, $n2, $n0, $n3);
echo gc_collect_cycles(), '|';
$v = [];
for ($i = 0; $i < 4; $i++) { $v[] = new P; echo spl_object_id(end($v)), ','; }
`)
  ).toMatchObject({ kind: 'executed', stdout: '12|4,1,3,2,' });

  for (const [init, handler, expected] of [
    ['[]', '$a[] = 9;', '[4,[4,9]]'],
    ['[]', 'echo json_encode($a), ";";', '[null];[4,[4]]'],
    ['[4 => 1]', 'unset($a[array_key_last($a)]); $a[] = 9;', '[4,{"4":1,"5":4,"6":9}]'],
    ['["x" => 1]', 'unset($a[array_key_last($a)]); $a[] = 9;', '[4,{"x":1,"1":4}]'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = ${init};
set_error_handler(function () use (&$a) { ${handler} return true; });
$r = ($a[] =& f());
restore_error_handler();
echo json_encode([$r, $a]);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [unsetOrder, expected] of [
    ['unset($r0, $r1, $p1, $p0);', '4|2,1'],
    ['unset($r0, $r1, $p0, $p1);', '4|1,2'],
  ]) {
    expect(
      run(`<?php
class P { public $a; public $b; }
$p0 = new P; $r0 = [$p0];
$p1 = new P; $r1 = [$p1];
$p0->a = $r0; $p0->b = $p1;
$p1->a = $r1; $p1->b = $p0;
${unsetOrder}
echo gc_collect_cycles(), '|';
$x = new P; $y = new P;
echo spl_object_id($x), ',', spl_object_id($y);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [value, expected] of [
    ['new D', 'after;[{},9];drop;'],
    ['[new D]', 'after;[[{}],9];drop;'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
class D { function __destruct() { echo 'drop;'; } }
function f() { return ${value}; }
$a = [];
set_error_handler(function () use (&$a) { unset($a[0]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
echo 'after;', json_encode($a), ';';
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(
    run(`<?php
class D { function __destruct() { throw new Exception("from destructor"); } }
$x = new D;
set_exception_handler(function($e) { echo "handler: ", $e->getMessage(), "\n"; });
throw new Exception("first");
`)
  ).toMatchObject({ kind: 'executed', stdout: 'handler: first\nhandler: from destructor\n' });

  expect(
    run(`<?php
class D { function __destruct() { throw new Exception("dd"); } }
$x = new D;
set_exception_handler(function($e) { echo "h1: ", $e->getMessage(), "\n"; set_exception_handler(null); });
throw new Exception("first");
`)
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'h1: first\n\nFatal error: Uncaught Exception: dd in /main.php:2\nStack trace:\n#0 [internal function]: D->__destruct()\n#1 {main}\n  thrown in /main.php on line 2\n',
  });

  expect(
    run(`<?php
class D { function __destruct() { throw new Exception("dd"); } }
$x = new D;
set_exception_handler(function($e) { echo "h2: ", $e->getMessage(), "\n"; });
set_exception_handler(function($e) { echo "h1: ", $e->getMessage(), "\n"; restore_exception_handler(); restore_exception_handler(); });
throw new Exception("first");
`)
  ).toMatchObject({ kind: 'executed', stdout: 'h1: first\nh2: dd\n' });

  expect(
    run(`<?php
class D { function __construct(public $n) {} function __destruct() { throw new Exception("dd{$this->n}"); } }
$x = new D(1); $y = new D(2);
set_exception_handler(function($e) { echo "h: ", $e->getMessage(), "\n"; });
throw new Exception("first");
`)
  ).toMatchObject({ kind: 'executed', stdout: 'h: first\nh: dd2\nh: dd1\n' });

  for (const [init, expected] of [
    ['[0=>1,2=>2]', '2,2,4,0,0,4,0,3,|334995689'],
    ['[0=>1,3=>2]', '0,5,4,4,0,5,4,4,|957418556'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
function f() { return [4]; }
$a = ${init};
set_error_handler(function() use (&$a) { unset($a[array_key_last($a)]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
mt_srand(42);
for ($i = 0; $i < 8; $i++) echo array_rand($a), ",";
echo "|", mt_rand();
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [expr, expected] of [
    ['array_fill(1, 1, 1)', '1,1,1,1,1,1,1,1,|335047475'],
    ['array_fill(4, 8, 1)', '6,11,4,10,6,11,4,8,|335047475'],
    ['array_fill(4, 10, 1)', '8,9,4,12,4,12,12,7,|334995689'],
  ]) {
    expect(
      run(`<?php
$a = ${expr};
mt_srand(42);
for ($i = 0; $i < 8; $i++) echo array_rand($a), ",";
echo "|", mt_rand();
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [body, expected] of [
    [
      '$v0 = new Node(0); $v1 = new Node(1); $v2 = new Node(2); $v3 = new Plain; $v4 = new Plain; $v5 = new Node(5); $v6 = new Plain; $v7 = new Node(7); $v3->b = $v7; $v3->c = $v5; $v4->a = $v6; $v4->c = $v2; $v5->a = ["k" => $v4]; $v5->b = $v6; $v6->a = $v3; $v7->a = ["k" => $v0]; unset($v1, $v3, $v0, $v2, $v6, $v4); echo "[", gc_collect_cycles(), "] "; unset($v5, $v7);',
      '~1 [0] | ~5 ~7 ~2 ~0 9 0 6,7,4,8,1,5,3,2,9,10,11',
    ],
    [
      '$v0 = new Plain; $v1 = new Plain; $v2 = new Plain; $v3 = new Plain; $v4 = new Node(4); $v5 = new Plain; $v6 = new Node(6); $v7 = new Plain; $v0->c = $v0; $v2->a = $v4; $v2->b = [$v2, [$v7]]; $v3->a = [$v1, [$v5]]; $v3->b = $v3; $v4->c = [$v1, [$v0]]; unset($v6, $v0, $v1, $v3, $v7, $v4); echo "[", gc_collect_cycles(), "] "; $v2->a = null; unset($v2, $v5);',
      '~6 [3] ~4 | 5 0 1,3,8,6,5,2,4,7,9,10,11',
    ],
    [
      '$v0 = new Plain; $v1 = new Node(1); $v2 = new Plain; $v3 = new Plain; $v4 = new Plain; $v5 = new Plain; $v6 = new Plain; $v7 = new Node(7); $v0->c = [$v1, [$v3]]; $v4->b = [$v6, [$v4]]; $v4->c = [$v1, [$v0]]; $v7->a = [$v7, [$v6]]; $v7->c = $v0; unset($v3, $v2, $v6, $v4, $v5); echo "[", gc_collect_cycles(), "] "; unset($v1, $v0, $v7);',
      '[5] | ~1 ~7 9 0 8,1,4,2,7,5,6,3,9,10,11',
    ],
    [
      '$p = new Plain; $a = new Node(2); $b = new Node(3); $q = new Plain; $p->a = ["k" => $b]; $p->b = $q; $p->c = $p; $a->b = $b; $b->c = $a; unset($b, $p); echo "[", gc_collect_cycles(), "] "; unset($q, $a);',
      '[2] | ~2 ~3 2 0 2,3,4,1,5,6,7,8,9,10,11',
    ],
    [
      '$v0 = new Node(0); $v1 = new Plain; $v2 = new Node(2); $v3 = new Plain; $v4 = new Plain; $v5 = new Plain; $v0->b = $v1; $v1->a = $v2; $v2->a = $v0; $v2->b = ["k" => $v2]; $v3->c = $v1; $v4->b = ["k" => $v5]; $v4->c = [$v4, [$v1]]; $v5->a = $v3; $v5->c = [$v1, [$v2]]; unset($v4, $v1, $v5); echo "[", gc_collect_cycles(), "] "; unset($v3, $v0, $v2);',
      '[7] | ~0 ~2 4 0 3,1,2,4,5,6,7,8,9,10,11',
    ],
  ]) {
    expect(
      run(`<?php
class Node { public $a; public $b; public $c; function __construct(public $n = 0) {} function __destruct() { echo "~{$this->n} "; } }
class Plain { public $a; public $b; public $c; }
${body}
echo "| ", gc_collect_cycles(), " ", gc_collect_cycles(), " ";
$ids = [];
for ($i = 0; $i < 11; $i++) { $kk[] = new Plain; $ids[] = spl_object_id(end($kk)); }
echo implode(",", $ids);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(
    run(`<?php
class D { function __destruct() { echo "destroyed\n"; } }
$x = new D;
set_exception_handler(function($e) { echo "h\n"; exit(2); });
throw new Exception("first");
`)
  ).toMatchObject({ kind: 'executed', stdout: 'h\ndestroyed\n' });

  for (const [pattern, subject, expected] of [
    ['(?<=([ab]){2})c', 'abc', '[["c",2],["b",1]]'],
    ['(?<=(?<n>[ab]){2})c', 'bac', '{"0":["c",2],"n":["a",1],"1":["a",1]}'],
  ]) {
    expect(
      run(`<?php preg_match('/${pattern}/', '${subject}', $m, PREG_OFFSET_CAPTURE); echo json_encode($m);`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [initial, expected] of [
    ['[]', '[4,9]:1;[]:0;'],
    ['[1,2]', '[1,2,4,9]:3;{"0":1,"1":2,"3":9}:2;'],
    ['[0=>1,3=>2]', '{"0":1,"3":2,"4":4,"5":9}:3;{"0":1,"3":2,"5":9}:2;'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = ${initial};
$k = count($a) ? array_key_last($a) + 1 : 0;
set_error_handler(function() use (&$a, $k) { unset($a[$k]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
echo json_encode($a), ':', count($a), ';';
unset($a[$k]);
echo json_encode($a), ':', count($a), ';';
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(
    run(`<?php
error_reporting(0);
class D { function __construct(public $n) {} function __destruct() { echo "drop{$this->n};"; } }
function f() { return 4; }
$a = [];
set_error_handler(function() use (&$a) { unset($a[0]); $a[] = new D("nine"); return true; });
$a[] =& f();
restore_error_handler();
unset($a[0]);
echo 'after;', count($a), ';', json_encode($a), ';', isset($a[1]) ? $a[1]->n : 'none', ';end;';
`)
  ).toMatchObject({ kind: 'executed', stdout: 'after;0;[];nine;end;dropnine;' });

  expect(
    run(`<?php
error_reporting(0);
function f() { return 4; }
$a = [1];
set_error_handler(function() use (&$a) { unset($a[array_key_last($a)]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
echo count($a), ';';
sort($a);
echo count($a), ':', json_encode($a), ';';
`)
  ).toMatchObject({ kind: 'executed', stdout: '2;2:[1,4,9];' });
});

test('preserves GC root buffer order and count across multiple gc_collect_cycles() calls', () => {
  for (const [body, expected] of [
    [
      '$v0 = new Plain; $v1 = new Node(1); $v2 = new Plain; $v3 = new Plain; $v4 = new Node(4); $v5 = new Plain; $v6 = new Node(6); $v0->c = $v0; $v2->a = $v6; $v2->c = [$v4, [$v2]]; $v5->a = $v6; $v5->b = $v4; $v5->c = $v5; unset($v5, $v1, $v0); echo "[", gc_collect_cycles(), "] "; unset($v6, $v4, $v3, $v2);',
      '~1 [2] | ~4 ~6 3 0 3,5,7,4,6,1,2,8,9',
    ],
    [
      '$v0 = new Plain; $v1 = new Node(1); $v2 = new Plain; $v3 = new Plain; $v4 = new Plain; $v5 = new Plain; $v6 = new Node(6); $v7 = new Plain; $v0->c = $v1; $v1->b = $v3; $v2->a = $v6; $v2->c = $v2; $v3->b = $v1; $v6->b = ["k" => $v7]; $v7->c = [$v7, [$v5]]; unset($v3); unset($v1, $v5, $v6, $v2, $v7, $v4); echo "[", gc_collect_cycles(), "] "; $w1 = new Plain; unset($v0);',
      '[~6 5] | ~1 2 0 2,4,1,6,3,7,5,9,10',
    ],
    [
      '$v0 = new Plain; $v1 = new Node(1); $v2 = new Plain; $v3 = new Plain; $v4 = new Plain; $v2->c = $v4; $v3->a = $v2; $v3->b = $v4; $v3->c = $v3; $v4->a = $v2; unset($v3, $v0, $v2); unset($v1); $t1 = new Plain; $t1->a = $t1; unset($t1); echo "[", gc_collect_cycles(), "] "; $w1 = new Plain; unset($v4);',
      '~1 [2] | 2 0 5,3,2,1,6,7,8,9,10',
    ],
    [
      '$p = new Plain; $a = new Node(2); $b = new Node(3); $q = new Plain; $p->a = ["k" => $b]; $p->b = $q; $p->c = $p; $a->b = $b; $b->c = $a; unset($b, $p); echo "[", gc_collect_cycles(), "] "; unset($q, $a);',
      '[2] | ~2 ~3 2 0 2,3,4,1,5,6,7,8,9',
    ],
    [
      '$v0 = new Plain; $v1 = new Plain; $v2 = new Node(2); $v3 = new Node(3); $v4 = new Node(4); $v5 = new Node(5); $v6 = new Node(6); $v7 = new Plain; $v8 = new Plain; $v9 = new Node(9); $v1->a = $v2; $v2->a = ["k" => $v6]; $v2->c = $v9; $v5->a = [$v3, [$v7]]; $v6->b = $v5; $v6->c = $v1; $v7->a = $v9; $v7->b = [$v0, [$v5]]; unset($v1, $v2, $v7, $v0, $v9, $v6); echo "[", gc_collect_cycles(), "] "; $w0 = new Plain; echo spl_object_id($w0), " "; unset($v5); unset($v4, $v3, $v8);',
      '[~2 ~6 4] 3 ~4 | ~5 ~9 ~3 9 0 6,8,1,10,4,9,5,7,2',
    ],
  ]) {
    expect(
      run(`<?php
class Node { public $a; public $b; public $c; function __construct(public $n = 0) {} function __destruct() { echo "~{$this->n} "; } }
class Plain { public $a; public $b; public $c; }
${body}
echo "| ", gc_collect_cycles(), " ", gc_collect_cycles(), " ";
$ids = [];
for ($i = 0; $i < 9; $i++) { $kk[] = new Plain; $ids[] = spl_object_id(end($kk)); }
echo implode(",", $ids);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('normalizes retained undefined-slot storage across array_multisort, copy, and insertion', () => {
  for (const op of ['array_multisort($a);', '$b = range(1, count($a)); array_multisort($a, $b);']) {
    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = [1, 2];
set_error_handler(function() use (&$a) { unset($a[array_key_last($a)]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
echo count($a), ';';
${op}
echo count($a), ':', json_encode($a), ';';
`)
    ).toMatchObject({ kind: 'executed', stdout: '3;3:[1,2,4];' });
  }

  for (const [op, expected] of [
    ['$b = $a; $b[1] = 7;', '0:[]:9;1:{"1":7}:7'],
    ['$b = $a; unset($b[1]);', '0:[]:9;0:[]:null'],
    ['$b = $a; $b[] = 7;', '0:[]:9;1:{"2":7}:null'],
    ['$a[1] = 7;', '0:[]:7;'],
    ['$a[0] = 7;', '1:[7]:null;'],
    ['$a["x"] = 7;', '1:{"x":7}:null;'],
    ['$a[2] = 7;', '1:{"1":9,"2":7}:9;'],
  ]) {
    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = [];
set_error_handler(function() use (&$a) { unset($a[0]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
unset($a[0]);
${op}
echo count($a), ':', json_encode($a), ':', json_encode($a[1] ?? null), ';';
if (isset($b)) echo count($b), ':', json_encode($b), ':', json_encode($b[1] ?? null);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const value of ['new D', '[new D]']) {
    for (const [op, expected] of [
      ['$a[0] = 7;', 'before;after;1:[7];end;drop;'],
      ['$a["x"] = 7;', 'before;after;1:{"x":7};end;drop;'],
      ['$a[8] = 7;', 'before;after;1:{"8":7};end;drop;'],
    ]) {
      expect(
        run(`<?php
error_reporting(0);
class D { function __destruct() { echo 'drop;'; } }
function f() { return 4; }
$a = [];
set_error_handler(function() use (&$a) { unset($a[0]); $a[] = ${value}; return true; });
$a[] =& f();
restore_error_handler();
unset($a[0]);
echo 'before;';
${op}
echo 'after;', count($a), ':', json_encode($a), ';end;';
`)
      ).toMatchObject({ kind: 'executed', stdout: expected });
    }
  }

  for (const [size, key, expected] of [
    [0, 0, '2:[7,8]'],
    [2, 0, '2:[7,8]'],
    [2, 1, '2:{"1":7,"2":8}'],
    [2, 2, '2:{"2":7,"3":8}'],
  ] as const) {
    const init = size ? `range(1, ${size})` : '[]';
    expect(
      run(`<?php
error_reporting(0);
function f() { return 4; }
$a = ${init};
set_error_handler(function() use (&$a) { unset($a[array_key_last($a)]); $a[] = 9; return true; });
$a[] =& f();
restore_error_handler();
for ($i = 0; $i <= ${size}; $i++) unset($a[$i]);
$b = $a;
$b[${key}] = 7;
$b[] = 8;
echo count($b), ':', json_encode($b);
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('reports JIT stack limit exhaustion on long subjects with quantified groups and accurate rows for first-statement syntax errors', () => {
  expect(
    run(`<?php
var_dump(preg_match('/^(?:a|b)*$/', str_repeat('a', 5000)), preg_last_error_msg());
var_dump(preg_match('/^(?:a|b)*$/', str_repeat('a', 10000)), preg_last_error_msg());
`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'int(1)\nstring(8) "No error"\nbool(false)\nstring(25) "JIT stack limit exhausted"\n',
  });

  for (const source of [
    '<?php\nfor ($i = 0; $i < 3 $i++) {}\necho 1;\necho 2;\n',
    '<?php\ntry { } catch { }\necho 1;\necho 2;\n',
    '<?php\n$f = fn($x) => { return $x; };\necho 1;\necho 2;\n',
  ]) {
    expect(run(source)).toMatchObject({ kind: 'compileError', diagnostics: [expect.objectContaining({ row: 1 })] });
  }
});

test('rejects unsupported functions without spurious undefined-variable warnings on out-parameters', () => {
  expect(run('<?php fscanf(STDIN, "%d", $n); echo $n;')).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: '標準入力の読み込み（fscanf）は、この採点環境では使えません。',
  });
  expect(run('<?php exec("ls", $out, $rc);')).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: '外部コマンドの実行（exec）は、この採点環境では使えません。',
  });
});

test('reaches the shared 512-frame recursion limit under the default host stack', () => {
  expect(
    run('<?php function s(int $n): int { if ($n == 0) return 0; return $n + s($n - 1); } echo s(510);')
  ).toMatchObject({ kind: 'executed', stdout: '130305' });
  expect(run('<?php function s($n) { return $n == 0 ? 0 : $n + s($n - 1); } echo s(510);')).toMatchObject({
    kind: 'executed',
    stdout: '130305',
  });
  expect(run('<?php function s($n) { return $n == 0 ? 0 : $n + s($n - 1); } echo s(512);')).toMatchObject({
    kind: 'executed',
    stdout: expect.stringContaining('Allowed memory size'),
  });
});

test('matches PHP retained-empty searches, equality, removals, transforms, iterator spread keys, and class/object rules', () => {
  const retainedPrefix = `error_reporting(0); function f() { return 4; } $a = []; set_error_handler(function() use (&$a) { unset($a[0]); $a[] = 9; return true; }); $a[] =& f(); restore_error_handler(); unset($a[0]);`;

  // r1466 + r1467: search operand direction and equality specialization
  expect(
    run(`<?php ${retainedPrefix}
echo json_encode([in_array($a, [[]], false), in_array($a, [[]], true), array_search($a, [[]], false), array_keys([[]], $a, true), [] === $a, [] == $a, [] !== $a, ($b = []) === $a]);
$b = []; echo json_encode([$b === $a, $b == $a]);`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '[false,false,false,[],false,false,true,false][true,true]',
  });

  // r1468 + r1470: pop/shift and read/transform fast paths on logically empty retained arrays
  expect(
    run(`<?php ${retainedPrefix}
echo json_encode([array_pop($a), array_shift($a), count($a), $a[1], array_values($a), array_keys($a), array_chunk($a, 1), array_combine($a, $a), array_sum($a), array_product($a), array_filter($a), array_reduce($a, fn($x, $y) => $x + $y, 0), array_any($a, fn($x) => true), array_all($a, fn($x) => false), array_find($a, fn($x) => true), array_find_key($a, fn($x) => true)]);
$n = 0; array_map(function($x) use (&$n) { $n++; return $x; }, $a); echo ":$n:", $a[1];`)
  ).toMatchObject({
    kind: 'executed',
    stdout: '[null,null,0,9,[],[],[],[],0,1,[],0,false,true,null,null]:0:9',
  });

  // r1469: Traversable unpacking normalizes canonical numeric string keys
  expect(
    run(`<?php
class I implements Iterator { public $i = 0; function rewind(): void { $this->i = 0; } function valid(): bool { return $this->i < 1; } function current(): mixed { return 7; } function key(): mixed { return "0"; } function next(): void { $this->i++; } }
$a = [...new I]; $a[] = 8; echo json_encode($a);`)
  ).toMatchObject({ kind: 'executed', stdout: '[7,8]' });

  // r1471: final private constructor cannot be overridden
  expect(
    run(
      '<?php class A { final private function __construct() {} } class B extends A { public function __construct() {} }'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: expect.stringContaining('Cannot override final method A::__construct()'),
  });

  // r1472: self-bind sets isRef for shutdown order
  expect(
    run(
      String.raw`<?php class D { public $n; function __construct($n) { $this->n = $n; } function __destruct() { echo "d{$this->n} "; } } $z = new D(1); $b = new D(3); $b = &$b; $c = new D(6); echo "END\n";`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'END\nd6 d1 d3 ' });

  // r1473: dynamic properties destroyed before declared properties
  expect(
    run(
      '<?php error_reporting(0); class D { public $o = null; public $n; function __construct($n) { $this->n = $n; } function __destruct() { echo "d{$this->n} "; } } $a = new D(0); $a->o = new D(1); $a->dyn = new D(2); $a = null;'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'd0 d2 d1 ' });

  // r1474 & r1481: static access to private/protected instance property (own or inherited) reports visibility error
  expect(
    run(
      '<?php class A { private $p = 1; protected $q = 2; public $r = 3; } class B extends A { private $bp = 7; } class C extends B {} foreach ([["A","p"], ["A","q"], ["A","r"], ["B","p"], ["B","q"], ["C","p"], ["C","bp"], ["C","q"]] as [$c, $m]) { try { echo $c::$$m; } catch (Error $e) { echo $e->getMessage(), ";"; } }'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'Cannot access private property A::$p;Cannot access protected property A::$q;Access to undeclared static property A::$r;Cannot access private property B::$p;Cannot access protected property B::$q;Cannot access private property C::$p;Cannot access private property C::$bp;Cannot access protected property C::$q;',
  });

  // r1480 & r1485: array_map preserves single-array identity and physical column values on retained-empty arrays
  expect(
    run(
      '<?php error_reporting(0); function f() { return 4; } $a = []; set_error_handler(function() use (&$a) { unset($a[0]); $a[] = 9; return true; }); $a[] = &f(); restore_error_handler(); unset($a[0]); $b = array_map(null, $a); $c = array_map(null, $a); $c[] = 8; echo count($b), ":", json_encode($b), ":", $b[1] ?? "missing", "|", json_encode($c), "|", json_encode(array_map(null, $a, [1])), "|", json_encode(array_map(null, $a, []));'
    )
  ).toMatchObject({ kind: 'executed', stdout: '0:[]:9|{"2":8}|[[9,1]]|[]' });

  // r1475 & r1479: helper method called from property hook invokes hook normally while direct hook writes access backing storage
  expect(
    run(
      '<?php class C { public $n = 0; public int $x { get { return $this->read(); } } function read() { return ++$this->n < 2 ? $this->x : 99; } } $c = new C; echo $c->x, ":", $c->n;'
    )
  ).toMatchObject({ kind: 'executed', stdout: '99:2' });
  for (const [body, expected] of [
    [
      'class C { public array $x = [] { get { $this->x[] = 1; return $this->x; } } } $c = new C; echo json_encode($c->x);',
      '[1]',
    ],
    [
      'class C { public array $x = [] { get { return $this->x; } set { $this->x[] = $value; } } } $c = new C; $c->x = [7]; echo json_encode($c->x);',
      '[[7]]',
    ],
    [
      'class C { public array $x = [1] { get { $this->x[0]++; return $this->x; } } } $c = new C; echo json_encode($c->x);',
      '[2]',
    ],
    [
      'class C { public array $x = [1] { get { unset($this->x[0]); return $this->x; } } } $c = new C; echo json_encode($c->x);',
      '[]',
    ],
  ]) {
    expect(run(`<?php ${body}`)).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('chains return-expression cleanup exceptions', () => {
  for (const [expression, expected] of [
    ['[new D, throw new Exception("body")]', 'drop;destructor;body;'],
    ['(new D) + (throw new Exception("body"))', 'drop;destructor;body;'],
    ['(new D)->bad(throw new Exception("body"))', 'drop;destructor;Call to undefined method D::bad();'],
  ]) {
    expect(
      run(`<?php
class D { function __destruct() { echo "drop;"; throw new Exception("destructor"); } }
function f() { return ${expression}; }
try { f(); } catch (Throwable $e) { while ($e) { echo $e->getMessage(), ";"; $e = $e->getPrevious(); } }
`)
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  for (const [context, expected] of [
    [
      'try { return [new D, exit("exit;")]; } catch (Throwable $e) { echo "inner;" . $e->getMessage(); }',
      'exit;drop;inner;destructor',
    ],
    [
      'foreach ([1] as $x) { try { return [new D, exit("exit;")]; } catch (Throwable $e) { echo "inner;" . $e->getMessage(); } }',
      'exit;drop;inner;destructor',
    ],
    ['try { return [new D, exit("exit;")]; } finally { echo "finally;"; }', 'exit;drop;outer;destructor'],
    [
      'try { return [new D, exit("exit;")]; } catch (TypeError $e) { echo "wrong;"; } finally { echo "finally;"; }',
      'exit;drop;finally;outer;destructor',
    ],
    [
      'try { throw new Exception("initial"); } catch (Exception $e) { return [new D, exit("exit;")]; } finally { echo "finally;"; }',
      'exit;drop;outer;destructor',
    ],
    [
      'try { try { return [new D, exit("exit;")]; } catch (TypeError $e) { echo "wrong;"; } } finally { echo "outer-fin;"; }',
      'exit;drop;outer-fin;outer;destructor',
    ],
  ]) {
    expect(
      run(
        `<?php class D { function __destruct() { echo "drop;"; throw new Exception("destructor"); } } function f() { ${context} } try { f(); } catch (Throwable $e) { echo "outer;" . $e->getMessage(); }`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(
    run(
      '<?php class E extends Exception { function __destruct() { echo "drop;"; throw new Exception("cleanup"); } } function f() { try { throw new E("discarded"); } finally { return 3; } } try { f(); } catch (Throwable $e) { echo $e->getMessage(), ";", $e->getPrevious() === null ? "null" : "chained"; }'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'drop;cleanup;null' });

  for (const returned of ['new D', '[new D]']) {
    expect(
      run(
        `<?php class E extends Exception { function __destruct() { echo "E;"; throw new Exception("cleanup"); } } class D { function __destruct() { echo "D;"; } } function f() { try { try { throw new E("discarded"); } finally { return ${returned}; } } catch (Throwable $e) { echo "caught:", $e->getMessage(), ";"; } echo "after;"; } f(); echo "caller;";`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'E;D;caught:cleanup;after;caller;' });
  }
});

test('reaches maxCallDepth across recursion shapes', () => {
  const sum505 = String((505 * 506) / 2);
  for (const [source, expected] of [
    [
      '<?php class C { public function s(int $n): int { if ($n == 0) return 0; return $n + $this->s($n - 1); } } echo (new C())->s(505);',
      sum505,
    ],
    [
      '<?php class C { public static function s(int $n): int { if ($n == 0) return 0; return $n + self::s($n - 1); } } echo C::s(505);',
      sum505,
    ],
    ['<?php $s = function (int $n) use (&$s): int { return $n == 0 ? 0 : $n + $s($n - 1); }; echo $s(505);', sum505],
    [
      '<?php function s(int $n): int { $t = $n; for ($i = 0; $i < 1; $i++) { if ($n > 0) { $t += s($n - 1); } } return $t; } echo s(505);',
      sum505,
    ],
    [
      '<?php function s(int $n): int { foreach ([1] as $one) { switch (true) { case $n > 0: return $n + s($n - 1); default: return 0; } } return -1; } echo s(505);',
      sum505,
    ],
    ['<?php function s(int $n): int { try { return $n == 0 ? 0 : $n + s($n - 1); } finally {} } echo s(505);', sum505],
    ['<?php function f($n) { if ($n <= 0) return 0; return array_map("f", [$n - 1])[0] + 1; } echo f(505);', '505'],
    ['<?php function f($n) { if ($n <= 0) return 0; return call_user_func("f", $n - 1) + 1; } echo f(505);', '505'],
    [
      '<?php class A { public $c; function __construct($n) { if ($n > 0) $this->c = new A($n - 1); } } new A(505); echo "ok";',
      'ok',
    ],
    [
      '<?php function s(int $n): int { return match (true) { $n == 0 => 0, default => $n + s($n - 1) }; } echo s(505);',
      sum505,
    ],
    [
      '<?php class C { public function __get($k) { $n = (int)substr($k, 1); return $n == 0 ? 0 : $n + $this->{"p" . ($n - 1)}; } } echo (new C)->{"p505"};',
      sum505,
    ],
    [
      '<?php class A { function f($n) { return $n <= 0 ? 0 : array_sum(array_map([$this, "f"], [$n - 1])) + 1; } } echo (new A)->f(505);',
      '505',
    ],
    [
      '<?php function s(int $n): int { if ($n == 0) return 0; $a = [1, 2]; $r = 0; usort($a, function ($x, $y) use ($n, &$r) { if ($r === 0) $r = $n + s($n - 1); return $x <=> $y; }); return $r; } echo s(250);',
      String((250 * 251) / 2),
    ],
  ]) {
    expect(run(source)).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('dumping deeply nested arrays ends with the memory limit', () => {
  for (const call of ['print_r($a);', 'var_export($a);', 'json_encode($a, 0, 1000000);', 'http_build_query($a);']) {
    const result = run(`<?php $a = []; for ($i = 0; $i < 4000; $i++) { $a = [$a]; } ${call}`);
    expect(result).toMatchObject({ kind: 'executed' });
    expect(result.kind === 'executed' ? result.stdout : '').toContain('Allowed memory size');
  }
});

test('casts NAN to an object with the PHP warning and allocation order', () => {
  expect(run('<?php\nvar_dump((object)NAN);')).toMatchObject({
    kind: 'executed',
    stdout:
      '\nWarning: unexpected NAN value was coerced to object in /main.php on line 2\nobject(stdClass)#1 (1) {\n  ["scalar"]=>\n  float(NAN)\n}\n',
  });
  expect(
    run(`<?php
$n = NAN;
set_error_handler(function ($errno, $message) {
  global $fromHandler;
  $fromHandler = new stdClass;
  echo $message, ";";
  return true;
});
$converted = (object)$n;
var_dump(is_nan($converted->scalar), spl_object_id($converted) < spl_object_id($fromHandler));
var_dump(is_infinite(((object)INF)->scalar), ((object)1.5)->scalar);`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'unexpected NAN value was coerced to object;bool(true)\nbool(true)\nbool(true)\nfloat(1.5)\n',
  });
});

test('traces values beyond JSON across deep recursion', () => {
  const bigTraceSource = `<?php
$big = PHP_INT_MAX;
$inf = INF;
$nan = NAN;
function s(int $n): int {
  return match (true) {
    $n == 0 => 0,
    default => $n + s($n - 1),
  };
}
$r = s(450);
echo $r;
`;
  const traced = traceProgram('php', bigTraceSource, bigTraceSource);
  expect(traced.stdout).toBe('101475');
  expect(traced.finalVars.$big).toBe(9_223_372_036_854_775_807n);
  expect(traced.finalVars.$inf).toBe(Number.POSITIVE_INFINITY);
  expect(Number.isNaN(traced.finalVars.$nan)).toBe(true);
});

test('rejects whole-table reads of $GLOBALS and get_defined_vars()', () => {
  for (const snippet of [
    'print_r($GLOBALS);',
    'echo count($GLOBALS);',
    'var_dump(array_key_exists("_SERVER", $GLOBALS));',
    'foreach ($GLOBALS as $k => $v) {}',
    'function f() { echo count($GLOBALS); } f();',
    'print_r(array_keys(get_defined_vars()));',
  ]) {
    const result = run(`<?php $x = 1; ${snippet}`);
    expect(result).toMatchObject({ kind: 'executed' });
    expect(result.kind === 'executed' ? result.uncaughtException : '').toContain('は、この採点環境では使えません。');
  }
  expect(
    run('<?php $x = 5; function f() { $a = 1; return $GLOBALS["x"] + count(get_defined_vars()); } echo f();')
  ).toMatchObject({
    kind: 'executed',
    stdout: '6',
    uncaughtException: undefined,
  });
});

test('keeps PHP results for seeded selection, recursive static initializers, destruction order and returned references', () => {
  expect(
    run(
      '<?php mt_srand(42); $a = range(0, 9999); $sum = 0; for ($i = 0; $i < 7000; $i++) $sum += array_rand($a); echo $sum;'
    )
  ).toMatchObject({ kind: 'executed', stdout: '34849407' });

  expect(
    run(
      `<?php
class D { function __construct(public $n) {} function __destruct() { echo 'drop:', $this->n, ';'; } }
function f($n) { static $x = $n ? f(0) : new D('inner'); echo 'f:', $n, ':', $x->n, ';'; return $n ? null : new D('outer'); }
f(1); echo 'after;'; f(2); echo 'end;';`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'f:0:inner;drop:outer;f:1:inner;after;f:2:inner;end;drop:inner;' });

  const poolSource = `<?php
class Res { function __construct(public $n) {} function __destruct() { echo "closing {$this->n}\\n"; echo "closed {$this->n}\\n"; } }
class Pool { public $items = []; function add($r) { $this->items[] = $r; } }
$pool = new Pool; $pool->add(new Res(1)); $pool->add(new Res(2));
echo "done\\n";`;
  expect(traceProgram('php', poolSource, poolSource).stdout).toBe('done\nclosing 1\nclosed 1\nclosing 2\nclosed 2\n');

  expect(
    run(
      `<?php
class E extends Exception { function __destruct() { echo 'E;'; throw new Exception('cleanup'); } }
class D { function __destruct() { echo 'D;'; } }
function &g() { $x = new D; return $x; }
function &f() { try { try { throw new E; } finally { return g(); } } catch (Throwable $e) { echo 'caught:', $e->getMessage(), ';'; } echo 'after;'; $done = null; return $done; }
f(); echo 'caller;';`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'E;D;caught:cleanup;after;caller;' });

  expect(
    run(
      `<?php
class R { function __construct(public $n) {} function __destruct() { echo "close {$this->n}\\n"; } }
$s = new SplStack; $s->push(new R(1)); $s->push(new R(2));
$f = new SplFixedArray(2); $f[0] = new R(3); $f[1] = new R(4);
$s = null; echo "mid\\n"; $f = null;`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'close 2\nclose 1\nmid\nclose 4\nclose 3\n' });

  expect(
    run(
      `<?php $x = 1; function &f(...$v) { global $x; return $x; } $a = array_map('f', [1]); $b = $a; $a[0] = 2; echo json_encode([$a, $b, $x]);`
    )
  ).toMatchObject({ kind: 'executed', stdout: '[[2],[2],2]' });

  expect(
    run(
      `<?php class D { function __construct(public $n) {} function __destruct() { echo 'drop:', $this->n, ';'; } }
$x = null; function &f($n, ...$rest) { global $x; $x = new D($n); echo 'mapped:', $n, ';'; return $x; }
$a = array_map('f', [1, 2]); echo 'after:', json_encode($a), ';';`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'mapped:1;drop:1;mapped:2;after:[{"n":2},{"n":2}];drop:2;' });

  expect(
    run(
      `<?php class D { function __construct(public $n) {} function __destruct() { echo 'drop:', $this->n, ';'; } }
function f($n, ...$rest) { if ($n === 2) throw new Exception('callback'); return [new D($n)]; }
try { array_map('f', [1, 2], [3, 4]); } catch (Throwable $e) { echo 'caught;'; } echo 'end;';`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'drop:1;caught;end;' });

  expect(
    run(
      `<?php $x = 1; function &f($n) { global $x; if ($n === 3) throw new Exception('stop'); return $x; }
try { array_map('f', [1, 2, 3]); } catch (Throwable $e) {}
$a = [&$x]; $b = $a; $a[0] = 2; echo json_encode([$a, $b, $x]);`
    )
  ).toMatchObject({ kind: 'executed', stdout: '[[2],[2],2]' });

  expect(
    run(
      `<?php $a = ['x' => 1, 2, 3, 4]; array_shift($a); mt_srand(42); $out = []; for ($i = 0; $i < 10; $i++) $out[] = array_rand($a); echo json_encode([$out, mt_rand()]);`
    )
  ).toMatchObject({ kind: 'executed', stdout: '[[1,2,1,1,2,1,0,1,1,1],986229477]' });

  expect(
    run(
      `<?php $a = []; for ($i = 0; $i < 20000; $i++) $a['task' . $i] = $i; $sum = 0; while ($a) $sum += array_shift($a); echo $sum;`
    )
  ).toMatchObject({ kind: 'executed', stdout: '199990000' });

  expect(run('<?php echo 2; ?>\n\n')).toMatchObject({ kind: 'executed', stdout: '2\n' });
  expect(run('<?= 2 ?>\n \n')).toMatchObject({ kind: 'executed', stdout: '2 \n' });

  expect(
    run(
      `<?php $x = 1;
class I implements Iterator {
  public $i = 0;
  function rewind(): void { $this->i = 0; }
  function valid(): bool { return $this->i < 1; }
  function &current(): mixed { global $x; echo 'current;'; return $x; }
  function key(): mixed { global $x; $x = 2; echo 'key;'; return 0; }
  function next(): void { $this->i++; }
}
foreach (new I as $k => $v) echo 'v:', $v, ';';
foreach (new IteratorIterator(new I) as $k => $v) echo 'v:', $v, ';';
foreach (new CachingIterator(new I, 0) as $k => $v) echo 'v:', $v, ';';`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'current;key;v:2;current;key;v:2;current;key;v:2;' });

  expect(
    run(
      `<?php $x = 1;
class I implements Iterator {
  public $i = 0;
  function rewind(): void { $this->i = 0; }
  function valid(): bool { return $this->i < 1; }
  function &current(): mixed { global $x; return $x; }
  function key(): mixed { return 0; }
  function next(): void { $this->i++; }
}
foreach (new I as $v) { break; }
$it = new IteratorIterator(new I); $it->rewind(); unset($it);
$a = [&$x]; unset($x); $b = $a; $a[0] = 2; echo json_encode([$a, $b]);`
    )
  ).toMatchObject({ kind: 'executed', stdout: '[[2],[1]]' });

  expect(
    run(
      `<?php
try { key_exists([], []); } catch (Error $e) { echo $e->getMessage(), "\\n"; }
try { sizeof([], 99); } catch (Error $e) { echo $e->getMessage(), "\\n"; }`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'key_exists(): Argument #1 ($key) must be a valid array offset type\nsizeof(): Argument #2 ($mode) must be either COUNT_NORMAL or COUNT_RECURSIVE\n',
  });

  expect(
    run(
      `<?php
try { range(1, 1073741824); } catch (ValueError $e) { echo $e->getMessage(), "\\n"; }
try { range(0.5, 1e16, 2); } catch (ValueError $e) { echo $e->getMessage(), "\\n"; }`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'The supplied range exceeds the maximum array size by 0 elements: start=1, end=1073741824, step=1. Calculated size: 1073741823. Maximum size: 1073741824.\nThe supplied range exceeds the maximum array size by 4999998926258177.0 elements: start=0.5, end=10000000000000000.0, step=2.0. Max size: 1073741824\n',
  });

  expect(
    run(
      `<?php
var_dump(range(0, null));
try { range(0.1, null, 1); } catch (ValueError $e) { echo explode("\\n", $e->getTraceAsString())[0], "\\n"; }`
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nDeprecated: range(): Passing null to parameter #2 ($end) of type string|int|float is deprecated in /main.php on line 2\narray(1) {\n  [0]=>\n  int(0)\n}\n\nDeprecated: range(): Passing null to parameter #2 ($end) of type string|int|float is deprecated in /main.php on line 3\n#0 /main.php(3): range(0.1, 0, 1)\n',
  });

  expect(
    run(
      `<?php $a = range(0, 8); $a["a"] = 3; array_splice($a, 1, 3, [7]); unset($a[4]); $a[-2] = 7; mt_srand(0); var_dump(array_rand($a));`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'int(5)\n' });
  expect(
    run(
      `<?php $a = [0, 1, 2, 3, 4, 5, 6, 7, 8]; array_splice($a, 1, 3, [7]); $a["a"] = 3; unset($a[4]); $a[8] = 7; mt_srand(0); var_dump(array_rand($a));`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'int(5)\n' });
  expect(
    run(
      `<?php $a = [5 => 1, 2, 3]; $a[] = 30; $a[] = 12; $a[] = 23; $a[3] = 27; $a[] = 66; unset($a[7]); $a["k4"] = 82; for ($s = 0; $s < 14; $s++) { mt_srand($s); echo array_rand($a), " "; }`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'k4 9 5 9 9 k4 k4 5 5 6 10 5 3 9 ' });
  for (const sort of ['ksort', 'asort']) {
    expect(
      run(`<?php $a = range(0, 7); ${sort}($a); unset($a[4]); $a["a"] = 3; mt_srand(0); var_dump(array_rand($a));`)
    ).toMatchObject({ kind: 'executed', stdout: 'int(5)\n' });
  }

  expect(run('<?php $a = [1]; $r = &$a; $r[0] = $a; unset($a, $r); var_dump(gc_collect_cycles());')).toMatchObject({
    kind: 'executed',
    stdout: 'int(1)\n',
  });
  for (const [prelude, subject, expected] of [
    ['', '[1, 2]', 'int(10000)\n'],
    ['', '[[1]]', 'int(1)\n'],
    ['', '[[]]', 'int(10000)\n'],
    ['function f() { static $s = [1]; return $s; }', 'f()', 'int(1)\n'],
    ['function f($x = [1]) { return $x; }', 'f()', 'int(1)\n'],
    ['class K { const C = [1]; }', 'K::C', 'int(10000)\n'],
  ]) {
    expect(
      run(
        `<?php ${prelude} for ($i = 0; $i < 10000; $i++) { $a = ${subject}; $a[0] = &$a; unset($a); } var_dump(gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }

  expect(run('<?php\nswitch (1) { case 1: switch (2) { case 2: continue; } }\necho "done";')).toMatchObject({
    kind: 'executed',
    stdout:
      '\nWarning: "continue" targeting switch is equivalent to "break". Did you mean to use "continue 2"? in /main.php on line 2\ndone',
  });
});

test.each([
  '$c = [1]; $b = [$c]; unset($b);',
  '$c = [1]; $b = [[$c]]; $b = null;',
  '$c = [new stdClass]; $b = [$c]; unset($b);',
  '$c = [1]; $b = [[$c, new stdClass]]; unset($b);',
  '$c = [1]; $d = [2]; $b = [[$c], $d]; unset($b);',
])('dropped arrays preserve subsequent cycle destructor order: %s', (setup) => {
  expect(
    run(`<?php
class N {
  public $s;
  function __construct(public $id) {}
  function __destruct() { echo "d{$this->id};"; }
}
function makeCycle($id) {
  $x = new N($id);
  $y = new N($id + 1000);
  $x->s = $y;
  $y->s = $x;
  return [$y, new N($id + 2000)];
}
${setup}
$a = makeCycle(4);
$a = makeCycle(6);
echo gc_collect_cycles(), ";";`)
  ).toMatchObject({ kind: 'executed', stdout: 'd2004;d1004;d4;2;d6;d1006;d2006;' });
});

test.each([
  '$n = 1; $values = [$n]; foreach ($values as $v) { $values = 5; }',
  '$n = 1; $values = [$n]; foreach ($values as $v) { $values = 5; } unset($v);',
  'function iterate() { $n = 1; $values = [$n]; foreach ($values as $v) { $values = 5; } } iterate();',
])('cycle collection excludes a released foreach subject: %s', (iterate) => {
  expect(
    run(`<?php
class N {
  public $self;
  function __destruct() { echo "destroyed;"; }
}
function makeCycle() { $node = new N; $node->self = $node; }
makeCycle();
${iterate}
echo gc_collect_cycles(), ";", gc_collect_cycles(), ";";`)
  ).toMatchObject({ kind: 'executed', stdout: 'destroyed;1;0;' });
});

test("gc_collect_cycles() reruns over what destructors create and leaves out a resurrected receiver's data", () => {
  for (const [action, expected] of [
    ['$x = new stdClass; $x->self = $x; unset($x); $this->a = [];', 'int(2)\nint(0)\nint(2)\n'],
    ['$this->a["tail"] = new stdClass;', 'int(3)\nint(0)\nint(1)\n'],
  ]) {
    expect(
      run(
        `<?php class D { public $a; function __destruct() { ${action} } } $o = new D; $a = [$o]; $o->a = $a; unset($o, $a); var_dump(gc_collect_cycles(), gc_collect_cycles(), spl_object_id(new stdClass));`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
  for (const shape of ['[$o]', '[[$o]]']) {
    expect(
      run(
        `<?php class D { public $a; function __destruct() { global $saved; $saved = $this; $this->a = []; } } $o = new D; $a = ${shape}; $o->a = $a; unset($o, $a); var_dump(gc_collect_cycles(), gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'int(0)\nint(0)\n' });
  }
});

test('gc_collect_cycles() runs the destructors of cyclic objects destructors create and counts them next time', () => {
  for (const [child, expected] of [
    ['', 'E;int(1)\nint(1)\nint(0)\n'],
    ['$e->c = new stdClass;', 'E;int(1)\nint(2)\nint(0)\n'],
    ['$e->c = [new stdClass];', 'E;int(1)\nint(3)\nint(0)\n'],
  ]) {
    expect(
      run(
        `<?php class E { public $self; public $c; function __destruct() { echo "E;"; } } class D { public $self; function __destruct() { $e = new E; $e->self = $e; ${child} } } $d = new D; $d->self = $d; unset($d); var_dump(gc_collect_cycles()); var_dump(gc_collect_cycles()); var_dump(gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('gc_collect_cycles() defers what destructors of deferred objects attach or create', () => {
  for (const [make, expected] of [
    ['$this->c = new stdClass;', 'E;int(1)\nint(2)\nint(0)\n'],
    ['$g = new G; $g->self = $g; $g->c = [new stdClass];', 'E;G;int(1)\nint(4)\nint(0)\n'],
    ['$a = []; $a["self"] = &$a; unset($a);', 'E;int(1)\nint(2)\nint(0)\n'],
    ['global $saved; $saved = null;', 'E;int(1)\nint(2)\nint(0)\n'],
  ]) {
    expect(
      run(
        `<?php class G { public $self; public $c; function __destruct() { echo "G;"; } } class E { public $self; public $c; function __destruct() { echo "E;"; ${make} } } class D { public $self; function __destruct() { $e = new E; $e->self = $e; } } $saved = new stdClass; $saved->self = $saved; $d = new D; $d->self = $d; unset($d); var_dump(gc_collect_cycles(), gc_collect_cycles(), gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('gc_collect_cycles() returns the handles of what collected garbage held before those of the garbage', () => {
  expect(
    run(
      `<?php class N { function __destruct() { echo "dN;"; } } class M { public $o; function __destruct() { echo "dM;"; $o = new stdClass; $o->s = $o; $o->n = [new N, new N]; } } $a = new M; $a->o = $a; unset($a); echo gc_collect_cycles(), ";"; $k = [new stdClass, new stdClass, new stdClass]; echo spl_object_id($k[0]), spl_object_id($k[1]), spl_object_id($k[2]), ";", gc_collect_cycles();`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'dM;dN;dN;3;243;0' });
});

test('gc_collect_cycles() counts the arrays without objects that a destructible cycle holds', () => {
  for (const [setup, expected] of [
    ['$x->a[] = 1;', 'd;int(2)\n'],
    ['$x->a[0][] = 3;', 'd;int(3)\n'],
    ['$arr = []; $arr[] = 1; $x->a = $arr; unset($arr);', 'd;int(2)\n'],
  ]) {
    expect(
      run(
        `<?php class A { public $s; public $a = []; function __destruct() { echo "d;"; } } $x = new A; $x->s = $x; ${setup} unset($x); var_dump(gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('a returned local becomes a GC root before the other locals are freed', () => {
  expect(
    run(
      '<?php class N { public $p; public $q; function __destruct() { echo "dN", spl_object_id($this), ";"; } } function mk() { $a = new N; $a->p = $a; $c = new N; $a->q = $c; $x = new stdClass; $x->a = $a; return $x; } $x = mk(); unset($x); echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'dN2;dN1;2' });
  expect(
    run(
      '<?php class N { public $p; public $q; function __destruct() { echo "dN", spl_object_id($this), ";"; } } function mk() { $a = new N; $a->p = $a; $c = new N; $a->q = $c; $x = new stdClass; $x->a = $a; return $x ?? null; } $x = mk(); unset($x); echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'dN1;dN2;2' });
  const cycle = '$a = new stdClass; $a->p = $a; $c = new stdClass; $a->q = $c; $x = new stdClass; $x->a = $a;';
  const ids =
    ' $x1 = mk(); $x2 = mk(); unset($x1, $x2); echo gc_collect_cycles(), ";"; $k = []; for ($i = 0; $i < 6; $i++) $k[] = new stdClass; foreach ($k as $o) echo spl_object_id($o), ",";';
  expect(
    run(`<?php class F { function make() { ${cycle} return $x; } } function mk() { return (new F)->make(); }${ids}`)
  ).toMatchObject({ kind: 'executed', stdout: '4;5,2,3,6,7,4,' });
  expect(run(`<?php function mk() { ${cycle} try { return $x; } finally { echo ''; } }${ids}`)).toMatchObject({
    kind: 'executed',
    stdout: '4;4,5,1,2,6,3,',
  });
  expect(
    run(
      '<?php class A { public $s; function __destruct() { echo "d", spl_object_id($this), ";"; } } function f() { $a = new A; $b = new A; $b->s = $b; $a->s = [$a]; $r = new A; return $r; } $v = f(); unset($v); echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'd3;d2;d1;3' });
  expect(
    run(
      '<?php class A { public $s; function __destruct() { echo "dA", spl_object_id($this), ";"; } } class Q { public $s; } function f() { $o0 = new Q; $o1 = new A; $o3 = new A; $o3->s = $o3; $o0->s = $o3; $o4 = new A; $o4->s = $o4; return $o1; } $v = f(); unset($v); echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'dA2;dA4;dA3;2' });
  expect(
    run(
      '<?php class A { public $s; function __destruct() { echo "d", spl_object_id($this), ";"; } } function f() { $a = new A; $a->s = [$a]; $b = new A; $b->s = $b; $r = [$b]; return $r; } $v = f(); unset($v); echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'd2;d1;3' });
  expect(
    run(
      '<?php error_reporting(E_ALL & ~E_DEPRECATED); class N {} function f1($p) { $f = fn() => 0; $f(); $t = new N; $t->s = $t; } $z = new N; $z->s = [$z, new N]; f1($z); $z = new N; echo gc_collect_cycles(), ";"; $w = [new stdClass, new stdClass, new stdClass, new stdClass]; foreach ($w as $o) echo spl_object_id($o), ",";'
    )
  ).toMatchObject({ kind: 'executed', stdout: '4;1,2,4,5,' });
  expect(
    run(
      '<?php class N { static $c = 0; public $id; public $next; function __construct() { $this->id = ++self::$c; } function __destruct() { echo "-{$this->id} "; } } $f = fn() => true; array_map($f, [1]); $a = new N; $b = new N; $a->next = $b; $b->next = $a; unset($a, $b); echo gc_collect_cycles(); $p = new N; $q = new N; echo " ", spl_object_id($p), spl_object_id($q);'
    )
  ).toMatchObject({ kind: 'executed', stdout: '-2 -1 2 32-4 -3 ' });
  expect(
    run(
      '<?php class N { function __construct(public $n) {} function __destruct() { echo "d{$this->n};"; } } function uf() { return 1; } function cyc($n) { $o = new stdClass; $o->s = $o; $o->n = new N($n); } $f = uf(...); cyc(1); $f(); cyc(2); cyc(3); echo gc_collect_cycles(), ";"; $a = []; for ($i = 0; $i < 7; $i++) $a[] = new stdClass; foreach ($a as $x) echo spl_object_id($x), ",";'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'd1;d2;d3;3;6,7,4,5,2,3,8,' });
  expect(
    run(
      '<?php class N { public $a; function __construct(public $id) {} function __destruct() { echo "d{$this->id};"; } } function cycle() { $p = new N(1); $q = new N(2); $p->a = $q; $q->a = $p; } $stack = []; array_push($stack, 1); array_push($stack, 2); cycle(); echo gc_collect_cycles(), ";"; echo spl_object_id(new stdClass);'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'd1;d2;2;1' });
  expect(
    run(
      '<?php class N { public $a; function __construct(public $id) {} function __destruct() { echo "d{$this->id};"; } } $arr = []; $arr[] = 2; $arr[] = 3; $o = new N(2); $o->a = $o; $o = null; array_pop($arr); foreach ($arr as $e) { $arr[0] = 3; } echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'd2;1' });
  for (const [bind, id] of [
    ['$a = [[1]]; $r = &$a[0];', 1],
    ['$o = new stdClass; $o->l = [1]; array_push($o->l, 2);', 2],
    ['$a = [1, 2]; foreach ($a as &$v) {} array_push($a, 1);', 1],
  ] as const)
    expect(
      run(
        `<?php class N { public $a; function __construct(public $id) {} function __destruct() { echo "d{$this->id};"; } } function cyc() { $p = new N(1); $q = new N(2); $p->a = $q; $q->a = $p; } ${bind} cyc(); echo gc_collect_cycles(), ";", spl_object_id(new stdClass);`
      )
    ).toMatchObject({ kind: 'executed', stdout: `d1;d2;2;${id}` });
  for (const callable of [
    'class H { function make() { return function () { return 1; }; } } $h = new H; $f = $h->make();',
    'class H { function m() { return 1; } } $h = new H; $f = $h->m(...);',
    'class H { function __call($n, $a) { return 5; } function get() { return self::zz(...); } } $h = new H; $f = $h->get();',
    'class H { function __call($n, $a) { return 5; } } $h = new H; $f = $h->zz(...);',
  ])
    expect(
      run(
        `<?php class N { function __construct(public $n) {} function __destruct() { echo "d{$this->n};"; } } function cyc($n) { $o = new stdClass; $o->s = $o; $o->n = new N($n); } ${callable} cyc(1); $f(); cyc(2); cyc(3); echo gc_collect_cycles();`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'd1;d3;d2;3' });
  expect(
    run(
      '<?php class D { function __destruct() { throw new Exception("x"); } } class K { public $s; function __destruct() { echo "k", spl_object_id($this), ";"; } function m() { $d = new D; } } $a = new K; $a->s = $a; $b = new K; $b->s = $b; try { $a->m(); } catch (Exception $e) {} unset($b); unset($a); echo gc_collect_cycles();'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'k2;k1;2' });
});

test('rejecting an unsupported feature ends the run without PHP shutdown replacing the message', () => {
  expect(
    run(
      '<?php\nclass D { function __destruct() { $this->undefinedMethod(); } }\n$d = new D;\necho "start\\n";\n$x = serialize([1]);\n'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'start\n',
    uncaughtException: '直列化（serialize）は、この採点環境では使えません。',
  });
  expect(
    run(
      '<?php class D { function __destruct() { echo "dtor;"; throw new Exception("late"); } } $d = new D; set_exception_handler(function ($e) { echo "handler;"; serialize(1); }); throw new Exception("first");'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout: 'handler;',
    uncaughtException: '直列化（serialize）は、この採点環境では使えません。',
  });
});

test.each([
  ['a literal array', '$arr = [];', 'd1;d2;2;[[],[10]]'],
  ['an array emptied by unset', '$arr = [42]; unset($arr[0]);', 'd2;d1;2;[[],{"1":10}]'],
])('array_map retains append keys and GC behavior for %s', (_description, setup, stdout) => {
  const program = `<?php
    class N {
      public $next;
      function __construct(public $id) {}
      function __destruct() { echo "d{$this->id};"; }
    }
    ${setup}
    $mapped = array_map(fn($x) => $x, $arr);
    unset($arr);
    $other = null;
    $capture = function () use (&$mapped) {};
    $capture = function () use (&$other) {};
    $node = new N(1); $node->next = $node; $node = null;
    $node = new N(2); $node->next = $node; $node = null;
    echo gc_collect_cycles(), ';';
    $copy = $mapped;
    $copy[] = 10;
    echo json_encode([$mapped, $copy]);`;
  expect(run(program)).toMatchObject({ kind: 'executed', stdout });
});

test('gc_collect_cycles() frees a destructed object that only a collected object cycle held', () => {
  expect(
    run(
      `<?php class N { function __destruct() { echo "dN;"; } } class M { public $o; function __destruct() { echo "dM;"; $o = new stdClass; $o->s = $o; $o->n = new N; } } $a = new M; $a->o = $a; unset($a); echo gc_collect_cycles(), ";", spl_object_id(new stdClass), ";", gc_collect_cycles();`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'dM;dN;2;2;0' });
});

test('gc_collect_cycles() frees a destructed object whose only holder the rerun destroys', () => {
  expect(
    run(
      String.raw`<?php class N { function __destruct() { echo "dN\n"; } } class M { public $o; function __destruct() { echo "dM\n"; $x = [new N]; $x[] = &$x; } } $a = new M; $a->o = $a; unset($a); var_dump(gc_collect_cycles()); var_dump(spl_object_id(new stdClass)); var_dump(gc_collect_cycles());`
    )
  ).toMatchObject({ kind: 'executed', stdout: 'dM\ndN\nint(2)\nint(2)\nint(0)\n' });
});

test('converting "-0" to float keeps the sign of zero, as strtod does', () => {
  expect(
    run('<?php var_dump((float)"-0", floatval("-0"), (float)"-0abc", "-0" + 0.0, round("-0")); echo (float)"-0";')
  ).toMatchObject({
    kind: 'executed',
    stdout: 'float(-0)\nfloat(-0)\nfloat(-0)\nfloat(0)\nfloat(0)\n-0',
  });
});

test('a class whose override names a later class is declared when its statement runs', () => {
  expect(
    run(
      '<?php class Animal {} class Zoo { function get(): Animal { return new Animal; } } echo class_exists("DogZoo") ? "y" : "n"; class DogZoo extends Zoo { function get(): Dog { return new Dog; } } class Dog extends Animal {} echo get_class((new DogZoo)->get());'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'nDog' });
  expect(
    run(
      '<?php class P { function f(Dog $d) {} } class C extends P { function f(Animal $a) {} } class Animal {} class Dog extends Animal {} echo "ok";'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'ok' });
  expect(
    run(
      '<?php class P extends ArrayIterator {function f(): X {return new X;}}echo "before;";class C extends P {function current(){}function f(): Y {return new Y;}}class X{}class Y extends X{}echo "done";'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'before;\nDeprecated: Return type of C::current() should either be compatible with ArrayIterator::current(): mixed, or the #[\\ReturnTypeWillChange] attribute should be used to temporarily suppress the notice in /main.php on line 1\ndone',
  });
});

test('a class whose property hook names a later class is declared when its statement runs', () => {
  expect(
    run(
      '<?php class Animal{}class P{public Animal $x{get=>new Animal;}}echo class_exists("C")?"y":"n";class C extends P{public Dog $x{get=>new Dog;}}class Dog extends Animal{}echo get_class((new C)->x);'
    )
  ).toMatchObject({ kind: 'executed', stdout: 'nDog' });
  expect(
    run(
      '<?php class Animal{}class P{public Animal $x{get=>new Animal;}}class C extends P{public int $x{get=>1;}} echo "x";'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Declaration of C::$x::get(): int must be compatible with P::$x::get(): Animal in /main.php on line 1\nStack trace:\n#0 {main}\n',
  });
});

test('native UTF-8 regex scans of long subjects validate the subject once', () => {
  vi.restoreAllMocks();
  expect(run(`<?php echo preg_match_all('/(あ)+/u', str_repeat('あ ', 40000));`)).toMatchObject({
    kind: 'executed',
    stdout: '40000',
  });
  expect(
    run(`<?php echo var_export(preg_match('/(あ)+/u', "\\xff" . str_repeat('あ', 2000)), true), preg_last_error();`)
  ).toMatchObject({
    kind: 'executed',
    stdout: 'false4',
  });
});

test('a property hook naming a missing class where object is expected cannot be checked', () => {
  expect(
    run(
      '<?php class P{public object $x{get=>new stdClass;}}class C extends P{public Missing $x{get=>new Missing;}}echo "accepted";'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Could not check compatibility between C::$x::get(): Missing and P::$x::get(): object, because class Missing is not available in /main.php on line 1\nStack trace:\n#0 {main}\n',
  });
});

test('an override naming a missing class reports that its compatibility cannot be checked', () => {
  for (const [parent, child, expected] of [
    [
      'function f(Missing $a) {}',
      'function f(Other $a) {}',
      'C::f(Other $a) and P::f(Missing $a), because class Missing is not available',
    ],
    [
      'function f(): Missing {}',
      'function f(): Other {}',
      'C::f(): Other and P::f(): Missing, because class Other is not available',
    ],
    [
      'function f(): object {}',
      'function f(): Missing {}',
      'C::f(): Missing and P::f(): object, because class Missing is not available',
    ],
  ]) {
    expect(run(`<?php class P { ${parent} } class C extends P { ${child} } echo "x";`)).toMatchObject({
      kind: 'executed',
      stdout: `\nFatal error: Could not check compatibility between ${expected} in /main.php on line 1\nStack trace:\n#0 {main}\n`,
    });
  }
  expect(
    run('<?php class A implements IteratorAggregate { function getIterator(): Generator_test {} } echo "x";')
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Could not check compatibility between A::getIterator(): Generator_test and IteratorAggregate::getIterator(): Traversable, because class Generator_test is not available in /main.php on line 1\nStack trace:\n#0 {main}\n',
  });
});

test('a non-public destructor runs only where its visibility allows', () => {
  expect(
    run(
      '<?php\nclass A { private function __destruct() { echo "d"; } function __construct() {} }\n$a = new A; unset($a); echo "after\\n";'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nFatal error: Uncaught Error: Call to private A::__destruct() from global scope in /main.php:3\nStack trace:\n#0 {main}\n  thrown in /main.php on line 3\n',
  });
  expect(
    run(
      '<?php class A { protected function __destruct() { echo "d"; } } class B extends A { function kill() { $x = new A; echo "k;"; } } $b = new B; $b->kill(); echo "end;";'
    )
  ).toMatchObject({
    kind: 'executed',
    stdout:
      'k;\nFatal error: Uncaught Error: Call to protected A::__destruct() from global scope in /main.php:1\nStack trace:\n#0 {main}\n  thrown in /main.php on line 1\n\nWarning: Call to protected B::__destruct() from global scope during shutdown ignored in Unknown on line 0\n',
  });
});

test('gc_collect_cycles() counts what a destructor leaves garbage, not what it frees', () => {
  for (const release of ['$this->a = [];', 'unset($this->a);']) {
    expect(
      run(
        `<?php class D { public $a; function __destruct() { ${release} } } $o = new D; $a = [$o]; $o->a = $a; unset($o, $a); var_dump(gc_collect_cycles(), gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: 'int(1)\nint(0)\n' });
  }
  for (const [release, assign, expected] of [
    ['$this->a = [];', '=', 'int(2)\nint(0)\n'],
    ['$this->a = [];', '= &', 'int(1)\nint(0)\n'],
    ['unset($this->a);', '=', 'int(2)\nint(0)\n'],
    ['unset($this->a);', '= &', 'int(2)\nint(0)\n'],
  ]) {
    expect(
      run(
        `<?php class D { public $a; function __destruct() { ${release} } } $o = new D; $a = [$o]; $a["self"] = &$a; $o->a ${assign} $a; unset($o, $a); var_dump(gc_collect_cycles(), gc_collect_cycles());`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});

test('a deprecated function reports its deprecation before binding its arguments', () => {
  expect(run('<?php utf8_encode(null);')).toMatchObject({
    kind: 'executed',
    stdout:
      '\nDeprecated: Function utf8_encode() is deprecated since 8.2, visit the php.net documentation for various alternatives in /main.php on line 1\n\nDeprecated: utf8_encode(): Passing null to parameter #1 ($string) of type string is deprecated in /main.php on line 1\n',
  });
  expect(
    run('<?php $s = new SplObjectStorage; try { $s->contains(5); } catch (TypeError $e) { echo "T"; }')
  ).toMatchObject({
    kind: 'executed',
    stdout:
      '\nDeprecated: Method SplObjectStorage::contains() is deprecated since 8.5, use method SplObjectStorage::offsetExists() instead in /main.php on line 1\nT',
  });
});

test('a by-reference foreach subject stays a reference for shutdown destruction', () => {
  const prelude =
    'class D { public $x = 1; function __construct(public $n) {} function __destruct() { echo "d", $this->n, ";"; } } $a = new D(1);';
  expect(run(`<?php ${prelude} $b = new D(2); foreach ($b as &$v) {} unset($v); echo "end;";`)).toMatchObject({
    kind: 'executed',
    stdout: 'end;d1;d2;',
  });
  expect(run(`<?php ${prelude} $c = [1]; foreach ($c as &$r) {} unset($r); $c = new D(2); echo "end;";`)).toMatchObject(
    { kind: 'executed', stdout: 'end;d1;d2;' }
  );
});

test('frees a return value interrupted by a cleanup exception before enclosing handlers run', () => {
  expect(
    run(`<?php
class D { function __construct(public $n) {} function __destruct() { echo $this->n, ';'; if ($this->n[0] !== 'q') throw new Exception($this->n); } }
function g($x) { return new D("q"); }
function a() { try { try { return new D("r"); } finally { return new D("f"); } } finally { echo 'outer;'; } }
function b() { try { try { return [new D("r")]; } finally { return new D("f"); } } catch (Exception $e) { echo 'caught;'; return 1; } finally { echo 'outer;'; } }
function c() { try { return g(new D("t")); } finally { echo 'fin;'; } }
foreach (['a', 'b', 'c'] as $f) {
  try { $f(); echo 'ret;'; } catch (Exception $e) { echo $e->getMessage(), ';', $e->getPrevious()?->getMessage(); }
  echo "\\n";
}`)
  ).toMatchObject({ kind: 'executed', stdout: 'r;f;outer;f;r\nr;f;caught;outer;ret;\nt;q;fin;t;\n' });

  for (const [exiting, body, expected] of [
    [
      'r',
      'try { try { return new D("r"); } finally { return new D("f"); } } finally { echo "outer;"; }',
      'r;exit;f;caught:f;end;',
    ],
    [
      'f',
      'try { try { return new D("r"); } finally { return new D("f"); } } finally { echo "outer;"; }',
      'r;f;exit;outer;',
    ],
    [
      'r',
      'try { try { return new D("r"); } finally { return new D("f"); } } catch (Exception $e) { echo "c:", $e->getMessage(), ";"; } finally { echo "outer;"; }',
      'r;exit;f;c:f;outer;end;',
    ],
    ['r', 'try { return g(new D("r")); } finally { echo "outer;"; }', 'r;exit;f;outer;caught:f;end;'],
  ]) {
    expect(
      run(
        `<?php class D { function __construct(public $n) {} function __destruct() { echo $this->n, ";"; if ($this->n === "${exiting}") exit("exit;"); throw new Exception($this->n); } } function g($x) { return new D("f"); } function f() { ${body} } try { f(); } catch (Throwable $e) { echo "caught:", $e->getMessage(), ";"; } echo "end;";`
      )
    ).toMatchObject({ kind: 'executed', stdout: expected });
  }
});
