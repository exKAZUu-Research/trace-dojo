<?php
var_dump([
    NAN .
    'key' => 1,
]);
var_dump([
    true &&
    NAN => 2,
]);
var_dump([
    NAN ||
    true =>
    3,
]);
var_dump([
    [
        NAN || true
    ],
]);
var_dump([...
    [
        NAN || true
    ]
]);
var_dump([1, [
    NAN || true
]]);
function declaredArray() {
    static $a = [
        NAN ||
        true,
    ];
    return $a;
}
var_dump(declaredArray());
echo count([
    [
    ],
    NAN || true
]), "\n";
echo count([
    ...[
    ],
    NAN || true
]), "\n";
