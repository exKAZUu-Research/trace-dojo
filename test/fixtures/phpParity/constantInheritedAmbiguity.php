<?php interface I{const X=1;}class P{const X=1;}class C extends P implements I{}echo 'never';
