Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = appDir
electronCli = appDir & "\node_modules\electron\cli.js"
WshShell.Run "node """ & electronCli & """ """ & appDir & """", 0, False
