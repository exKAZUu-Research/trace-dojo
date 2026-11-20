<?php
foreach ([['a' => 1, 'b' => 2, 'c' => 3], [0 => 1, 3 => 2, 6 => 3], ['a' => 1, 4 => 2, 'c' => 3]] as $input) {
    foreach (['array_shift', 'array_unshift'] as $action) {
        $apply = $action === 'array_shift'
            ? fn (&$array) => array_shift($array)
            : fn (&$array) => array_unshift($array, 8, 9);
        $array = $input;
        $first = true;
        foreach ($array as $key => &$value) {
            echo "$key=$value;";
            if ($first) $apply($array);
            $first = false;
        }
        unset($value);
        echo "\n";
        $first = true;
        $array = $input;
        array_walk($array, function (&$value, $key) use (&$array, &$first, $apply) {
            echo "$key=$value;";
            if ($first) $apply($array);
            $first = false;
        });
        echo "\n";
    }
}
