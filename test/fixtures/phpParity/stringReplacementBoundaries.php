<?php
foreach (['abc',''] as $text) {var_dump(strtr($text,[''=>'x','a'=>'b']));}
foreach (['str_replace','str_ireplace'] as $fn) {
 foreach ([[],['a'],''] as $subject) {try {var_dump($fn('a',['x'],$subject));}catch(Throwable $e){echo get_class($e),':',$e->getMessage(),"\n";}}
 var_dump($fn(['a'],['x'],[]));
}
foreach (["abc\n","abc--","abc --","ab--cd--"] as $text) foreach ([true,false] as $cut) var_dump(wordwrap($text,3,str_contains($text,'--')?'--':"\n",$cut));
