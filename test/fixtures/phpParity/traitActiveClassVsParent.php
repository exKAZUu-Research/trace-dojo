<?php class P{}trait T{const ?A X=null;}class A extends P{use T;const ?parent X=null;}echo "never";
