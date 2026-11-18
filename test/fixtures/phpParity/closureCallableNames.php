<?php
class CallableCreator {
    function method() {}
    function literal() { return fn () => 42; }
}
$creator = new CallableCreator;
foreach ([strlen(...), $creator->method(...), $creator->literal(), fn () => 1] as $closure) {
    var_dump(is_callable($closure, false, $name));
    echo $name, "\n";
    var_dump(is_callable($closure, true, $name));
    echo $name, "\n";
}
