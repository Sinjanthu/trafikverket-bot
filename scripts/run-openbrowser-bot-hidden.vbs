' Runs the /openbrowser Discord listener with a fully hidden console window.
' Unlike the other two scheduled tasks, this one is meant to stay running
' indefinitely (it's an always-on Gateway connection, not a one-shot poll),
' so it's launched with bWaitOnReturn=False - wscript starts it and exits
' immediately, leaving the listener running detached in the background.
Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd /c cd /d ""D:\VSCode\trafikverket-bot"" && ""C:\Program Files\nodejs\node.exe"" ""D:\VSCode\trafikverket-bot\scripts\discord-open-browser-bot.js"" >> ""D:\VSCode\trafikverket-bot\openbrowser-bot.log"" 2>&1", 0, False
