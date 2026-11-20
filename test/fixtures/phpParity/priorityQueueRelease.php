<?php
class D {function __construct(public $n){}function __destruct(){echo "-$this->n;";}}
foreach ([SplPriorityQueue::EXTR_DATA,SplPriorityQueue::EXTR_PRIORITY,SplPriorityQueue::EXTR_BOTH] as $flags) {
    $queue=new SplPriorityQueue;
    $queue->setExtractFlags($flags);
    $queue->insert(new D('data'),new D('priority'));
    echo 'before;';$value=$queue->extract();echo 'after;';unset($value,$queue);echo "end;\n";
}
$queue=new SplPriorityQueue;
$queue->insert(new D('data'),new D('priority'));
echo 'before;';$queue->next();echo 'after;';unset($queue);echo "end;\n";
