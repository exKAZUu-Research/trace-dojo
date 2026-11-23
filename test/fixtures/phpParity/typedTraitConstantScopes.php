<?php
trait W{const ?B X=null;}class B{use W;const ?self X=null;}var_dump(B::X);
trait T{const ?self X=null;}trait U{const ?self X=null;}class A{use T,U;}echo 'never';
