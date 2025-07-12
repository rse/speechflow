@echo off
title Speechflow
"c:\Program Files\nodejs\node.exe" ^
    .\dst\speechflow.js ^
    -v info ^
    -c studio@.\etc\speechflow.yaml
