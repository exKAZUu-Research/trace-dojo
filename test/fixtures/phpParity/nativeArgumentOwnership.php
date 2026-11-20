<?php
class Kept{
  public $id=1;
  function __construct(){global $keep;$keep=$this;}
  function __toString(){global $keep;$keep=null;echo 'string',"\n";return 'one';}
  function __destruct(){echo 'free ',$this->id,"\n";}
}
function consume($a,$b){echo 'use ',$a->id,':',$b,"\n";}
consume(new Kept,strlen($keep));unset($keep);
class Temp{function __destruct(){echo 'temporary freed',"\n";}}
try{intdiv(new Temp,1);}catch(Throwable $e){echo get_class($e),"\n";}
