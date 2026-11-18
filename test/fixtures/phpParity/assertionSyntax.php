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
