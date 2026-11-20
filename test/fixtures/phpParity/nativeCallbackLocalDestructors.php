<?php
class NativeCallbackLocal {
    public function __construct(private int $value) {}
    public function __destruct() {
        echo "release ", $this->value, "\n";
        debug_print_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
        if ($this->value === 4) throw new Exception('local exception');
    }
}
function work($value) {
    echo "call ", $value, "\n";
    $local = new NativeCallbackLocal($value);
}
array_map('work', [1, 2]);
try { array_map('work', [3, 4, 5]); }
catch (Exception $error) { echo $error->getMessage(), "\n"; }

class CyclicCallbackOwner {
    public $cycle;
    public function __destruct() {
        $local = new NativeCallbackLocal(6);
    }
}
$owner = new CyclicCallbackOwner();
$owner->cycle = $owner;
unset($owner);
gc_collect_cycles();
echo "done\n";
