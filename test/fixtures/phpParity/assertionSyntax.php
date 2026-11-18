<?php
function message($run) {
    try { $run(); } catch (AssertionError $error) { echo json_encode($error->getMessage()), "\n"; }
}
$x = 0;
message(fn() => assert(false && missing()));
message(fn() => assert(assertion: false));
message(fn() => assert(assertion: ($x === 1)));
message(fn() => assert($x += 0));
message(function () { $x = null; assert($x ??= 0); });
message(function () { $x = 0; $y = 0; assert($x =& $y); });
message(fn() => assert(match ($x) { 0 => false, default => true }));
message(fn() => assert(__LINE__ === 0));
message(fn() => assert(__FUNCTION__ === 'x'));
message(fn() => assert(clone new stdClass === null));
message(fn() => assert(NAN xor true));
message(fn() => assert(assertion: false, description: 'given'));
error_reporting(E_ALL & ~E_DEPRECATED);
class AssertionHandler {
    public $value = 'live';
    function __invoke(...$args) { echo $this->value, "\n"; }
    function __destruct() { echo "dropped\n"; }
}
assert_options(ASSERT_CALLBACK, new AssertionHandler);
echo "registered\n";
message(fn() => assert(false));
assert_options(ASSERT_CALLBACK, null);
echo "done\n";

$x = 0;
$n = 'x';
foreach ([
    fn() => assert("value:$x" === "expected"),
    fn() => assert($$n === 1),
    fn() => assert($$n += 0),
    fn() => assert(false && fn() => 0),
    fn() => assert(false && function () { return 0; }),
    fn() => assert(false && (function ($a) { return $a; })(0)),
    fn() => assert(false && static function &(int $v, ...$args) use (&$x): int { if ($v) return $x; return $v; }),
] as $check) {
    try { $check(); } catch (AssertionError $error) { echo $error->getMessage(), "\n"; }
}
