<?php
foreach (['usort', 'uasort', 'uksort'] as $sort) {
    $values = [2 => 'b', 1 => 'a', 0 => 'c'];
    $sort($values, function ($a, $b) use (&$values) {
        $values = [];
        return $a <=> $b;
    });
    var_dump($values);
}
$values = [3, 1, 2];
try {
    usort($values, function ($a, $b) use (&$values) {
        $values = [];
        if ($a === 3) return $a <=> $b;
        throw new Exception('comparison');
    });
} catch (Exception $e) {
    echo $e->getMessage(), "\n";
}
var_dump($values);
usort($values, fn($a, $b) => NAN);
var_dump($values);
