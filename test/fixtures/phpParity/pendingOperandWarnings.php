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

set_error_handler(function($level,$message) { echo $message,"\n"; throw new ErrorException($message); });
class ForwardingOffsets extends ArrayObject {
    function offsetGet($key): mixed { return parent::offsetGet($key); }
}
class ReportingOffsets extends ArrayObject {
    function offsetSet($key, $value): void { echo "unexpected offsetSet\n"; parent::offsetSet($key, $value); }
}
$forward = new ForwardingOffsets;
$reporting = new ReportingOffsets(['k'=>2]);
$native = new ArrayObject(['k'=>2]);
reportOperation(fn()=>$target['k']=$unread);
reportOperation(fn()=>$reporting['k']=$unread);
reportOperation(fn()=>$queue[0]=$unread);
reportOperation(fn()=>$queue[]=$unread);
reportOperation(fn()=>$failure[$key]=$unread);
reportOperation(fn()=>$fixed[0]=$unread);
reportOperation(fn()=>$native['read']=$unread);
var_dump($reporting['k'],$queue[0],count($queue),$failure[$key],$fixed[0],$native['read']);

$plain = ['k'=>2];
reportOperation(function()use(&$plain){$plain['k'] .= $unread;});
reportOperation(function()use(&$plain){$plain['k'] /= $unread;});
var_dump($plain);
reportOperation(fn()=>$native['k'] .= $unread);
reportOperation(fn()=>$native['k'] /= $unread);
reportOperation(fn()=>$native['k'] *= $unread);
reportOperation(fn()=>$native[] += 1);
reportOperation(fn()=>$native[4.5] += 2);
reportOperation(fn()=>$native[null] += 3);
var_dump($native->getArrayCopy());
reportOperation(fn()=>$forward['k'] += 1);
reportOperation(fn()=>$forward['k'] .= 'foo');
reportOperation(fn()=>$forward['k'] /= 0);
reportOperation(fn()=>$forward['k']++);
var_dump($forward->getArrayCopy());
restore_error_handler();

class ThrowingOffsets extends ArrayObject {
    function offsetGet($key): mixed { throw new RuntimeException('read'); }
}
class ThrowingQueue extends SplQueue {
    function offsetGet($index): mixed { throw new RuntimeException('queue read'); }
}
$throwing = new ThrowingOffsets;
$throwingQueue = new ThrowingQueue;
reportOperation(fn()=>$throwing['a'] += 1);
reportOperation(fn()=>$throwing['a'] /= 0);
reportOperation(fn()=>$throwingQueue[0] += 1);
reportOperation(fn()=>$throwingQueue[0]++);
reportOperation(fn()=>$native[[]] += 1);
reportOperation(fn()=>$fixed[[]] += 1);
reportOperation(fn()=>$queue['a'] += 1);
reportOperation(fn()=>$failure[1] += 1);

$o = new stdClass;
$o->p[0] += 1;
$o->q[0]++;
$o->r[0][1] += 1;
$o->s[0] = 1;
$o->t[0] ??= 1;
reportOperation(fn()=>$o->a->b += 1);

class NestedTypedSlots {
    public int $number;
    public ?array $array;
    public mixed $mixed;
    public ?stdClass $object;
    public static array $shared;
}
$typed = new NestedTypedSlots;
reportOperation(fn()=>$typed->number[0] += 1);
reportOperation(fn()=>$typed->array[0]++);
reportOperation(fn()=>$typed->mixed[0] .= 'a');
reportOperation(fn()=>$typed->object->key += 1);
reportOperation(fn()=>NestedTypedSlots::$shared[0] += 1);
$typed->array[0] ??= 3;
NestedTypedSlots::$shared[0] = 2;
var_dump($typed->array,NestedTypedSlots::$shared);

class FixedDelegation extends SplFixedArray {
    function offsetGet($offset): mixed { return parent::offsetGet($offset); }
}
$fixedChild=new FixedDelegation(1);
reportOperation(fn()=>$fixedChild[4] += 1);
reportOperation(fn()=>$fixedChild[4] /= 0);
reportOperation(fn()=>$fixed[] += 1);
reportOperation(fn()=>$fixed[]++);
reportOperation(fn()=>$fixed[null] = 1);
reportOperation(fn()=>$forward[] += 1);
class DefaultOffset extends ArrayObject {
    function offsetGet($key = 'default'): mixed {
        var_dump($key, func_num_args(), func_get_args());
        return 2;
    }
}
$withDefault = new DefaultOffset;
$withDefault[] += 1;
var_dump($withDefault->getArrayCopy());

set_error_handler(function($level,$message) { echo $message,"\n"; throw new ErrorException($message); });
reportOperation(fn()=>$target[$missingKey] += 1);
reportOperation(fn()=>$target[$missingKey] /= 0);
reportOperation(fn()=>$fixed[$missingKey] += 1);
$native = new ArrayObject([''=>3]);
reportOperation(fn()=>$native[$missingKey] += 1);
reportOperation(fn()=>$native[5.5]++);
reportOperation(fn()=>$native[0.5]++);
reportOperation(fn()=>$native['nested']['key'] += 1);
reportOperation(fn()=>$native[7.5]['key'] = 1);
var_dump($native->getArrayCopy());
$empty = new ArrayObject;
reportOperation(fn()=>$empty[null]++);
var_dump($empty->getArrayCopy());
restore_error_handler();
