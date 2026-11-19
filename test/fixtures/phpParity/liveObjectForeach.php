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
class LoopSubject {
    public $a = 1, $b = 2;
    function __construct(private $label, private $throws = false) {}
    function __destruct() {
        echo "drop:$this->label;";
        if ($this->throws) throw new RuntimeException('destructor');
    }
}
function visit($mode) {
    $subject = new LoopSubject('original', $mode === 'throw both');
    foreach ($subject as $key => $value) {
        echo "$key=$value;";
        if ($key !== 'a') continue;
        if ($mode === 'replace') $subject = new LoopSubject('replacement');
        else unset($subject);
        if ($mode === 'break') break;
        if ($mode === 'return') return 'returned;';
        if ($mode === 'throw both') throw new Exception('body');
        if ($mode === 'exit') exit('exited;');
    }
    echo 'end;';
}
foreach (['unset', 'replace', 'break', 'return', 'throw both', 'exit'] as $mode) {
    echo "$mode;";
    try { echo visit($mode); }
    catch (Throwable $error) {
        echo $error->getMessage(), ':', $error->getPrevious()?->getMessage(), ';';
    }
    echo "\n";
}
