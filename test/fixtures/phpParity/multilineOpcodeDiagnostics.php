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

[$missingItem] =
    $missingList;
$missingClass = 1;
try { var_dump($unreadObject instanceof
    $missingClass); }
catch (Throwable $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
$missingClass = stdClass::class;
var_dump($readObject instanceof
    $missingClass);

$classPrefix = 'Missing';
try { ($classPrefix .
    'Class')
    ::method(); }
catch (Throwable $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
try { (PHP_EOL
    )
    ::$property; }
catch (Throwable $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }

$floatKeys = [
    1.5 =>
    null ??
    2,
    2.5 =>
    __LINE__ .
    "x",
    3.5 =>
    fn() =>
    1,
    4.5 =>
    <<<TEXT
    value
    TEXT,
];

[
    $missingElement
] =
    $notAssigned;
$nested = [[]];
[[
    $nestedMissing
]] =
    $nested;
$some = [1];
[&$alias,
    $missingAfterReference] =
    $some;
foreach ([[]] as
    [$missingDuringIteration]) {}

$nullSource = null;
[$beforeReference, &$reference] = $nullSource;
var_dump($nullSource);
$emptySource = [];
[[&$nestedReference], $missingSibling] = $emptySource;
var_dump($emptySource);

try { echo ('Missing')
    ::
    $property; }
catch (Throwable $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
try { echo (true ?
    'Missing' : 'Other')
    ::CONSTANT; }
catch (Throwable $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
$array = [
    1.5 =>
    true ?
    [
        1
    ] :
    2
];
$array = [
    1.5 =>
    [
        1
    ]
    [0]
];
$array = [
    1.5 =>
    $undefinedBase
    [0]
];

[
    ,
    $secondMissing
] =
    $unsetList;
[$missing] = [
];
try { echo (1 ?
    $classPrefix :
    'Other')
    ::CONSTANT; }
catch (Throwable $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
$array = [
    1.5 =>
    null ??
    [
        2
    ]
];
$array = [
    1.5 =>
    [
        1
    ] ===
    [
        1
    ]
];
try {
    $array = [
        1.5 =>
        1 <<
        -1
    ];
} catch (ArithmeticError $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
$array = [
    1.5 =>
    $undefinedObject
    ->property
];

try {
    $undefinedReceiver
        ->method
        ();
} catch (Error $error) { echo $error->getMessage(), ' at ', $error->getLine(), "\n"; }
$array = [
    1.5 =>
    null ??
    "left" .
    "right"
];
$array = [
    1.5 =>
    null ??
    fn() => 1
];
$counter = 0;
$array = [
    1.5 =>
    $counter +=
    1
];
try { $missingReceiver
    ->{$missingMethod}
    (); }
catch (Error $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
$array = [
    1.5 =>
    $uninitialized ??=
    1 +
    1,
    2.5 =>
    [$item] =
    [1],
    3.5 =>
    $reference =&
    $item,
    4.5 =>
    ("a" .
    "b"),
    5.5 =>
    null ??
    (fn () => 1)
];
$array = [
    1.5 =>
    !(
    "a" .
    "b")
];
$array = [
    1.5 =>
    ["a" .
    "b"]
    [0]
];

$namePrefix = 'missing';
echo ${$namePrefix .
    "Variable"
};
try {
    echo stdClass::{
        $namePrefix .
        "Constant"
    };
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try {
    (new stdClass)->{
        <<<TEXT
        missing
        TEXT
    }();
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
$object->{
    $namePrefix .
    "Property"
} ??= $missingValue;

$prefix = 'a';
$object = new stdClass;
try {
    $object->{
        "$prefix
"
    }();
} catch (Error $error) { echo $error->getLine(), "\n"; }
try {
    $object->{
        "{$prefix}a
"
    }();
} catch (Error $error) { echo $error->getLine(), "\n"; }
try {
    $object->{
        <<<NAME

${prefix}
b
NAME
    }();
} catch (Error $error) { echo $error->getLine(), "\n"; }
$target = [];
$target[
    $prefix .
    'b'
] = $unknown;
$target[
    $prefix .
    'c'
] ??= $unknown;
$target[
    'a' .
    'd'
] ??= $unknown;
$object->{
    'a' .
    'b'
} ??= $unknown;
${$prefix .
    'b'
} = $unknown;
${$prefix .
    'c'
} ??= $unknown;
${$prefix .
    'd'
} .=
    $unknown;

function fetchCompoundName() { echo 'name;'; return 'uncaptured'; }
function fetchCompoundValue() { echo 'value;'; return 'suffix'; }
${fetchCompoundName()} .= fetchCompoundValue();

const LOOKUP_NAME = 'prefix';
echo "${LOOKUP_NAME
}";
echo "${absent[
    0]}";
try {
    echo "$prefix ${
        absentName
    }";
} catch (Error $error) { echo $error->getMessage(), "\n"; }

$vector = [];
$scalar = 2;
echo $vector[
    1 +
    2
];
echo $scalar[
    $prefix .
    'x'
];
try {
    unset($text[
        $prefix .
        'x'
    ]);
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
echo "items
$vector
{$vector}";
echo <<<LINES
items
$vector
{$vector}
LINES;
try {
    $plain = new stdClass;
    echo "object
$plain";
} catch (Throwable $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
