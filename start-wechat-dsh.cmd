@echo off
chcp 65001 >nul
setlocal
set BRIDGE_DIR=C:\Users\Administrator\Documents\Codex\wechat-dsh-bridge
set NODE_BIN=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
set DSH_WEB_URL=http://127.0.0.1:55787
set DSH_HOME=C:\Users\Administrator\.dsh
set WECHAT_ACP_STORAGE_DIR=C:\Users\Administrator\.wechat-acp\instances\codex-main
set WECHAT_DSH_STORAGE_DIR=C:\Users\Administrator\.wechat-dsh-bridge
set PYTHONIOENCODING=utf-8
"%NODE_BIN%" "%BRIDGE_DIR%\src\index.js" >> "%WECHAT_DSH_STORAGE_DIR%\stdout.log" 2>&1
