<?php
function check($callback) {
    try { var_dump($callback()); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
$dynamic = 'implode';
foreach ([null, new stdClass, 3, ['a', 'b']] as $value) {
    check(fn() => implode($value));
    check(fn() => join($value));
    check(fn() => $dynamic($value));
    check(fn() => implode(...[$value]));
    check(fn() => call_user_func('implode', $value));
}
class Stored {
    public int $stored { set { $this->stored = $value; } }
    public int $plain;
    public int $virtual { set {} }
}
class FailingHook {
    public $item { get { throw new Exception('failed'); } }
}
var_export(new Stored);
echo "\n";
foreach ([fn() => var_export(new FailingHook, true), fn() => json_encode(new FailingHook)] as $callback) {
    try { $callback(); } catch (Throwable $error) { echo $error->getTraceAsString(), "\n"; }
}
