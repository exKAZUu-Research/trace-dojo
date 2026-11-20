<?php
function identity($value) { return $value; }
function staticCall() {
    static $value = identity([
        true &&
        NAN,
        2 => [NAN || true],
        NAN .
        'x',
    ]);
    return $value;
}
function unpackedCall() {
    static $value = identity(...[
        identity(1) && NAN || true,
    ]);
    return $value;
}
function ordinaryArray() {
    return identity([identity(1),
        NAN || true,
    ]);
}
echo 'start', "\n";
var_dump(staticCall(), unpackedCall(), ordinaryArray());
