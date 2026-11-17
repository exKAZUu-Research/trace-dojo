<?php
foreach (['<b>hi</b><i>end</i>','<my-tag>ok</my-tag><my_tag>x</my_tag><x:y>z</x:y>', '<a href="x>y" title=\'x<y\'>link</a>', '<b title="a>b<c">x</b>', '<b/>a<!--x-->b<?php echo "<b>";?>c', '< b>x</ b>', '<b>open', '<!DOCTYPE html><b>yes</b>'] as $text) {
 foreach (['<b><i><my-tag><my_tag><x:y><a>',['<b>','<i>','<my-tag>','<my_tag>','<x:y>','<a>'],['b','i','my-tag','my_tag','x:y','a'],[]] as $allowed) var_dump(strip_tags($text,$allowed));
}
