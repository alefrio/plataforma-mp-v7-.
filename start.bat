@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  PlataformaMP — servidor na porta 3780
echo  Deixe esta janela ABERTA. No Chrome acesse: http://127.0.0.1:3780
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado. Instale de https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo Instalando dependencias npm install ...
  call npm install
)
node server\index.js
if errorlevel 1 pause
