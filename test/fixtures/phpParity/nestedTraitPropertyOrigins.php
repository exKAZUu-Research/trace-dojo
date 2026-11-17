<?php
trait T{public self $x;public $y=__CLASS__;}
trait U{use T;}trait V{public self $x;}
class A{use U,V;}class B{use U;}$a=new A;$a->x=$a;echo $a->y,"\n";$b=new B;echo $b->y,"\n";
trait W{public A $p;}class C{use W;public A $p;}echo 'ok';
trait CaseTrait{public caseclass $p;}class CaseClass{use CaseTrait;public self $p;}echo ':case';
