<?php
class VirtualValue {public int $v {get {echo 'get;';return 1;}}}
class BackedValue {public int $v=1 {get {echo 'get;';return $this->v;}}}
class BackedRef {public int $v=1 {&get {echo 'get-ref;';return $this->v;}}}
foreach ([new VirtualValue,new BackedValue,new BackedRef] as $object){
    try{foreach($object as &$value){$value=3;echo $value,';';}}catch(Throwable $e){echo $e->getMessage(),';';}
    try{$ref=&$object->v; echo $ref,';';}catch(Throwable $e){echo $e->getMessage(),';';}
}
