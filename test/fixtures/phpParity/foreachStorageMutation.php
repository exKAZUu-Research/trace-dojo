<?php
function mutation(array $source, int $at, int $start, int $count, array $insert): void {
    $step = 0;
    foreach ($source as $key => &$value) {
        echo $key, '=', $value, ',';
        if ($step++ === $at) array_splice($source, $start, $count, $insert);
        if ($step > 7) break;
    }
    echo "\n";
}
foreach ([[10,20,30], ['a'=>10,'b'=>20,'c'=>30], [0=>10,2=>20,3=>30]] as $source) {
    mutation($source, 0, 0, 1, []);
    mutation($source, 0, 1, 1, [7,8]);
    mutation($source, 0, 1, 0, [7,8]);
    mutation($source, 1, 2, 1, [7,8]);
    mutation($source, 2, 0, 3, [7,8]);
    mutation($source, 2, 1, 0, [7,8]);
}

$source = [10,20,30];
$step = 0;
foreach ($source as $key => &$value) {
    echo $key, '=', $value, ',';
    if ($step++ === 0) $source = [];
}
unset($value);
echo "\n";

$object = (object)['items'=>[10,20,30]];
$step = 0;
foreach ($object->items as $key => &$value) {
    echo $key, '=', $value, ',';
    if ($step++ === 0) $object->items = [1,2];
}
unset($value);
echo "\n";

$replacement = [1,2,3];
next($replacement);
$source = [10,20,30];
$step = 0;
foreach ($source as $key => &$value) {
    echo $key, '=', $value, ',';
    if ($step++ === 0) $source = $replacement;
    $value *= 2;
}
unset($value);
echo "\n";
var_dump($source, $replacement);

$source = [10,20,30];
foreach ($source as $key => &$value) {
    echo $key, '=', $value, ',';
    if ($key === 0) { $shadow = $source; array_splice($source, 1, 1, [7,8]); }
}
unset($value);
echo "\n";
var_dump($shadow);

$source = new ArrayObject([4,5]);
foreach ($source as $key => &$value) {
    echo $key, '=', $value, ',';
    if ($key === 0) $source->exchangeArray([7,8]);
}
unset($value);
echo "\n";

$source = [10,20];
foreach ($source as $key => &$value) {
    echo $key, '=', $value, ',';
    $source = null;
}
unset($value);
