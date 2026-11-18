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

$className = 'MissingClass';
try {
    $className
        ::$value
        = 1;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    $className
        ::f();
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    echo $className
        ::CONSTANT;
} catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }

$uninitialized
    ??=
    $missing;
$target = [];
$target[$unknownKey][$unknownNestedKey] ??= $unknownValue;
$target = new ArrayObject;
$target[$unknownKey] ??= $unknownObjectValue;
$index = 0;
$target = [];
$target[$index] ??= ($index = 1);
var_dump($target);

const FIRST = 1,
    SECOND = [
        1.5 => 2
    ],
    THIRD = [
        2.5 => 3
    ];
const FOURTH = [
    3.5 =>
        FIRST
];
class DeferredDiagnosticArray {
    const VALUE = [
        1.5 =>
            [
                1
            ]
    ];
    public $value = [
        2.5 =>
            2
    ];
}
echo count(DeferredDiagnosticArray::VALUE), ';';
new DeferredDiagnosticArray;
echo "\n";
$array = [
    1.5 =>
        [1]
        [0]
];
$array = [
    1.5 =>
        PHP_EOL .
        "a"
];

$plain =
    $undefinedAssignment;
$first =
    $second =
        $undefinedChain;

$invalidClassName = 1;
foreach ([
    fn () => ('Missing'
        . 'Class')
        ::$value,
    fn () => ('MissingClass'
        )
        ::$value,
    fn () => new stdClass
        instanceof
        $invalidClassName,
] as $read) {
    try { $read(); }
    catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
}
$array = [
    1.5 =>
        [1]
        [0]
        + 1
];
$array = [
    1.5 =>
        "a"
        [0]
        [0]
];

$array = [];
$array['x']['y'] ??= $array;
var_dump($array);
$object = new stdClass;
$object->{$missingName} ??= $missingValue;
foreach ([1, false] as $scalar) {
    try { $scalar[$missingOffset] ??= $missingValue; }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
