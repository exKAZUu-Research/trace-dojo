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

test.each([String.raw`/(a)?\1/`, String.raw`/(?<x>a)?\k<x>/`])(
  'rejects empty-subject backreferences whose participation cannot be represented: %s',
  (pattern) => {
    expect(run(`<?php preg_match('${pattern}', '', $m);`)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('この採点環境では使えません。'),
    });
  }
);

test('retains participating empty captures', () => {
  expect(run(String.raw`<?php var_dump(preg_match('/(a|)\1/','',$m),$m);`)).toMatchObject({
    kind: 'executed',
    stdout: 'int(1)\narray(2) {\n  [0]=>\n  string(0) ""\n  [1]=>\n  string(0) ""\n}\n',
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
  String.raw`<?php preg_match('/\xe9/i',"\xc9");`,
  String.raw`<?php preg_match('/[\xe0-\xef]/i',"\xc9");`,
  '<?php preg_match("/(?<=a+)b/","ab");',
  '<?php preg_match("/(?<=a{1,256})b/","ab");',
  '<?php preg_match("/(a*)+/","aaa");',
  '<?php preg_match("/(a?){0,3}/","a");',
  '<?php preg_match("/()*/","");',
])('rejects regex semantics the host cannot preserve: %s', (source) => {
  expect(run(source)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('この採点環境では使えません。'),
  });
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
