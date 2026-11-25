<?php
function g() {
    $a = [yield 1, yield 2];
    var_dump($a);
    echo "sum: ", (yield 3) + (yield 4), "\n";
    $s = "got " . (yield 5) . "!";
    echo $s, "\n";
    if (yield 6) echo "truthy\n"; else echo "falsy\n";
    $i = 0;
    while ((yield 7) && $i < 2) { $i++; echo "loop $i\n"; }
    for ($j = yield 8; $j < 3; $j += yield 9) echo "j=$j\n";
    foreach ((yield 10) as $v) echo "v=$v\n";
    switch (yield 11) { case 'x': echo "case x\n"; break; default: echo "default\n"; }
    [$p, $q] = yield 12;
    echo "p=$p q=$q\n";
    echo strtoupper(yield 13), "\n";
    $arr = [];
    $arr[] = yield 14;
    $arr['k'] = yield 15;
    var_dump($arr);
    $m = match (yield 16) { 1 => 'one', 2 => 'two', default => 'other' };
    echo $m, "\n";
    $n = (yield 17) ?? 'dflt';
    echo $n, "\n";
    echo (yield 18) ? 'T' : 'F', "\n";
    return yield 19;
}
$sends = [null, 'a', 'b', 10, 20, 'X', 1, true, true, false, 1, 1, [7, 8], 'x', [1, 2], 'hello', 'v1', 'v2', 2, null, 0, 'ret'];
$gen = g();
$i = 0;
$gen->current();
while ($gen->valid()) {
    echo "yielded ", $gen->key(), " => ", json_encode($gen->current()), "\n";
    $gen->send($sends[++$i] ?? null);
}
var_dump($gen->getReturn());
