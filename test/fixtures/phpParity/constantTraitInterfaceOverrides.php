<?php interface I{const X=1;}interface J{const X=2;}trait T{const X=3;}class C implements I,J{use T;}var_dump(C::X);class D implements I,J{const X=4;}var_dump(D::X);
