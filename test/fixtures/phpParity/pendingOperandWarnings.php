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

reportOperation(function(){
    try { $x=$unread; } finally { var_dump(array_key_exists('x', get_defined_vars()), $x); }
});
reportOperation(function(){
    $array=['x'=>4];
    try { $array['x']=$unread; } finally { var_dump($array); }
});
reportOperation(function(){
    $array=[];
    try { $array[]=$unread; } finally { var_dump($array); }
});
class StoredOperand {
    public int $strict=4;
    public ?int $nullable=3;
    public static $global=1;
    public int $hook { set { echo "unexpected hook\n"; } }
}
$ordinary=new stdClass;
$typed = new StoredOperand;
reportOperation(fn()=>$ordinary->value=$unread);
reportOperation(fn()=>$typed->strict=$unread);
reportOperation(fn()=>$typed->nullable=$unread);
reportOperation(fn()=>$typed->extra=$unread);
reportOperation(fn()=>$typed->hook=$unread);
reportOperation(fn()=>StoredOperand::$global=$unread);
var_dump($ordinary->value,$typed->strict,$typed->nullable,$typed->extra,StoredOperand::$global);
class LiteralName { const KEY = 'dynamicName'; }
reportOperation(function() {
    try { ${LiteralName::KEY} += 1; } finally { var_dump(array_key_exists('dynamicName', get_defined_vars())); }
});
reportOperation(fn()=>~$unread);
reportOperation(function() { $u %= NAN; });
reportOperation(function() { $u |= INF; });
reportOperation(function() { $u <<= 1e30; });

$collection = new ArrayObject;
reportOperation(fn()=>$collection['number']+=1);
reportOperation(fn()=>$collection['text'].='x');
reportOperation(fn()=>$collection['undefined']+=$unknown);
reportOperation(fn()=>$collection['division']/=0);
reportOperation(fn()=>$collection['inc']++);
var_dump($collection->getArrayCopy());
$iterator = new ArrayIterator;
reportOperation(fn()=>$iterator['number']+=2);
var_dump($iterator->getArrayCopy());
$plain=[];
reportOperation(function()use(&$plain){$plain['missing'] += 1;});
var_dump($plain);

restore_error_handler();
$ordinary=new stdClass;
reportOperation(fn()=>$ordinary[0] += $unknown);
reportOperation(fn()=>$ordinary['a']['b'] .= $unknown);
$failure = new SplObjectStorage;
$key = new stdClass;
reportOperation(fn()=>$failure[$key] += 1);
reportOperation(fn()=>$failure->offsetGet($key));
$failure[$key]=3;
$failure[$key]+=2;
var_dump($failure[$key]);
$fixed=new SplFixedArray(2);
reportOperation(fn()=>$fixed[9] += 1);
reportOperation(fn()=>$fixed->offsetGet(9));
$queue=new SplQueue;
$queue->push(1);
reportOperation(fn()=>$queue[5] += 1);
reportOperation(fn()=>$queue->offsetGet(5));

$x=42;
echo ${"GLOBALS"}["x"],"\n";
${"GLOBALS"}["globalAdded"]=8;
echo $globalAdded,"\n";
