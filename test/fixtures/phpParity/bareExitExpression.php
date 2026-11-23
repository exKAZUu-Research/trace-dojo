<?php
function sideEffect(){echo 'rhs;';return 2;}
echo 'before;';
$value=1+(exit)+sideEffect();
echo 'never;';
