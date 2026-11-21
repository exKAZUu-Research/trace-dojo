<?php
trait T{const X=self::Y;const N=__CLASS__;const P=parent::Y;}
trait U{use T;}
class P{const Y=3;}
class A extends P{use U;const Y=4;}
class B extends P{use U;const Y=5;}
var_dump(A::X,A::P,A::N,B::X,B::P,B::N);
trait V{const int X=1;}trait W{const int X=1;}class C{use V,W;const int X=1;}var_dump(C::X);
interface I{const int X=1;}interface J extends I{}interface K extends I{}class D implements J,K{}var_dump(D::X);
interface L{const int X=2;}class E implements I,L{const int X=3;}var_dump(E::X);
class F{const iterable X=[];}class G extends F{const array X=[1];}var_dump(G::X);
class H{private const int X=1;}class Q extends H{const string X='q';}var_dump(Q::X);
class R{public protected(set) int $x=1;}class S extends R{public int $x=2;}$s=new S;$s->x=3;var_dump($s->x);
trait Later{const X=self::Y;const Y=7;}class Forward{use Later;const X=7;}var_dump(Forward::X,Forward::Y);
