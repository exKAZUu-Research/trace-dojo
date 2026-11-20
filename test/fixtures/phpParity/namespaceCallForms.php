<?php
namespace Lesson;
const UPPER = 1;
const
    UPPER = 2;
function forwards($value) {
    var_dump('func_num_args'(), ('func_num_args')(), ("\\func_num_args")());
    var_dump(\call_user_func('compact', 'value'), \call_user_func_array('compact', ['value']));
    foreach ([
        fn () => call_user_func('compact', 'value'),
        fn () => call_user_func_array('func_get_args', []),
        fn () => \call_user_func('\\compact', 'value'),
    ] as $call) {
        try { $call(); }
        catch (\Throwable $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
    }
    $dynamic = 'func_get_arg';
    foreach ([-1, 0, 5] as $index) {
        try { $dynamic($index); }
        catch (\Throwable $error) { echo $error->getMessage(), "\n"; }
    }
}
forwards(42);
$dynamic = 'func_get_arg';
try { $dynamic(-1); }
catch (\Throwable $error) { echo $error->getMessage(), "\n"; }

const FULLY_QUALIFIED = \TrUe;
function defaultLiterals(bool $truth = \TRUE, $falsehood = \false, $nothing = \null) {
    var_dump($truth, $falsehood, $nothing);
}
var_dump(\true, \FALSE, \NULL, FULLY_QUALIFIED);
defaultLiterals();
class StaticForwarding {
    const NAME = 'func_num_args';
    const PREFIX = 'func_num_';
    static function run($value) {
        var_dump((self::NAME)(), \call_user_func('func_' . 'num_args'));
        foreach ([
            fn () => \call_user_func(self::NAME),
            fn () => \call_user_func_array(self::NAME, []),
            fn () => \call_user_func(self::PREFIX . 'args'),
            fn () => \call_user_func(StaticForwarding::NAME),
        ] as $forward) {
            try { $forward(); }
            catch (\Error $error) { echo $error->getMessage(), "\n", $error->getTraceAsString(), "\n"; }
        }
    }
}
StaticForwarding::run(42);

foreach (['True', 'fAlSe', 'NULL', '\true', '\FALSE', '\null', 'Lesson\TRUE'] as $spelling) {
    var_dump(defined($spelling));
    if (defined($spelling)) var_dump(constant($spelling));
}
var_dump(define('\true', 5), constant(str_repeat(chr(92), 2) . 'true'), constant('\true'));

namespace LiteralSource;
const YES = 7;
const NO = 0;
const EMPTY_STRING = 'aliased null';

namespace LiteralUser;
use const LiteralSource\{YES as true, NO as FALSE};
use LiteralSource\{const EMPTY_STRING as null};
function literalAliasDefault(int $value = true) { var_dump($value); }
var_dump(true, TRUE, false, FALSE, null, NULL, \true);
literalAliasDefault();
const IMPORTED = true;
class ImportedLiteral {
    const CHOICE = FALSE;
    public $value = null;
}
var_dump(IMPORTED, ImportedLiteral::CHOICE, (new ImportedLiteral)->value);

function writesReference(&$value) { echo $value, "\n"; }
class ReferenceArgument { public $value = 'namespaced argument'; }
writesReference((new ReferenceArgument())->value);
