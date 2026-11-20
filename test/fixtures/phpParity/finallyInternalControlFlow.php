<?php
try{}finally{goto L;echo 'never';L:echo 'label',"\n";while(true){break;}for($i=0;$i<2;$i++){continue;}}
function f(){try{return 1;}finally{return 2;}}var_dump(f());
namespace_unused:;
