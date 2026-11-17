<?php
class ScopeBase{public self $x;function f(int ...$xs){return $xs;}}
class ScopeChild extends ScopeBase{public ScopeBase $x;function f(int $x=0,int ...$xs){return [$x,...$xs];}}
$x=new ScopeChild;$x->x=new ScopeBase;echo get_class($x->x),"\n";var_dump($x->f(1,2,3));
class RootType{}class ParentType extends RootType{public parent $x;}class ChildType extends ParentType{public RootType $x;}
$x=new ChildType;$x->x=new RootType;echo get_class($x->x),"\n";
