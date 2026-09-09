' Runs the poller with a fully hidden window (no console flash), used by
' Task Scheduler instead of invoking node.exe directly. Waits for it to
' finish and propagates the real exit code so `schtasks /Query .../V` still
' shows a meaningful Last Result. Output is captured to poll-bot.log
' (overwritten each run - just enough to diagnose the most recent failure,
' not an unbounded log) since a failure previously had zero detail beyond
' the exit code.
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("cmd /c cd /d ""D:\VSCode\trafikverket-bot"" && ""C:\Program Files\nodejs\node.exe"" ""D:\VSCode\trafikverket-bot\src\index.js"" > ""D:\VSCode\trafikverket-bot\poll-bot.log"" 2>&1", 0, True)
WScript.Quit(exitCode)
