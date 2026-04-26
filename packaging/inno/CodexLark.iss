#ifndef StageDir
  #error StageDir define is required. Pass /DStageDir=<path> from scripts\package\build-installer.ps1.
#endif

#ifndef OutputDir
  #error OutputDir define is required. Pass /DOutputDir=<path> from scripts\package\build-installer.ps1.
#endif

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName "CodexLark"
#define AppPublisher "CodexLark"
#define AppExeName "node.exe"

[Setup]
AppId={{3C1161E8-7A91-4D9A-A0E8-1F8868B2F25F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\CodexLark
DefaultGroupName=CodexLark
DisableProgramGroupPage=yes
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=CodexLark-Setup-{#AppVersion}
UninstallDisplayIcon={app}\{#AppExeName}

[Files]
Source: "{#StageDir}\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\dist\*"; DestDir: "{app}\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\scripts\setup\*"; DestDir: "{app}\scripts\setup"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\docs\workflows\*"; DestDir: "{app}\docs\workflows"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\run-admin-task.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Install-CodexLark-Autostart.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Uninstall-CodexLark-Autostart.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Start-CodexLark.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\Repair-CodexLark.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\README.en.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#StageDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\Launch CodexLark"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Start-CodexLark.ps1"""; WorkingDir: "{app}"
Name: "{group}\Repair CodexLark"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Repair-CodexLark.ps1"""; WorkingDir: "{app}"
Name: "{group}\Uninstall CodexLark"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\node.exe"; Parameters: "-e ""const launcher = require('./dist/setup/launcher.js'); launcher.ensureSourceRuntimeManifest(process.cwd(), process.env);"""; WorkingDir: "{app}"; StatusMsg: "Syncing CodexLark launcher manifest..."; Flags: runhidden runasoriginaluser waituntilterminated
