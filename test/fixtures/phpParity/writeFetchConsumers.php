<?php
function attempt($action) { try { $action(); } catch (Throwable $error) { echo $error->getMessage(), "\n"; } }
class Overloaded {
    function __isset($name) { echo 'isset;'; return true; }
    function __get($name) { echo 'get;'; return ['value' => isset($this->$name)]; }
}
$overloaded = new Overloaded;
var_dump(empty($overloaded->key), $overloaded->key ?? 0);
var_dump(isset($overloaded->key['value']), empty($overloaded->key['value']), $overloaded->key['value'] ?? 0);
$array = [];
$object = new stdClass;
foreach ($array['missing'] as &$entry) {}
foreach ($object->missing as &$entry) {}
foreach ($object->nested['key'] as &$entry) {}
foreach ($undefined as &$entry) {}
var_dump($array, (array)$object);
$null = null;
attempt(function () use ($null) { foreach ($null->p as &$entry) {} });
$string = 'abc';
attempt(fn() => $string[0]->p = 1);
attempt(fn() => $string['1']->p = 1);
attempt(fn() => $string[1.5]->p++);
attempt(function () use (&$array) { $array[]->p = 1; });
attempt(function () use (&$array) { $array[]->p++; });
var_dump($array);
class TypedReference {
    public array $items = [];
    public static array $other = [];
    public int $value = 1;
}
$typed = new TypedReference;
$ref =& $typed->value;
$items =& $typed->items;
$other =& TypedReference::$other;
attempt(fn() => $typed->value /= 2);
attempt(fn() => $typed->value = []);
attempt(fn() => $typed->items .= 'x');
attempt(fn() => TypedReference::$other .= 'x');
