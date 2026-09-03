' Runs the poller with a fully hidden window (no console flash), used by
' Task Scheduler instead of invoking node.exe directly. Waits for it to
' finish and propagates the real exit code so `schtasks /Query .../V` still
' shows a meaningful Last Result.
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("""C:\Program Files\nodejs\node.exe"" ""D:\VSCode\trafikverket-bot\src\index.js""", 0, True)
WScript.Quit(exitCode)
