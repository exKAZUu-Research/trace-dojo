<?php
foreach(['self','static','parent'] as $scope){
 foreach([$scope.'::m',[$scope,'m']] as $fn){
  try{$fn();}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}
  try{call_user_func($fn);}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}
  try{array_map($fn,[1]);}catch(Throwable $e){echo get_class($e),': ',$e->getMessage(),"\n";}
 }
}
class CallableParent {static function m($x=0){echo 'parent:',$x,';';return $x;}}
class CallableChild extends CallableParent {
 static function m($x=0){echo 'child:',$x,';';return $x;}
 static function compare($a,$b){return $a<=>$b;}
 static function exercise(){
  foreach(['self','static','parent'] as $scope){
   $fn=$scope.'::m';try{$fn();}catch(Throwable $e){echo $e->getMessage(),"\n";}
   $fn=[$scope,'m'];try{$fn();}catch(Throwable $e){echo $e->getMessage(),"\n";}
   var_dump(is_callable($scope.'::m'),is_callable($scope.'::missing'));
   call_user_func($scope.'::m',1);echo "\n";
   var_dump(array_map([$scope,'m'],[2,3]));
  }
  $fn=Closure::fromCallable('self::m');$fn(4);echo "\n";
  $a=[2,1];usort($a,'self::compare');var_dump($a);
  try{var_dump(1 |> 'self::m');}catch(Throwable $e){echo $e->getMessage(),"\n";}
 }
}
CallableChild::exercise();
