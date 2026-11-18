<?php
function reportOperation($run) {
    try { $run(); } catch (Throwable $error) {
        echo $error::class, ': ', $error->getMessage(), ' (', $error->getPrevious()?->getMessage(), ")\n";
    }
}
set_error_handler(function($level, $message) {
    echo $message, "\n";
    throw new ErrorException($message);
});
foreach ([
    function() { $result = $u / 0; },
    function() { $result = $u % 0; },
    function() { $result = 1 / $u; },
    function() { $result = 1 % $u; },
    function() { $result = $u << -1; },
    function() { $result = $u / $v; },
    function() { $result = $u * '5a'; },
    function() { $result = $u - []; },
    function() { try { $u /= '5a'; } finally { var_dump($u); } },
    function() { try { $u += '5a'; } finally { var_dump($u); } },
    function() { try { $u |= 2.5; } finally { var_dump($u); } },
    function() { try { $u %= '2.5'; } finally { var_dump($u); } },
    function() { try { $u <<= 2.5; } finally { var_dump($u); } },
    function() { try { $u .= []; } finally { var_dump($u); } },
    function() { try { ${'lit'} += 1; } finally { var_dump($lit); } },
    function() { try { ${'ab'}++; } finally { var_dump($ab); } },
    function() { try { ${'c'.'d'} .= 'x'; } finally { var_dump($cd); } },
] as $run) reportOperation($run);
class StringValue { function __toString() { echo "cast\n"; return 'text'; } }
reportOperation(function() { try { $u .= new StringValue; } finally { var_dump($u); } });

class DynamicObject {}
$object = new DynamicObject;
reportOperation(function()use($object) { $object->ordinary = 1; });
reportOperation(function()use($object) { $object->coalescing ??= 2; });
reportOperation(function()use($object) { $object->append[] = 3; });
reportOperation(function()use($object) { $object->nested['k']['j'] = 4; });
reportOperation(function()use($object) { $object->member->x = 5; });
reportOperation(function()use($object) { $ref =& $object->alias; });
reportOperation(function()use($object) { $x=3; $object->bound =& $x; });
reportOperation(function()use($object) { foreach ($object->iteration as &$value) {} });
var_dump($object);
restore_error_handler();

set_error_handler(function($level, $message) {
    echo $message,"\n";
    throw new ErrorException($message);
}, E_DEPRECATED);
reportOperation(function()use($object) { $object->onlyDeprecation += 3; });
var_dump($object->onlyDeprecation);
restore_error_handler();

class OperatorTarget implements ArrayAccess {
    function offsetExists($offset): bool { return true; }
    function offsetGet($offset): mixed {
        echo 'get:',var_export($offset,true),"\n";
        $GLOBALS['right'] = 9;
        return 2;
    }
    function offsetSet($offset,$value): void { echo 'set:',$value,"\n"; }
    function offsetUnset($offset): void {}
}
$target=new OperatorTarget;
$target[$key] += $rhs;
$target['y'] .= $other;
$right=4;
$target['z'] += $right;
$nested=[$target];
$nested[0]['q'] += $stillMissing;
$native=new ArrayObject(['k'=>2]);
$native['k'] += $missingNative;
var_dump($native['k']);
set_error_handler(function($level,$message) { echo $message,"\n"; throw new ErrorException($message); });
reportOperation(function()use($target) { $target['warn'] += $unknown; });
reportOperation(function()use($native) { $native['k'] += $unknown; });
var_dump($native['k']);
