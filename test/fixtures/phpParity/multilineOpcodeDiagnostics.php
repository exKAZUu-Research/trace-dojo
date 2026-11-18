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
