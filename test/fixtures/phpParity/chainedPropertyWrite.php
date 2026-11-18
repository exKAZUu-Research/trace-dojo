<?php
class Chained {
    public int $typed = PHP_INT_MAX;
    public static $stat = 1;
    private $hidden = [];
    public readonly array $frozen;
    public $scalar { get { echo "getter\n"; return 4; } }
    public $object { get { echo "object getter\n"; return new stdClass; } }
    public $only { set {} }
    function __construct() { $this->frozen = []; }
}
class OverloadedChain {
    function __get($name) { echo "overloaded get\n"; return 1; }
}
class IssetChain {
    function __isset($key) { echo "overloaded isset\n"; return true; }
    function __get($key) { echo "guarded get\n"; return $this->$key ?? 1; }
}
function writeValue() { echo 'value;'; return 3; }
function propertyName() { echo 'name;'; return 'x'; }
function attempt($action) { try { $action(); } catch (Error $e) { echo $e->getMessage(), "\n"; } }
function takeReference(&$value) {}
$object = new Chained;
$fixed = new stdClass;
$magic = new OverloadedChain;
$null = null;
$array = [];
attempt(fn() => $null->{propertyName()} = writeValue());
attempt(fn() => $null->a->{propertyName()} = writeValue());
attempt(fn() => $null->a++);
attempt(fn() => $null->a->b++);
attempt(function () use ($null) { $ref =& $null->p; });
attempt(function () use ($null) { $value = 0; $null->p =& $value; });
attempt(fn() => takeReference($null->p));
attempt(fn() => $object->scalar->x = writeValue());
attempt(fn() => $object->scalar->x += writeValue());
attempt(fn() => $object->scalar->x ??= writeValue());
attempt(fn() => $object->scalar->x++);
attempt(fn() => $object->object->x = writeValue());
attempt(fn() => $magic->x->y = writeValue());
attempt(fn() => isset($object->only));
attempt(fn() => empty($object->only));
attempt(function () use (&$array) { $array['x']->y = writeValue(); });
attempt(fn() => $fixed->none->y = writeValue());
var_dump($array, (array)$fixed);
$object->stat = 2;
var_dump($object->stat, isset($object->stat), empty($object->stat), $object->stat ?? 0);
$object->stat++;
$object->stat += 2;
$reference =& $object->stat;
unset($object->stat);
attempt(fn() => $object->hidden[] = 1);
attempt(function () use ($object) { foreach ($object->frozen as &$value) {} });
$typed =& $object->typed;
attempt(fn() => $object->typed++);
attempt(function () use (&$typed) { $typed++; });
var_dump(empty((new IssetChain)->virtual));
