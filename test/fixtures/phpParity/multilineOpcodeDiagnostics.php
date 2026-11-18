<?php
echo 'array:',
    [1],
    "\n";
try {
    $array = [
        'key' => MISSING_ARRAY_CONSTANT,
    ];
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try { var_dump(
    MISSING_ARGUMENT
); } catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
$text = 'prefix';
$text .=
    $undefined;
try {
    $text +=
        [1];
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
$empty = [];
[$one,
 $two,
 $three] = $empty;
$closure = function () use (
    $unboundOne,
    $unboundTwo
) {};
try { exit(
    [1]
); } catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    clone
        1;
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }

list($outer,
    list($inner)) = [1, 2];
[$outer,
    [$inner]] = [1, 2];
print
    [1];
$converted = (string)
    [1];
echo
    [1];
try {
    $nested = [1];
    $nested
        [0]
        [1]
        = 2;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
const DUPLICATE = 1;
const
    DUPLICATE =
        2;
$floats = [1.5 => 1,
    2.5 => 2];
$exception = new
    Exception;
echo $exception->getLine(), "\n";
try { throw new
    Exception('multiline');
} catch (Exception $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
