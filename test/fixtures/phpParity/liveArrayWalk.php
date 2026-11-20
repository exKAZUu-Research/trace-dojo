<?php
$array = ['a' => 1, 'b' => 2];
$inserted = false;
array_walk($array, function (&$value, $key) use (&$array, &$inserted) {
    echo "$key=$value;";
    if ($key === 'a' && !$inserted) {
        unset($array['a']);
        $array['c'] = 3;
        $array['a'] = 4;
        $inserted = true;
    }
});
echo "\n";
$object = (object)['a' => 1, 'b' => 2];
array_walk($object, function (&$value, $key) use ($object) {
    echo "$key=$value;";
    if ($key === 'a') $object->c = 3;
});
echo "\n";
$array = [1, 2, 3];
$replaced = false;
array_walk($array, function (&$value) use (&$array, &$replaced) {
    echo "$value;";
    if (!$replaced) {
        $replaced = true;
        $array = [9, 8];
    }
});
echo "\n";
$array = [1, 2];
try {
    array_walk($array, function (&$value) use (&$array) {
        echo "$value;";
        $array = 99;
    });
} catch (Throwable $error) {
    echo get_class($error), ':', $error->getMessage(), "\n";
}
$array = [[1], [2]];
array_walk_recursive($array, function (&$value) use (&$array) {
    echo "$value;";
    if ($value === 1) $array[0][] = 3;
});
echo "\n";
