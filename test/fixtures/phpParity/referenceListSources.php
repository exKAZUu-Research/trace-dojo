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

class DynamicListSource {
    public function __get(string $name) { echo "getting ", $name, "\n"; return []; }
}
$dynamic = new DynamicListSource();
[&$value] = $dynamic->missing;
var_dump($value);
$string = 'value';
try { [1.5 => &$value] = $string; }
catch (Error $error) { echo $error->getMessage(), "\n"; }

$falseSource = false;
set_error_handler(function () { throw new Exception('unexpected deprecation'); }, E_DEPRECATED);
[$falseSource[0][0], &$tail] = $falseSource;
restore_error_handler();
var_dump($falseSource);
