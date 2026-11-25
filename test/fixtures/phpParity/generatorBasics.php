<?php
function gen() {
    echo "start\n";
    $x = yield 1;
    echo "got $x\n";
    yield 2;
    yield 'k' => 3;
    yield 10 => 4;
    yield 5;
    return 99;
}
foreach (gen() as $k => $v) {
    echo "$k => $v\n";
}
$g = gen();
echo $g->current(), "\n";
echo $g->send('hello'), "\n";
$g->next();
var_dump($g->key(), $g->current(), $g->valid());
foreach ([1] as $_) {}
$g->next(); $g->next(); $g->next();
var_dump($g->valid(), $g->getReturn());
function counter($n) { for ($i = 0; $i < $n; $i++) { yield $i => $i * $i; } }
foreach (counter(4) as $i => $sq) echo "$i:$sq ";
echo "\n";
function inner() { yield 1; yield 2; return 'r'; }
function outer() { $r = yield from inner(); echo "inner returned $r\n"; yield from [10 => 'a', 'b']; yield 3; }
foreach (outer() as $k => $v) echo "$k=$v\n";
$f = fn($a) => yield $a * 2;
foreach ($f(21) as $v) echo $v, "\n";
var_dump(gen());
$h = (function () { try { yield 1; yield 2; } finally { echo "cleanup\n"; } })();
foreach ($h as $v) { echo $v, "\n"; break; }
unset($h);
echo "end\n";
