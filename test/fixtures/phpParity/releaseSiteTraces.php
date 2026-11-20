<?php
class Item {
    function __destruct() { throw new Exception("release"); }
}
function report(Throwable $error) { echo $error, "\n"; }
$a = new Item();
try { unset($a); } catch (Throwable $error) { report($error); }
function remove() {
    $a = new Item();
    unset($a);
}
try { remove(); } catch (Throwable $error) { report($error); }
function leave() {
    $a = new Item();
    return 1;
}
try { leave(); } catch (Throwable $error) { report($error); }
class Holder {
    function remove() {
        $a = new Item();
        unset($a);
    }
}
try { (new Holder())->remove(); } catch (Throwable $error) { report($error); }
class CycleItem extends Item { public $self; }
$a = new CycleItem();
$a->self = $a;
unset($a);
try { gc_collect_cycles(); } catch (Throwable $error) { report($error); }
