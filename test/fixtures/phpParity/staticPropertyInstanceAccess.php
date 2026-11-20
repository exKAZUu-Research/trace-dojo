<?php
class PlainStatic {
    private static $private = 1;
    protected static $protected = 2;
    public static $shared = 3;
}
$object = new PlainStatic;
foreach (['private', 'protected'] as $name) {
    var_dump(isset($object->$name), empty($object->$name), $object->$name ?? 'quiet');
    foreach ([
        function () use ($object, $name) { $object->$name; },
        function () use ($object, $name) { $ref = &$object->$name; },
        function () use ($object, $name) { $object->$name = 4; },
        function () use ($object, $name) { unset($object->$name); }
    ] as $operation) {
        try { $operation(); }
        catch (Error $error) { echo $error->getMessage(), "\n"; }
    }
}
$ref = &$object->shared;
var_dump($ref);
unset($object->shared);
$object->shared++;
var_dump($object->shared, PlainStatic::$shared);
class ReadMagicStatic {
    private static $hidden = 1;
    public static $items = [1];
    public $target = [2];
    function &__get($name) { echo "get $name\n"; return $this->target; }
}
$magic = new ReadMagicStatic;
var_dump($magic->hidden, $magic->items);
$magic->items[] = 9;
var_dump($magic->target);
class WriteMagicStatic {
    private static $hidden = 1;
    public static $value = 2;
    function __set($name, $value) { echo "set $name=$value\n"; }
    function __unset($name) { echo "unset $name\n"; }
}
$magic = new WriteMagicStatic;
$magic->hidden = 7;
$magic->value = 3;
unset($magic->hidden, $magic->value);
