' Runs the cookie-refresh script with a fully hidden console window (no
' cmd/node flash). The Chromium browser it launches is a separate window,
' already kept off-screen by refresh-cookie.js itself - this only hides the
' node.exe console around it. Waits for completion and propagates the real
' exit code so `schtasks /Query .../V` still shows a meaningful Last Result.
Set objShell = CreateObject("WScript.Shell")
exitCode = objShell.Run("""C:\Program Files\nodejs\node.exe"" ""D:\VSCode\trafikverket-bot\scripts\refresh-cookie.js"" --push", 0, True)
WScript.Quit(exitCode)
