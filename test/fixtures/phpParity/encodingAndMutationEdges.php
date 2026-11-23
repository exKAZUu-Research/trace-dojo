<?php
var_dump(htmlentities(hex2bin('e940'),ENT_QUOTES|ENT_HTML5,'ISO-8859-1'));
var_dump(bin2hex(htmlspecialchars(hex2bin('e926'),ENT_QUOTES,'ISO-8859-1')));
var_dump(bin2hex(html_entity_decode('&eacute;&euro;&#233;&#x100;',ENT_QUOTES|ENT_HTML5,'ISO-8859-1')));
function f(int|bool $x){var_dump($x);}foreach([INF,NAN,'1e999','9e200'] as $v){f($v);}
class A{}class B extends A {function f(){var_dump(get_class(),get_parent_class());}}
(new B)->f();
class Parentless {function f(){foreach(['parent::f',['parent','f']] as $fn){try{$fn();}catch(Throwable $e){echo $e->getMessage(),"\n";}}}}
(new Parentless)->f();
class T {public string $s='1';public ?int $i=null;}$t=new T;var_dump($t->s+=1,++$t->s,$t->i??='7');
$s='abc';var_dump($s[0]=123,$s,$s[-20]='q');
$a=[2,1];$b=$a;array_multisort($a);var_dump($a,$b);
$a=[2,1];$b=[4,3];$c=$b;array_multisort($a,$b);var_dump($b,$c);
var_dump(mb_strripos(hex2bin('410042004300'),hex2bin('4200'),0,'UTF-16LE'));
mb_internal_encoding('ISO-8859-1');var_dump(bin2hex(mb_convert_encoding(hex2bin('e9'),'UTF-8')),bin2hex(mb_convert_encoding(hex2bin('e9'),'UTF-8',null)));
