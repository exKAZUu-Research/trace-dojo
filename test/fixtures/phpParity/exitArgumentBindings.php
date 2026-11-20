<?php
foreach ([0,1,2] as $kind) {
    try {
        if ($kind === 0) exit(unknown:"oops");
        elseif ($kind === 1) die(...["status"=>[]]);
        else exit("first", print("extra;"));
    } catch (Throwable $error) {echo $error->getMessage(), "\n";}
}
exit(...["status"=>"done;"]);
echo "never;";
