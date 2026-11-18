<?php
const PARSEABLE = '5';
const NON_NUMERIC = 'text';
function acceptsInt(int $value = PARSEABLE) { var_dump($value); }
function acceptsString(string $value = PHP_INT_SIZE + 1) { var_dump($value); }
function failsInt(int $value = NON_NUMERIC) {}
class DefaultScope {
    const NUMBER = 6;
    function defaults(float $value = self::NUMBER) { var_dump($value); }
}
class RuntimeTypedConstant {
    const int NUMBER = self::TEXT;
    const TEXT = 'not a number';
}
acceptsInt();
acceptsString();
(new DefaultScope)->defaults();
try { failsInt(); }
catch (TypeError $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
try { echo RuntimeTypedConstant::NUMBER; }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
$closure = function (int $value = NON_NUMERIC) {};
try { $closure(); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }

function namedDefaults(
    $first = 1,
    int $number =
        NON_NUMERIC,
    $tail = 2
) {}
try { namedDefaults(tail: 3); }
catch (TypeError $error) {
    echo $error->getLine(), ':', $error->getMessage(), "\n", $error->getTraceAsString(), "\n";
}
function unpackedDefaults(int $number = NON_NUMERIC, ...$extra) {}
try { unpackedDefaults(extra: 1); }
catch (TypeError $error) { echo $error->getTraceAsString(), "\n"; }
$refDefault = function (
    int $number =
        NON_NUMERIC
) {};
try { $refDefault(); }
catch (TypeError $error) { echo $error->getLine(), ':', $error->getMessage(), "\n"; }
