<?php
class D {
    function __construct(public $n) {}
    function __destruct(){echo "-$this->n;";}
    function __toString():string {echo "string$this->n;";return 'S';}
}
function made($n){return new D($n);}
function nextValue($n){echo "next$n;";return $n;}
echo print made(1),'|';
$x=(print made(2))+nextValue(3);
nextValue(print made(4));
$values=[print made(5),nextValue(6)];
switch(true){case made(7):echo 'body;';break;}
switch(false){case made(8):echo 'never;';break;default:echo 'default;';}
