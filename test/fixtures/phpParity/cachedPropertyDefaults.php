<?php
class CachedPropertyDefaults {
    public $direct = static function () { static $calls = 0; return ++$calls; };
    public $nested = [[static function () { static $calls = 0; return ++$calls; }]];
}
foreach ([1, 2] as $count) {
    $object = new CachedPropertyDefaults;
    var_dump(($object->direct)(), ($object->nested[0][0])());
    $object->nested[0][0] = fn() => 0;
    unset($object);
    gc_collect_cycles();
}
