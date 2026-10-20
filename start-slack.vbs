' starts slack with stop dont do, without a console window
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & here & "\launch.mjs""", 0, False
