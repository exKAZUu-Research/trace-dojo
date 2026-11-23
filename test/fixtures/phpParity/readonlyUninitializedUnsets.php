<?php class A{public readonly int $p;public readonly ?int $q;function unsetInitial(){unset($this->p);var_dump(isset($this->p));$this->p=5;var_dump($this->p);try{unset($this->p);}catch(Throwable $e){echo $e->getMessage(),';';}}}class B extends A{function unsetChild(){unset($this->p,$this->q);$this->p=6;$this->q=null;var_dump($this->p,$this->q);}}(new A)->unsetInitial();(new B)->unsetChild();$a=new A;try{unset($a->p);}catch(Throwable $e){echo $e->getMessage();}
class PublicSetter{public public(set) readonly int $p;}$a=new PublicSetter;unset($a->p);$a->p=7;var_dump($a->p);
class PrivateSetter{public private(set) readonly int $p;function own(){unset($this->p);$this->p=8;var_dump($this->p);}}class PrivateChild extends PrivateSetter{function denied(){try{unset($this->p);}catch(Throwable $e){echo $e->getMessage(),';';}try{$this->p=2;}catch(Throwable $e){echo $e->getMessage(),';';}}}(new PrivateSetter)->own();(new PrivateChild)->denied();
class ParentSetter{public readonly int $p;function assign(){unset($this->p);$this->p=9;var_dump($this->p);}}class ChildSetter extends ParentSetter{public readonly int $p;}(new ChildSetter)->assign();
class Mode0{public  readonly int $p;function __construct($init){if($init)$this->p=1;}}
$a=new Mode0(false);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode0(false);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode0(true);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode0(true);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
class Mode1{public protected(set) readonly int $p;function __construct($init){if($init)$this->p=1;}}
$a=new Mode1(false);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode1(false);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode1(true);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode1(true);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
class Mode2{public private(set) readonly int $p;function __construct($init){if($init)$this->p=1;}}
$a=new Mode2(false);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode2(false);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode2(true);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode2(true);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
class Mode3{public public(set) readonly int $p;function __construct($init){if($init)$this->p=1;}}
$a=new Mode3(false);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode3(false);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode3(true);try{unset($a->p);echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
$a=new Mode3(true);try{$a->p=2;echo "ok;";}catch(Throwable $e){echo $e->getMessage(),";";}
