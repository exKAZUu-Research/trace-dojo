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
        var_dump(array_slice($packed, 1, 2, true), array_slice($packed, -2, 2, true));
        $sparse = [2 => 'a', 5 => $read(), 8 => 'b'];
        var_dump(array_slice($sparse, -1, null, true));
        array_shift($sparse);
        var_dump(array_slice($sparse, 1, 2, true), array_slice($sparse, -1, 2, false));
        $sparse = [2 => 'a', 5 => $read(), 8 => 'b', 'hidden' => $read()];
        array_shift($sparse);
        var_dump(array_key_exists('hidden', $sparse), array_slice($sparse, 1, 2, true));
        $mixed = [1, $read(), 2, 'name' => 4];
        var_dump(array_shift($mixed), $mixed);
        foreach ([['h' => $read(), 2 => 'a', 8 => 'b'], [1, $read(), 3, 'x' => 4]] as $shifted) {
            foreach ($shifted as $key => &$slot) {
                echo "$key=$slot;";
                if ($key === 2) array_shift($shifted);
            }
            unset($slot);
            echo "\n";
        }
        $shifted = [0, 1, $read(), 3, 4];
        foreach ($shifted as $key => &$slot) {
            echo "$key=$slot;";
            if ($key === 4) {
                array_shift($shifted);
                $shifted[20] = 20;
            }
        }
        unset($slot);
        echo "\n";
        $shifted = [2 => 'a', 5 => $read(), 8 => 'b', 'hidden' => $read()];
        foreach ($shifted as $key => &$slot) {
            echo "$key=$slot;";
            if ($key === 8) {
                array_shift($shifted);
                $copy = $shifted;
                $shifted[] = 9;
                $shifted[] = 10;
            }
        }
        unset($slot);
        echo "\n";
        $shifted = [2 => 'a', 5 => $read(), 8 => 'b'];
        array_shift($shifted);
        $shifted[] = 9;
        try { $shifted[] = 10; }
        catch (Error $error) { echo $error->getMessage(), "\n"; }

        $array = ['x' => $read(), 'y' => 5];
        var_dump(array_combine(['u', 'v'], $array));
        try { array_combine(['u'], $array); }
        catch (ValueError $error) { echo $error->getMessage(), "\n"; }
        foreach (['min', 'max'] as $extreme) {
            try { $extreme([$read()]); }
            catch (ValueError $error) { echo $error->getMessage(), "\n"; }
            var_dump($extreme([$read(), null]));
        }
        $compareKeys = function ($a, $b) { echo "keys:", $a, '=', $b, "\n"; return $a <=> $b; };
        var_dump(array_udiff_assoc([1], [$read(), 5], $compareKeys));
        var_dump(array_diff_key([1], [$read(), 5]), array_intersect_key([1], [$read(), 5]));
        var_dump(strtr('x', ['x' => $read()]), strtr('1', [1 => $read()]));
        var_dump(array_diff([$read()], [1]), array_diff(['x' => $read()], [1]));
        var_dump(array_diff([1, $read()], []), array_diff(['x' => $read(), 'y' => 5], [], []));
        $sparse = [2 => 4, 5 => $read(), 8 => 2];
        $compare = fn ($a = null, $b = null) => $a <=> $b;
        var_dump(array_diff_ukey($sparse, [3, 1, 2], $compare), array_uintersect($sparse, [2, 4], $compare));
        try { array_uintersect([1, $read(), 2], [1, 2], $compareKeys); }
        catch (ArgumentCountError $error) { echo $error->getMessage(), "\n"; }
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
