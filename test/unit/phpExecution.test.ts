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
  ['a syntax error', '<?php\necho "a"\necho "b";'],
  ['an unclosed block', '<?php\nif (true) {\n  echo 1;'],
  ['a break outside a loop', '<?php\necho "x";\nbreak;'],
  ['a function declared twice', '<?php\nfunction f() {}\nfunction f() {}'],
  ['a value returned from a void function', '<?php\nfunction g(): void { return 1; }'],
  ['reading with []', '<?php\n$a = [];\necho $a[];'],
  ['a goto into a loop', '<?php\ngoto x;\nwhile (true) { x: echo 1; }'],
  ['partial application, which PHP 8.5 does not have', '<?php\nfunction f($a, $b) {}\n$g = f(?, 1);'],
])('rejects %s before running, as PHP does', (_name, program) => {
  expect(run(program).kind).toBe('compileError');
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

test('walking arrays that share their elements stops at the execution limit', () => {
  const execution = run(
    '<?php\n$a = [1];\nfor ($i = 0; $i < 40; $i++) $a = [$a, $a];\necho count($a, COUNT_RECURSIVE);'
  );
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
  '<?php $a=[]; for($i=0;$i<20000;$i++) $a=[$a]; echo count($a,1);',
])('native allocation or host recursion failure remains a PHP result: %s', (source) => {
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

test('bounded comparisons of deeply nested arrays report a PHP error', () => {
  const source =
    '<?php $a=1;$b=1;for($i=0;$i<1000;$i++){$a=[$a];$b=[$b];}try{var_dump($a===$b);}catch(Error $e){echo "caught";}';
  expect(run(source)).toMatchObject({ kind: 'executed', stdout: 'caught' });
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
