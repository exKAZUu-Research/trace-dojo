<?php
function &invalidReference(): int {
    return 'wrong';
}
function &missingReference(): int {}
function &coercedReference(): int {
    return '7';
}
class ReferenceReturns {
    static function &badMethod(): int {
        try {
            return 'wrong';
        } finally {
            echo "finally\n";
        }
    }
}
foreach ([
    invalidReference(...),
    missingReference(...),
    ReferenceReturns::badMethod(...),
    function &(): int { return 'wrong'; },
    coercedReference(...),
] as $call) {
    try {
        var_dump($call());
    } catch (TypeError $error) {
        echo $error->getMessage(), ' at ', $error->getLine(), "\n";
    }
}
