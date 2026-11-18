<?php
class Example {
    public $first = 1;
    public $virtual { get => 2; }
    protected $hidden = 3;
    public $last = 4;
}
foreach (new Example as $key => $value) echo "$key=$value;";
echo "\n";
$object = (object)['a' => 1, 'b' => 2];
$done = false;
foreach ($object as $key => $value) {
    echo "$key=$value;";
    if ($key === 'a' && !$done) {
        $done = true;
        unset($object->a);
        $object->a = 3;
    }
}
echo "\n";
$object = (object)['a' => 1, 'b' => 2];
$done = false;
foreach ($object as $key => &$value) {
    if ($key === 'a' && !$done) {
        $done = true;
        unset($object->a);
        $object->a = 3;
    }
    echo "$key=$value;";
}
echo "\n";
$total = 0;
foreach ((object)array_fill(0, 10000, 1) as $value) $total += $value;
var_dump($total);
