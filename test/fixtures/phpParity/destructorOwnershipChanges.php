<?php
$saved = null;
$holder = new stdClass;
$native = new SplStack;
class Revive {
    public $next;
    function __construct(public $name, public $mode) {}
    function __destruct() {
        global $saved, $holder, $native;
        echo 'destroy:',$this->name,"\n";
        if ($this->mode === 1) $saved=$this;
        if ($this->mode === 2) $holder->value=[$this];
        if ($this->mode === 3) $native->push($this);
        if ($this->mode === 4) $saved=static function() {return 'closure';};
        if ($this->mode === 5) {$x=$this;$x=null;}
    }
}
foreach ([1,2,3,4,5] as $mode) {
    $head=new Revive("head$mode",$mode);
    $head->next=new Revive("tail$mode",0);
    $head=null;
    echo "after:$mode\n";
    $saved=null;
    unset($holder->value);
    if (!$native->isEmpty()) $native->pop();
    echo "cleared:$mode\n";
}
