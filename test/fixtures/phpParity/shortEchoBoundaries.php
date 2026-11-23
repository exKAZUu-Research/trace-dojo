start<?= 1, ',', 2 ?>
<?php if (false) ?>outside<?= 3, ':' ?>
<?php if (false): ?>bad<?= 'no' ?>
<?php elseif (false): ?>also bad
<?php else: ?>branch<?= '42' ?>
<?php endif; ?>
<?php if (false) ?><?php else echo 'else'; ?>
<?php for ($i=0; $i<2; $i++): ?>a<?= $i ?><?php endfor; ?>
<?php switch (1) { ?><?php case 1: ?>switch<?= '!' ?><?php break; } ?>
<?php function render() { ?>render<?= 'ok' ?><?php } render(); ?>end
<?php if (1) ?>x<?php ; echo 'y'; if (0) echo 1; else ?>z<?php ;
