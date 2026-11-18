<?php
class SortValue {
    function __construct(public $v) {}
    function __toString() {
        global $calls;
        echo $this->v;
        if (++$calls === 3) throw new Exception('conversion');
        return $this->v;
    }
}
$values = [new SortValue('e'), new SortValue('d'), new SortValue('c'), new SortValue('b'), new SortValue('a')];
$calls = 0;
try { asort($values, SORT_STRING); }
catch (Exception $error) { echo '!', $error->getMessage(), "\n"; }
foreach ($values as $index => $value) echo "$index:$value->v;";
echo "\n";
foreach ([SORT_STRING => ['Z', [], 'B', [], 'A'], SORT_NUMERIC => [9, new stdClass, 6, new stdClass, 0]] as $mode => $values) {
    $calls = 0;
    set_error_handler(function ($level, $message) {
        global $calls;
        echo 'warning';
        if (++$calls === 2) throw new Exception('handler');
        return true;
    });
    try { asort($values, $mode); }
    catch (Exception $error) { echo '!', $error->getMessage(), "\n"; }
    restore_error_handler();
    echo implode(',', array_keys($values)), "\n";
}
foreach (['ArrayObject', 'ArrayIterator'] as $class) {
    $object = new $class([5, 4, 3, 2, 1]);
    $calls = 0;
    try {
        $object->uasort(function ($left, $right) use (&$calls) {
            if (++$calls === 3) throw new Exception('callback');
            return $left <=> $right;
        });
    } catch (Exception $error) { echo $error->getMessage(), "\n"; }
    echo implode(',', array_keys($object->getArrayCopy())), "\n";
    try { $object->uasort(function ($left, $right) use ($object) { $object[0] = 8; return $left <=> $right; }); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
    echo implode(',', $object->getArrayCopy()), "\n";
}
class RegularSortValue {
    function __toString() { echo 'cast;'; throw new Exception('stop'); }
}
$values = [new RegularSortValue, 'b', 'a'];
try { asort($values, SORT_REGULAR); } catch (Exception $error) { echo 'caught;'; }
echo implode(',', array_keys($values)), "\n";
