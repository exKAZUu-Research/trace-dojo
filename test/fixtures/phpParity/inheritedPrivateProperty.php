<?php
class PrivateParent {
    private int $field = 4;
    function parentValue() { return $this->field; }
}
class PrivateChild extends PrivateParent {
    function childValue() { return $this->field; }
}
$value = new PrivateChild();
var_dump(isset($value->field), $value->childValue(), $value->field);
unset($value->field);
$value->field = 6;
var_dump($value->parentValue(), $value->childValue());
unset($value->field);
var_dump($value->parentValue(), $value->field ?? 0);
try { (new PrivateParent())->field; }
catch (Error $e) { echo $e->getMessage(), "\n"; }
