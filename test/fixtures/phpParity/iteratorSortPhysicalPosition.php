<?php
foreach(['ArrayObject','ArrayIterator'] as $class){$a=['a','b','c'];$s=new $class($a);$i=$class==='ArrayObject'?$s->getIterator():$s;$i->next();unset($s[0]);$c=$s->getArrayCopy();$s->asort();var_dump($i->key(),$i->current(),$c);}
$a=['z','a','b'];unset($a[0]);$s=new ArrayIterator($a);$s->rewind();$c=$s->getArrayCopy();$s->asort();var_dump($s->key(),$s->current(),$c);
$a=['z','a','b'];unset($a[0]);$a[]=3;$s=new ArrayIterator($a);$s->next();$c=$s->getArrayCopy();$s->ksort();var_dump($s->key(),$s->current(),$c);
$s=new ArrayIterator(['a','b','c']);unset($s[2]);$s[]='d';$s->seek(2);$c=$s->getArrayCopy();$s->asort();var_dump($s->key(),$s->current(),$c);
$s=new ArrayIterator(['a']);unset($s[0]);$s[]='b';$s->rewind();$c=$s->getArrayCopy();$s->asort();var_dump($s->key(),$s->current(),$c);
$a=['a','b','c'];array_pop($a);$a[]='d';$s=new ArrayIterator($a);$s->seek(2);$c=$s->getArrayCopy();$s->asort();var_dump($s->key(),$s->current(),$c);
$s=new ArrayIterator(['a'=>1,'b'=>2,'c'=>3]);unset($s['c']);$s['d']=4;$s->seek(2);$c=$s->getArrayCopy();$s->asort();var_dump($s->key(),$s->current(),$c);
$s=new ArrayIterator(['a'=>1,'b'=>2,'c'=>3]);unset($s['a']);$s->rewind();$c=$s->getArrayCopy();$s->asort();var_dump($s->key(),$s->current(),$c);
$a=['a'=>1,'b'=>2,'c'=>3];unset($a['a']);$s=new ArrayIterator($a);$s->rewind();$s->asort();var_dump($s->key(),$s->current());
$s=new ArrayIterator(['a'=>1,'b'=>2,'c'=>3]);unset($s['a']);$c=$s->getArrayCopy();$c['d']=4;$s->rewind();$s->asort();var_dump($s->key(),$s->current());
