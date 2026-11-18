<?php
function throwingWarning($level,$message) { echo "warning:",$message,"\n"; throw new ErrorException($message); }
function handle($run) {
    try { $run(); } catch (Throwable $error) {
        echo get_class($error), ":", $error->getMessage(), " / ", $error->getPrevious()?->getMessage(), "\n";
    }
}
set_error_handler('throwingWarning');
handle(function () { try { $u += 1; } finally { var_dump(get_defined_vars()['u'] ?? 'missing'); } });
handle(function () { try { $u .= 'x'; } finally { var_dump(get_defined_vars()['u'] ?? 'missing'); } });
handle(function () { try { $w++; } finally { var_dump(get_defined_vars()['w'] ?? 'missing'); } });
handle(function () { try { $w--; } finally { var_dump(get_defined_vars()['w'] ?? 'missing'); } });
handle(function () { try { $u /= 0; } finally { var_dump(get_defined_vars()['u'] ?? 'missing'); } });
handle(function () { try { $a=[]; $a['k'] += 1; } finally { var_dump($a); } });
handle(function () { try { $o=new stdClass; $o->p += 1; } finally { var_dump($o); } });
handle(function () { try { $u += $v; } finally { var_dump(get_defined_vars()['u'] ?? 'missing'); } });
handle(function () {$o = new stdClass; $o->{$k} = $v;});
restore_error_handler();
class TestVisibility { private(set) int $value=1; protected(set) int $other=1; }
$o = new TestVisibility;
handle(fn()=>$o->value /= 0);
handle(fn()=>$o->other -= []);
handle(fn()=>$o->value += 2);
class H {
    public int $b=1 { set => $value; }
    public array $c=['k'=>1] { set => $value; }
    public array $byRef=['k'=>1] { &get {return $this->byRef;} }
}
$h=new H;
handle(function()use($h) {unset($h->b->x);});
handle(function()use($h) {unset($h->c['k']);});
handle(function()use($h) {unset($h->byRef['k']);var_dump($h->byRef);});

$a = [];
$a['missing'] += $rightHand;
class StaticArray { public static array $values = []; }
StaticArray::$values['missing'] += $rightHand;
$a = [];
$a['outer']['inner'] += $rightHand;
$a[$key] += $rightHand;
$object = new stdClass;
$object->{$name} = $value;
handle(function() { $n=null; $n->{$key} = $value; });
handle(function() { $n=1; $n->$key = $value; });
handle(function() use($object) { $key=[]; $object->$key = $value; });
handle(function() use($object) { $object->{new stdClass} = $value; });

set_error_handler('throwingWarning');
handle(function() { try { $u -= []; } finally { var_dump(array_key_exists('u', get_defined_vars()), $u); } });
handle(function() { $o=new stdClass; try { $o->p -= []; } finally { var_dump($o); } });
handle(function() { $n='v'; try { $$n += 1; } finally { var_dump(array_key_exists('v', get_defined_vars())); } });
handle(function() { $n='v'; try { $$n /= 0; } finally { var_dump(array_key_exists('v', get_defined_vars())); } });
handle(function() { $n='v'; try { $$n++; } finally { var_dump(array_key_exists('v', get_defined_vars())); } });
class DynamicSlots {}
handle(function() { $o=new DynamicSlots; try { $o->p += 1; } finally { var_dump($o); } });
handle(function() { $o=new DynamicSlots; try { $o->p++; } finally { var_dump($o); } });
handle(function() { $o=new stdClass; try { $o->{$name} += $rhs; } finally { var_dump($o); } });
handle(function() { $o=new stdClass; $rhs=7; try { $o->{$name} += $rhs; } finally { var_dump($o); } });
restore_error_handler();
$object = new stdClass;
$object->{$name} .= $rhs;
var_dump($object);

class SetterSlots {
    public array $items = ['k' => 4] { set { unset($this->items['k']); $this->items = $value; } }
    public object $obj { set => $value; }
    public int $uninitialized { set => $value; }
    public int $virtual { set {} }
}
$s = new SetterSlots;
$s->items=['x'=>5];
$s->obj=(object)['keep'=>1];
handle(function()use($s){ $s->items[] = 1; });
handle(function()use($s){ $ref =& $s->items; });
handle(function()use($s){ foreach ($s->items as &$item) {} });
handle(function()use($s){ $s->uninitialized->x = 1; });
handle(function()use($s){ $ref =& $s->virtual; });
$s->obj->next=2;
unset($s->obj->keep);
$temp =& $s->obj;
$temp='local';
handle(function()use($s){ $other = new stdClass; $s->obj =& $other; });
var_dump($s->items, $s->obj);
