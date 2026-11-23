<?php
class HookModes {
    public $read { get { echo 'get virtual'; return 7; } }
    public $write { set { echo "set:$value\n"; } }
    public int $backedGet = 1 { get { echo "get-backed\n"; return $this->backedGet; } }
    public int $backedSet = 2 { set { echo "set-backed\n"; $this->backedSet = $value; } }
}
$object = new HookModes;
foreach ([fn() => $object->read++, fn() => $object->read .= 'x', fn() => --$object->read,
          fn() => ++$object->write, fn() => $object->write .= 'x', fn() => $object->write[] = 5,
          fn() => $object->write ?? 2] as $operation) {
    try { $operation(); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
$object->write = 5;
var_dump($object->read, ++$object->backedGet, ++$object->backedSet);
