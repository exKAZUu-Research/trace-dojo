<?php interface A{const X=1;}interface B extends A{const X=2;}class C implements B,A{}echo 'never';
