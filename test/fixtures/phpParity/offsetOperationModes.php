<?php
class Offsets implements ArrayAccess {
    public int $stored = 3;
    function offsetExists(mixed $offset): bool { return true; }
    function offsetGet(mixed $offset): mixed { echo "get\n"; return $this->stored; }
    function offsetSet(mixed $offset, mixed $value): void { echo "set\n"; $this->stored = $value; }
    function offsetUnset(mixed $offset): void {}
}
class RefOffsets extends Offsets {
    function &offsetGet(mixed $offset): mixed { echo "ref\n"; return $this->stored; }
}
$offsets = new Offsets;
var_dump($offsets['x']++, ++$offsets['x'], $offsets->stored);
$offsets['x'] += 2;
var_dump($offsets->stored);
$refs = new RefOffsets;
--$refs['x'];
var_dump($refs->stored);
$native = new ArrayObject(['x' => 2]);
var_dump($native['x']++, $native['x']);
$array = [];
$string = 'abc';
$bad = [];
foreach ([
    fn() => $array[$bad] ?? 3, fn() => isset($array[$bad]), fn() => empty($array[$bad]),
    fn() => $native[$bad] ?? 3, fn() => $native[$bad], fn() => $native->offsetExists($bad),
    fn() => $native->offsetUnset($bad), fn() => (new RecursiveArrayIterator)[$bad],
    fn() => isset($string[$bad]), fn() => empty($string[$bad]), fn() => $string[$bad] ?? 3,
    fn() => $string['1x'] ?? 3, fn() => isset($string[1.2]),
] as $call) {
    try { var_dump($call()); }
    catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
function keyPart(int $value): int { echo 'key', $value; return 0; }
foreach ([false, true, 1, 1.2, null, 'abc'] as $container) {
    try { unset($container[0]); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
    try { unset($container[keyPart(1)][keyPart(2)]); }
    catch (Error $error) { echo $error->getMessage(); }
    echo "\n";
    var_dump($container);
}
