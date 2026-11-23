<?php
class Outer {
    public function install() {
        function installed() {
            class FromFunction {}
            echo __CLASS__, 'x', (new FromFunction)::class, "\n";
        }
        return fn() => self::class;
    }
}
$closure = (new Outer)->install();
echo $closure(), "\n";
installed();

class InvokeValue {
    function __construct(public $value) {}
    function __invoke($ignored) { echo $this->value, "\n"; }
    function method($ignored) { echo $this->value, "\n"; }
}
function replaceCallee() {
    $GLOBALS['callee'] = null;
    return 0;
}
$callee = new InvokeValue('object');
$callee(replaceCallee());
$captured = 'closure';
$callee = fn($ignored) => print "$captured\n";
$callee(replaceCallee());
$callee = [new InvokeValue('array'), 'method'];
$callee(replaceCallee());
unset($closure);
try { new Closure; } catch (Throwable $error) { echo spl_object_id($error), "\n"; }
echo spl_object_id($object = new stdClass), "\n";

class HiddenMethods {
    private function hidden() {}
    private static function hiddenStatic() {}
}
foreach (['HiddenMethods::hidden', ['HiddenMethods','hiddenStatic'], [1,2], ['HiddenMethods', 2], ['a'=>0, 'b'=>1]] as $callback) {
    try { Closure::fromCallable($callback); } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
}
try { get_called_class(); } catch (Throwable $error) { var_dump($error->getTrace()); }

function &returnedValue() {
    try {
        return 42;
    } finally {
        echo "finally\n";
    }
}
function &returnedNothing() {
    return;
}
function &fellThrough() {
}
returnedValue();
returnedNothing();
fellThrough();

function &returnChain() { return returnedValue(); }
function &secondReturnChain() { return returnChain(); }
$reference =& secondReturnChain();
var_dump($reference);
function &emptyReturnChain() { return fellThrough(); }
$reference =& emptyReturnChain();
var_dump($reference);
