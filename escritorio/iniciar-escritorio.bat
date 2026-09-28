@echo off
rem Abre o Escritorio: um servidor local que mostra seus projetos, CMDs e agentes.
chcp 65001 >nul
title Escritorio - deixe esta janela aberta
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js nao esta instalado neste PC.
  echo  Baixe a versao LTS em https://nodejs.org, instale e de dois cliques aqui de novo.
  echo.
  pause
  exit /b 1
)
node servidor.js --abrir
if errorlevel 1 pause
