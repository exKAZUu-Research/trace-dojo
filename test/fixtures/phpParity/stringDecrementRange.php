<?php
foreach(['00','000','0a','0b','01','0Z','a0','A0','10','b0','100','az'] as $value){
    try {echo $value,':',str_decrement($value),"\n";}catch(Throwable $error){echo $error->getMessage(),"\n";}
}
