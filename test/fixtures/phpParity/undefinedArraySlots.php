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
            $copy[] = 9;
            var_dump(array_keys($copy), array_is_list($copy));
            $copy = $array;
            $copy['new'] = 9;
            var_dump(count($copy), array_keys($copy));
        }
        $afterRemoval = [$read(), 2, 3];
        array_pop($afterRemoval);
        unset($afterRemoval[1]);
        var_dump(count($afterRemoval), array_keys($afterRemoval));

        $packed = [1, $read(), 3];
        var_dump(array_slice($packed, 0, 2, true), array_slice($packed, 1, 2, true));
        unset($packed[1]);
        var_dump(count($packed), array_keys($packed));
        $packed[1] = 2;
        var_dump(count($packed), array_keys($packed), json_encode($packed));
        $sparse = [2 => 'a', 5 => $read(), 8 => 'b'];
        var_dump(array_slice($sparse, -1, null, true));
        $mixed = [1, $read(), 2, 'name' => 4];
        var_dump(array_shift($mixed), $mixed);

        $array = ['x' => $read(), 'y' => 5];
        var_dump(array_combine(['u', 'v'], $array));
        try { array_combine(['u'], $array); }
        catch (ValueError $error) { echo $error->getMessage(), "\n"; }
        var_dump([...$array], array_merge($array, ['z' => 6]), array_slice($array, 0), array_slice($array, -1));
        var_dump(array_reverse($array), array_change_key_case($array, CASE_UPPER));
        $report = function ($value, $key) { echo $key, '=', $value, "\n"; return true; };
        var_dump(array_find($array, $report));
        array_walk($array, $report);
        $nested = ['nested' => $array];
        array_walk_recursive($nested, $report);
        foreach ([new ArrayIterator($array), (new ArrayObject($array))->getIterator()] as $iteratorView) {
            foreach ($iteratorView as $key => $value) echo $key, '=', $value, "\n";
            var_dump(iterator_count($iteratorView), iterator_to_array($iteratorView));
            $iteratorView->seek(0);
            var_dump($iteratorView->key(), $iteratorView->current());
            $iteratorView->next();
            var_dump($iteratorView->valid());
        }
    }
}
$iterator = new RecursiveIteratorIterator(new UndefinedArrayChild([[1], 2]));
foreach ($iterator as $ignored) {}
