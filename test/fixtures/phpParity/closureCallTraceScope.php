<?php
class Receiver {}
$closure=function(){return (new Exception)->getTraceAsString();};
echo $closure->call(new Receiver), "\n";
echo $closure->bindTo(new Receiver,Receiver::class)(), "\n";
