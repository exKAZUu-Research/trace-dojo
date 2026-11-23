<?php interface I{const X=1;}interface J{final const X=2;}class A implements I,J{}echo 'never';
