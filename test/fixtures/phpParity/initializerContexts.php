<?php
use Exception;
use function strlen;
use const PHP_EOL;
use stdClass as ObjectValue;
const GLOBAL_TEST = true &&
    NAN;
const GLOBAL_CLOSURE = static function () { echo 'global:'; var_dump(NAN || true); };
class Holder {
    const STRING = NAN .
        'x';
    const CLOSURE = static function () { echo 'class:'; var_dump(NAN || true); };
}
function staticValues() {
    static $left = true &&
        NAN;
    static $right = false ||
        NAN;
    static $text = NAN .
        'x';
    return [$left, $right, $text];
}
function lateClosure($callback = static function () {
    echo 'late:';
    try { var_dump((NAN || true)::class); }
    catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}) { return $callback; }
function lateDefault($value = NAN xor true) { return $value; }
interface Marker {}
class Base {}
class Item extends Base implements Marker {
    public function selfType(): self&Marker { return $this; }
    public function parentType(): parent&Marker { return $this; }
}
echo 'start;';
var_dump(GLOBAL_TEST, Holder::STRING, staticValues(), lateDefault());
(GLOBAL_CLOSURE)();
(Holder::CLOSURE)();
lateClosure()();
$item = new Item;
var_dump($item->selfType() === $item, $item->parentType() === $item);
