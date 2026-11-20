<?php
class Item {
    function __construct(public string $name, public bool $fails = false) {}
    function __destruct() {
        echo $this->name, ";";
        if ($this->fails) throw new Exception($this->name);
    }
}
function report(Throwable $error) {
    do {
        echo "caught:", $error->getMessage(), ";";
        $error = $error->getPrevious();
    } while ($error);
}
$a = new Item("closure-a", true);
$b = new Item("closure-b");
$f = function () use ($a, $b) {};
unset($a);
try { unset($f); } catch (Throwable $error) { report($error); }
unset($b);
echo "closure-end\n";

$f = (function () {
    $a = new Item("both-a", true);
    $b = new Item("both-b", true);
    return function () use ($a, $b) {};
})();
try { unset($f); } catch (Throwable $error) { report($error); }
echo "both-end\n";

$b = new Item("array-b");
$a = [new Item("array-a", true), $b];
try { unset($a); } catch (Throwable $error) { report($error); }
unset($b);
echo "array-end\n";

$b = new Item("native-b");
$list = new SplDoublyLinkedList();
$list->push(new Item("native-a", true));
$list->push($b);
try { unset($list); } catch (Throwable $error) { report($error); }
unset($b);
echo "native-end\n";

class ParentItem extends Item {
    function __construct(public Item $child) { parent::__construct("parent", true); }
}
$parent = new ParentItem(new Item("child", true));
try { unset($parent); } catch (Throwable $error) { report($error); }
echo "parent-end\n";
