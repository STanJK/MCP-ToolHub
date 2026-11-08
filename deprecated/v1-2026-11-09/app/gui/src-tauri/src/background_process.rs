use std::process::Command;

/// Configure a child process for true background execution on Windows.
///
/// CREATE_NO_WINDOW is applied before CreateProcess, so console applications
/// such as node.exe, powershell.exe, taskkill.exe and netstat.exe are created
/// without a console window. This is not a post-spawn hide operation.
#[cfg(windows)]
pub fn configure_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn configure_no_window(_command: &mut Command) {}
