<?php
$nullSource = null;
[[] => $missing, 'created' => &$created] = $nullSource;
var_dump($missing, $nullSource);
$scalarSource = 5;
[1.5 => $missing] = $scalarSource;
var_dump($missing);

foreach ([[1, 2], [[1], 2], ['value', 2], [null, 2]] as $source) {
    try {
        [$source, &$value] = $source;
        var_dump($source, $value);
    } catch (Error $error) { echo $error->getMessage(), "\n"; }
}

class ListSource {
    public array $uninitialized;
    public ?int $nullable = null;
    public static ?int $shared = null;
}
$typed = new ListSource();
try { [&$value] = $typed->uninitialized; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { [$first, &$value] = $typed->nullable; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { [&$value] = ListSource::$shared; }
catch (Error $error) { echo $error->getMessage(), "\n"; }

class DynamicListSource {
    public function __get(string $name) { echo "getting ", $name, "\n"; return []; }
}
$dynamic = new DynamicListSource();
[&$value] = $dynamic->missing;
var_dump($value);
$string = 'value';
try { [1.5 => &$value] = $string; }
catch (Error $error) { echo $error->getMessage(), "\n"; }

$falseSource = false;
set_error_handler(function () { throw new Exception('unexpected deprecation'); }, E_DEPRECATED);
[$falseSource[0][0], &$tail] = $falseSource;
restore_error_handler();
var_dump($falseSource);

class NestedListSource {
    public function __construct(private object $object) {}
    public function __get(string $name) {
        return match ($name) {
            'array' => ['key' => [1]],
            'temporary' => (object) ['items' => [2]],
            'stored' => $this->object,
        };
    }
}
class OffsetListSource extends ArrayObject {
    public function offsetGet(mixed $key): mixed { return [3]; }
}
$object = (object) ['items' => [4]];
$nested = new NestedListSource($object);
[&$value] = $nested->array['key'];
var_dump($value);
[&$value] = $nested->temporary->items;
var_dump($value);
$offsets = new OffsetListSource();
[&$value] = $offsets['key'];
var_dump($value);
[&$value] = $nested->stored->items;
$value++;
var_dump($object->items);

foreach ([NAN, 1e30, '1x', [], 'invalid'] as $key) {
    try { [ $key => &$value ] = $string; }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
    try { $value = &$string[$key]; }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
    try { $array = [&$string[$key]]; }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
function takeListReference(&$value) {}
try { takeListReference($string[false]); }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { $string[1.5] = &$value; }
catch (Error $error) { echo $error->getMessage(), "\n"; }

$falseReference = false;
$falseAlias = &$falseReference;
set_error_handler(function () { throw new Exception('unexpected deprecation'); }, E_DEPRECATED);
++$falseReference[0];
restore_error_handler();
var_dump($falseAlias);

function arrayObjectList($value) { return new ArrayObject([$value]); }
function nestedListObject() { return (object) ['entries' => new ArrayIterator([[4]])]; }
[&$value] = arrayObjectList([2])[0];
var_dump($value);
[&$value] = arrayObjectList(3)[0];
var_dump($value);
[&$value] = nestedListObject()->entries[0];
var_dump($value);
$appended = [];
[&$value] = $appended[];
$value = 5;
[[&$nestedValue]] = $appended['nested'][];
$nestedValue = 6;
var_dump($appended);
$offsets = new ArrayObject();
[&$value] = $offsets[];
var_dump($value);
try { [&$value] = clone $missingClone; }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
