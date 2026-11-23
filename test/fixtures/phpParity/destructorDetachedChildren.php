<?php
class Item {
    function __construct(public $name) {}
    function __destruct() {echo 'item ',$this->name,"\n";}
}
class Bag {
    public $items=[];
    function __destruct() {
        echo "bag start\n";
        $this->items=[];
        echo "bag end\n";
    }
}
$b=new Bag;$b->items[]=new Item(1);$b->items[]=new Item(2);
$b=null;echo "after\n";
class Link {
    public $next;
    function __construct(public $name) {}
    function __destruct() {
        echo 'start ',$this->name,"\n";
        unset($this->next);
        echo 'end ',$this->name,"\n";
    }
}
$x=new Link('a');$x->next=new Link('b');$x->next->next=new Link('c');
$x=null;echo "after chain\n";
class MixedBag {
    public $items;
    function __destruct() {
        $temporary=[new Item('fresh before'), $this->items, new Item('fresh after')];
        $this->items=null;
        unset($temporary);
        echo "mixed end\n";
    }
}
$x=new MixedBag;$x->items=new Item('owned');$x=null;
