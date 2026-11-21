<?php
const VALUES = [[1]];
foreach (VALUES[0] as &$v) { ++$v; }
var_dump(VALUES[0][0], $v);

$object = (object)['a' => [1], 'b' => (object)['y' => 1]];
foreach ($object?->a as &$v) { ++$v; }
var_dump($object->a[0], $v);
foreach ($object?->b as &$v) { ++$v; }
var_dump($object->b->y, $v);
$null = null;
foreach ($null?->a[0] as &$v) {}
foreach ('abc'[0] as &$v) {}
foreach ($object?->missing as &$v) {}
var_dump(property_exists($object, 'missing'));
class Types {
    public array $required;
    public ?array $optional;
    public static array $shared;
}
$typed = new Types;
try { foreach ($typed->required as &$v) {} }
catch (Error $error) { echo $error->getMessage(), "\n"; }
foreach ($typed->optional as &$v) {}
var_dump($typed->optional);
try { foreach (Types::$shared as &$v) {} }
catch (Error $error) { echo $error->getMessage(), "\n"; }
$string = 'abc';
try { foreach ($string[0] as &$v) {} }
catch (Error $error) { echo $error->getMessage(), "\n"; }
function undefinedSubject() {
    foreach ($undefined as &$v) {}
    var_dump(array_key_exists('undefined', get_defined_vars()));
    $name = 'dynamic';
    foreach ($$name as &$v) {}
    var_dump(array_key_exists('dynamic', get_defined_vars()));
}
undefinedSubject();

foreach ([[7, 8], (object)['z' => 7], null] as $replacement) {
    $subject = [10, 20];
    $iteration = 0;
    foreach ($subject as $key => &$value) {
        echo "$key:$value;";
        if ($iteration === 0) $subject = (object)['x' => 3, 'y' => 4];
        elseif ($iteration === 1) $subject = $replacement;
        $iteration++;
    }
    unset($value);
    echo "\n";
}
echo "loop done\n";
