<?php
foreach([false,true] as $backed){$o=new ArrayObject(['a','b','c']);$i=$backed?$o->getIterator():new ArrayIterator(['a','b','c']);$source=$backed?$o:$i;$i->next();unset($source[0]);var_dump($i->key(),$i->current());unset($source[1]);var_dump($i->key(),$i->current());$source[1]='new';$i->next();var_dump($i->key(),$i->current());$i->next();$source[]='tail';var_dump($i->key(),$i->current());$i->rewind();var_dump(iterator_to_array($i));}
$i=new ArrayIterator([30,10,20]);$i->next();$i->asort();var_dump($i->key(),$i->current());
$i=new ArrayIterator([30,10,20]);$i->next();unset($i[0]);$i->asort();var_dump($i->key(),$i->current());
$i=new ArrayIterator([1,2,3]);$i->next();unset($i[1]);$i[1]=4;var_dump($i->key(),$i->current());
