@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动余讯 6.1 ...
py -3 -c "import sys; sys.exit(not sys.version_info.__ge__((3, 8)))" >nul 2>&1
if not errorlevel 1 (
  py -3 "%~dp0scripts\serve.py"
  goto :finished
)
python -c "import sys; sys.exit(not sys.version_info.__ge__((3, 8)))" >nul 2>&1
if not errorlevel 1 (
  python "%~dp0scripts\serve.py"
  goto :finished
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>&1
if not errorlevel 1 (
  node "%~dp0scripts\serve.mjs"
  goto :finished
)
echo 未找到 Python 3.8+ 或 Node.js 18+。
echo 请安装其中一个运行环境，然后重新双击本文件。
echo 不需要 npm install，也不需要任何账号或密钥。
:finished
pause
