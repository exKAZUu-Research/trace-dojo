<?php
class I implements Iterator{function __construct(public $nonempty){}function rewind():void{echo 'rewind;';}function valid():bool{echo 'valid;';return $this->nonempty;}function current():mixed{echo 'current;';return 1;}function key():mixed{return 0;}function next():void{echo 'next;';$this->nonempty=false;}}
foreach([false,true] as $nonempty){try{foreach(new I($nonempty) as &$v){echo 'body;';}}catch(Throwable $e){echo $e->getMessage(),"\n";}}echo 'after';
