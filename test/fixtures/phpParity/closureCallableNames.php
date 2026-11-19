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

$anonymous = new class {
    function method() {}
};
foreach ([false, true] as $syntaxOnly) {
    var_dump(is_callable([$anonymous, 'method'], $syntaxOnly, $name));
    var_dump($name === get_class($anonymous) . '::method');
}
