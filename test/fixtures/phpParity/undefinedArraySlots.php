<?php
class UndefinedArrayChild extends RecursiveArrayIterator {
    function __construct($items, private bool $child = false) { parent::__construct($items); }
    function getChildren(): ?RecursiveArrayIterator { return new self($this->current(), true); }
    function __destruct() {
        if (!$this->child) return;
        global $iterator;
        $read = fn () => $iterator->getSubIterator();
        foreach ([
            ['x' => $read()], ['x' => $read(), 'y' => 5], ['y' => 5, 'x' => $read()],
            [$read()], [5, $read()], [$read(), 5], [5, $read(), 6],
        ] as $array) {
            $hole = array_key_exists('x', $array) ? 'x' : (isset($array[0]) ? 1 : 0);
            var_dump(array_key_exists($hole, $array), array_keys($array), array_keys(array_values($array)));
            var_dump(json_encode($array), json_last_error(), json_encode($array, JSON_PARTIAL_OUTPUT_ON_ERROR));
            var_dump(array_key_first($array), array_key_last($array), array_first($array), array_last($array));
            $copy = $array;
            var_dump(current($copy), key($copy), next($copy), key($copy), end($copy), prev($copy), reset($copy));
            $copy = $array;
            var_dump(array_shift($copy), $copy, array_keys($copy));
            $copy = $array;
            var_dump(array_pop($copy), $copy, array_keys($copy));
            $copy = $array;
            $copy['new'] = 9;
            var_dump(count($copy), array_keys($copy));
        }
        $array = ['x' => $read(), 'y' => 5];
        var_dump([...$array], array_merge($array, ['z' => 6]), array_slice($array, 0), array_slice($array, -1));
        var_dump(array_reverse($array), array_change_key_case($array, CASE_UPPER));
        $report = function ($value, $key) { echo $key, '=', $value, "\n"; return true; };
        var_dump(array_find($array, $report));
        array_walk($array, $report);
        $nested = ['nested' => $array];
        array_walk_recursive($nested, $report);
    }
}
$iterator = new RecursiveIteratorIterator(new UndefinedArrayChild([[1], 2]));
foreach ($iterator as $ignored) {}
