<?php
class D { public $p; function __construct(public $n) {} function __destruct() { echo "dtor {$this->n}\n"; } }
function id() { return spl_object_id(new stdClass); }
$r = array_map(function ($i) { $t = new D("cb$i"); return $i * 2; }, [1, 2]); echo id(), "\n";
$arr = [3, 1, 2]; usort($arr, function ($a, $b) { $t = new D("cmp"); return $a <=> $b; }); echo id(), "\n";
echo preg_replace_callback('/\d/', function ($m) { $t = new D("re{$m[0]}"); return "#"; }, "a1b2"), "\n"; echo id(), "\n";
$w = [new D("w1"), new D("w2")]; array_walk($w, function (&$v, $k) { $v = new D("nw$k"); }); echo id(), "\n"; $w = null; echo id(), "\n";
class M { function __get($n) { return new D("get$n"); } function __set($n, $v) { echo "set\n"; } }
$m = new M; echo $m->foo->n, "\n"; echo id(), "\n"; $m->bar = new D("setv"); echo id(), "\n";
class AA implements ArrayAccess { function offsetExists($o): bool { return true; } function offsetGet($o): mixed { return new D("off$o"); } function offsetSet($o, $v): void {} function offsetUnset($o): void {} }
$aa = new AA; echo $aa[1]->n, "\n"; echo id(), "\n";
class J implements JsonSerializable { function jsonSerialize(): mixed { return [new D("js")]; } } echo json_encode(new J), "\n"; echo id(), "\n";
$it = new ArrayIterator([new D("i1"), new D("i2")]); foreach ($it as $k => $obj) { echo $obj->n, "\n"; } $it = null; $obj = null; echo id(), "\n";
echo call_user_func(fn($x) => $x->n, new D("cuf")), "\n"; echo id(), "\n";
$sorted = [new D("s2"), new D("s1")]; usort($sorted, fn($a, $b) => strcmp($a->n, $b->n)); $sorted = null; echo id(), "\n";

$releaseCount = 0;
class JsonResult { function __destruct() { $GLOBALS['releaseCount']++; } }
class JsonView implements JsonSerializable {
    function __construct(private bool $temporary) {}
    function jsonSerialize(): mixed {
        return $this->temporary ? [new JsonResult, chr(255)] : $GLOBALS['releaseCount'];
    }
}
echo json_encode([new JsonView(true), new JsonView(false)], JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";

echo "end\n";
