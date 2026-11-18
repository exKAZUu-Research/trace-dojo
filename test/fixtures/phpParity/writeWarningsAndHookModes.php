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
