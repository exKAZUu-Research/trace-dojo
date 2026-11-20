<?php
class FailString {function __toString():string {throw new Exception('conversion');}}
foreach (['str_replace','str_ireplace'] as $function) {
    $count=42;
    try {$function(['a',new FailString],['x','y'],'aaa',$count);}catch(Throwable $e){echo $e->getMessage(),';';}
    var_dump($count);
    $count=42;
    try {$function('a',[],'aaa',$count);}catch(Throwable $e){echo get_class($e),';';}
    var_dump($count);
}
