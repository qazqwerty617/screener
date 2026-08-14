@echo off
cd /d "%~dp0node-server"
echo.
echo  CryptoScreen Pro — запуск сервера
echo  http://localhost:3000
echo.

REM Проверяем что .env файл существует
if not exist ".env" (
    echo  ❌ ОШИБКА: Файл node-server\.env не найден!
    echo  Создай node-server\.env и заполни токены ботов.
    echo  Смотри node-server\.env.example для примера.
    pause
    exit /b 1
)

node server.js
pause
