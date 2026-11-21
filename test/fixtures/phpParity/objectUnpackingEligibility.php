<?php
function collect(...$values) { var_dump($values); }
foreach ([(object)["a" => 1], new stdClass(), 1, null, false] as $value) {
    try { var_dump([...$value]); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
    try { collect(...$value); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
var_dump([...new ArrayIterator([1, "a" => 2])]);
collect(...new ArrayIterator([1, "a" => 2]));
