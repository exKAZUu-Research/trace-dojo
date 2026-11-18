<?php
foreach ([0,1,2] as $kind) {
    try {
        if ($kind === 0) die(unknown:"oops");
        elseif ($kind === 1) die(...["status"=>[]]);
        else die("first", print("extra;"));
    } catch (Throwable $error) {echo $error->getMessage(), "\n";}
}
die(...["status"=>"done;"]);
echo "never;";
