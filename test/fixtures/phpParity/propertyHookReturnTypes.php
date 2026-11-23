<?php
class WeakGetter {
    public int $number { get => "12"; }
    public int $invalid { get => "bad"; }
    public int $missing { get => null; }
    public string $array { get => [1]; }
    public int|string $union { get => "12"; }
    public ?int $nullable { get => null; }
}
$object = new WeakGetter();
foreach (["number", "invalid", "missing", "array", "union", "nullable"] as $name) {
    try { var_dump($object->$name); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
$value = "12";
class RefGetter {
    public int $value { &get { global $value; return $value; } }
}
$object = new RefGetter();
$alias =& $object->value;
var_dump($alias, $value);
