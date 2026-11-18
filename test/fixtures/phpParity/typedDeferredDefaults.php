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

class DeferredLines {
    const TEXT = NON_NUMERIC;
    function member(
        int $first =
            self::TEXT
    ) {}
}
function deferredConcat(
    int $value = NON_NUMERIC .
        'more'
) {}
function deferredArray(
    string $value = [
        NON_NUMERIC,
        NON_NUMERIC
    ]
) {}
function skippedDefaults(int $first = NON_NUMERIC, $second = 2, $third = 3) {}
function coercedPrefix(int|float $first, int|float $second) {}
function coercedRest(string $first, int ...$rest) {}
foreach ([
    fn () => (new DeferredLines)->member(),
    fn () => deferredConcat(),
    fn () => deferredArray(),
    fn () => skippedDefaults(third: 3),
    fn () => coercedPrefix('1', 'text'),
    fn () => coercedPrefix(second: 'text', first: '1'),
    fn () => coercedRest('1', '2', 'text'),
    fn () => coercedRest('1', extra: '2', invalid: 'text'),
] as $call) {
    try { $call(); }
    catch (TypeError $error) {
        echo $error->getLine(), ':', $error->getTraceAsString(), "\n";
    }
}
