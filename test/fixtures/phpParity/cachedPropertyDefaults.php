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

class EarlyDefaults extends CachedPropertyDefaults {}
class SiblingDefaults extends CachedPropertyDefaults {}
if (true) {
    class LateDefaults extends CachedPropertyDefaults {}
}
foreach ([EarlyDefaults::class, SiblingDefaults::class, LateDefaults::class, EarlyDefaults::class] as $class) {
    $object = new $class;
    var_dump(($object->direct)(), ($object->nested[0][0])());
    unset($object);
}

trait TraitDefaults {
    private $callback = static function () { static $calls = 0; return ++$calls; };
    public function callDefault(): int { return ($this->callback)(); }
}
class TraitDefaultParent { use TraitDefaults; }
class TraitDefaultChild extends TraitDefaultParent {
    public $callback = 'shadowing property';
}
echo (new TraitDefaultParent)->callDefault(), ";", (new TraitDefaultChild)->callDefault(), ";";
echo (new TraitDefaultParent)->callDefault(), "\n";
