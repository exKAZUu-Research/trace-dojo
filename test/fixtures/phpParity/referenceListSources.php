<?php
$nullSource = null;
[[] => $missing, 'created' => &$created] = $nullSource;
var_dump($missing, $nullSource);
$scalarSource = 5;
[1.5 => $missing] = $scalarSource;
var_dump($missing);

foreach ([[1, 2], [[1], 2], ['value', 2], [null, 2]] as $source) {
    try {
        [$source, &$value] = $source;
        var_dump($source, $value);
    } catch (Error $error) { echo $error->getMessage(), "\n"; }
}

class ListSource {
    public array $uninitialized;
    public ?int $nullable = null;
    public static ?int $shared = null;
}
$typed = new ListSource();
try { [&$value] = $typed->uninitialized; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { [$first, &$value] = $typed->nullable; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
try { [&$value] = ListSource::$shared; }
catch (Error $error) { echo $error->getMessage(), "\n"; }
