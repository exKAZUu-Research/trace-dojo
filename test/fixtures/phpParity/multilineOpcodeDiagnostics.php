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

$floatKey = 3.5;
$a1 = [
    1.5
    =>
    1];
$a2 = [
    $floatKey
    =>
    1];
try {
    $badKey = [];
    $a3 = [
        $badKey
        =>1];
} catch (TypeError $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    $a4 = [
        new stdClass
        =>1];
} catch (TypeError $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    $nestedArray = [1];
    $nestedArray
        [0]
        []
        = 2;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    $nestedString = "ab";
    $nestedString
        [0]
        [0]
        = 2;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
[[$first],
 [$second]] = [[], []];
const MANY = 1,
      OTHER = 2,
      MANY = 3;
$exception = new
    class extends Exception {};
echo $exception->getLine(), "\n";
$exception = new
    (
      'Exception'
    );
echo $exception->getLine(), "\n";
$property = new stdClass;
$property
    ->unset
    .=
    'test';

$object = new stdClass;
$object
    ->first
    ++;
$incremented = [];
$incremented
    ['first']
    ++;
++$incremented
    ['prefix'];
$incremented
    ['outer']
    ['inner']
    ++;
$incremented
    ['append']
    .=
    $unknownArray;
$object
    ->second
    .=
    $unknownObject;
class StaticDiagnostics {
    public static $value = 0;
    public static int $typed = 0;
    public static $unset = null;
}
StaticDiagnostics::$value
    +=
    $unknownStatic;
try {
    StaticDiagnostics
        ::$typed
        .=
        'a';
} catch (TypeError $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
$object
    ->nested
    ['key']
    .=
    'a';
$array = [
    1.5 => [
        1
    ]
];
$array = [
    1.5 =>
        [
            2.5 => 1
        ]
];

$target = [];
$target
    ['new']
    ??=
    $absentArray;
$object
    ->another
    ??=
    $absentProperty;
StaticDiagnostics
    ::$unset
    ??=
    $absentStatic;

try {
    MissingClass
        ::$value
        ++;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    MissingClass
        ::
            $value
        = 1;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
$array = [
    1.5 =>
        1 +
        2
];
$array = [
    1.5 =>
        "a" .
        "b"
];
$array = [
    1.5 =>
        1 ?
        2 :
        3
];
const
    FOLDED_ARRAY = [
        1.5 =>
            1
    ];
function constantArrayDefault($value = [
    1.5 =>
        1
]) {}
constantArrayDefault();
echo "finished diagnostics\n";
