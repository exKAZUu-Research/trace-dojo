<?php
class HookResult {
    function __construct(public string $label) {}
    function __destruct() { echo "released $this->label\n"; }
}
class OverloadedProperties {
    function __isset($name) { return [new HookResult("isset $name")]; }
    function __get($name) { echo "get $name\n"; return 3; }
    function __set($name, $value) { return new HookResult("set $name"); }
    function __unset($name) { return [new HookResult("unset $name")]; }
}
$object = new OverloadedProperties;
var_dump(isset($object->slot), $object->slot ?? 0, empty($object->slot), $object->slot = 7);
unset($object->first, $object->second);

$calls = 0;
class ErrorResult {
    function __destruct() { $GLOBALS['calls']++; }
}
set_error_handler(function () {
    echo "warning ", $GLOBALS['calls'], "\n";
    return [new ErrorResult];
});
echo implode(",", [[], []]), "\n";
restore_error_handler();

class WithHooks {
    public $property;
    function __construct(public string $label) { $this->property = new HookResult("property $label"); }
    function __clone() { return new HookResult("clone $this->label"); }
    function __destruct() { return [new HookResult("destruct $this->label")]; }
    function useClone() { echo "use $this->label\n"; }
}
$original = new WithHooks("ordinary");
(clone $original)->useClone();
unset($original);
$shutdown = new WithHooks("shutdown");
echo "end\n";
