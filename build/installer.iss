; Parish Music Player - Inno Setup script
;
; Compile after a successful PyInstaller build:
;     "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" build\installer.iss
; or, from the project root:
;     .\build\build.ps1 -Installer
;
; Produces Output\ParishMusicPlayer-Setup-2.3.0.exe: one file for a parish to
; download, with a Start menu entry and a proper uninstaller.

#define AppName        "Parish Music Player"
#define AppVersion     "2.3.0"
#define AppPublisher   "Parish Music Player"
#define AppURL         "https://github.com/johnsav-uk/Parish-Music-Player"
#define AppExeName     "ParishMusicPlayer.exe"
#define SourceDir      "..\dist\ParishMusicPlayer"

[Setup]
AppId={{7C3F1A64-2B8E-4D91-9A55-4E1C9B0A7D32}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
OutputDir=..\Output
OutputBaseFilename=ParishMusicPlayer-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Per-user install by default so a volunteer without an administrator password
; can still install it. Parishes that manage their PCs centrally can change
; PrivilegesRequired to admin.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExeName}
; The rose window from the player's own page, so Setup, the executable, the
; Start menu entry and the desktop shortcut are all recognisably the same
; thing. Generated from src\logo.png; see build\make_icon.py.
SetupIconFile=app.ico
LicenseFile=..\LICENSE
; Version resource on Setup.exe itself. Without it the file's Properties dialog
; is blank, which makes an unsigned download look worse than it is to both
; SmartScreen and the person deciding whether to trust it. These match
; build\file_version_info.txt, which does the same job for the application.
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
VersionInfoCopyright=MIT Licence. Free for all parishes.
DisableProgramGroupPage=yes
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a shortcut on the desktop"; \
  GroupDescription: "Shortcuts:"; Flags: checkedonce

[Files]
; The whole PyInstaller one-folder output, including the soundfonts.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; DestName: "README.txt"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Start {#AppName}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Settings and the WebView profile live outside the install directory.
Type: filesandordirs; Name: "{localappdata}\ParishMusicPlayer"

[Code]
{
  The embedded window needs the Edge WebView2 runtime. Windows 11 and current
  Windows 10 ship it, but a machine that has never been updated may not have it,
  and the player would then open a blank window with no explanation. Check for
  it and point the user at the free Microsoft download rather than letting them
  discover the problem on a Sunday morning.
}
function WebView2Installed(): Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);
  if Result then
    Result := (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup(): Boolean;
var
  ErrorCode: Integer;
begin
  Result := True;
  if not WebView2Installed() then
  begin
    if MsgBox(
      'Parish Music Player needs the Microsoft Edge WebView2 runtime, which does not appear to be installed on this PC.' + #13#10 + #13#10 +
      'It is a free Microsoft component and takes about a minute to install.' + #13#10 + #13#10 +
      'Open the download page now? Setup will continue either way.',
      mbConfirmation, MB_YESNO) = IDYES then
    begin
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '', SW_SHOW, ewNoWait, ErrorCode);
    end;
  end;
end;
