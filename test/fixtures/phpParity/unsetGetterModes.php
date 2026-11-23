<?php
class UnsetGetterModes {
    public int $number;
    public array $items;
    public function __isset($name) { return true; }
    public function __get($name) { return $name === 'items' ? true : 'present'; }
}
$value = new UnsetGetterModes;
unset($value->number, $value->items);
var_dump(empty($value->number), empty($value->items));
try { var_dump($value->items); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
