<?php for($i=0;$i<2;$i++): ?>row<?= $i ?> <?php endfor; ?>X
<?php foreach([1,2] as $v): ?>v<?= $v ?> <?php endforeach; echo 'E';
foreach([true,false] as $a): if($a): ?>T<?php elseif(!$a): ?>F<?php else: ?>N<?php endif; endforeach;
$i=0;while($i++<2): ?>w<?= $i ?> <?php endwhile;
foreach([1,2,3] as $x):switch($x):case 1: ?>A<?php break;case 2: ?>B<?php break;default: ?>C<?php endswitch;endforeach;
foreach([1,2] as $v): ?> <?php endforeach;echo 'done';
