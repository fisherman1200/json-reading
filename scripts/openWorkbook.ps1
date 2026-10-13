# 由扩展传入本地路径和页签名；不把这些数据拼接为 PowerShell 代码。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$workbookPath = $env:JSON_READING_WORKBOOK
$sheetName = $env:JSON_READING_SHEET
$excel = $null
$books = $null
$book = $null
$sheets = $null
$sheet = $null
$oldEvents = $null

# Excel 的 Activate 只切换工作簿/页签；还需请求 Windows 将窗口带到前台。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace JsonReading {
    public static class ExcelWindow {
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    }
}
'@

try {
    try {
        $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
    } catch {
        try {
            $excel = New-Object -ComObject Excel.Application
        } catch {
            throw '自动切换页签需要安装 Windows 桌面版 Microsoft Excel。'
        }
    }
    $excel.Visible = $true
    $books = $excel.Workbooks
    # 复用当前 Excel 实例中的工作簿，不关闭或保存用户已打开的文件。
    for ($index = 1; $index -le $books.Count; $index++) {
        $candidate = $books.Item($index)
        if ([string]::Equals($candidate.FullName, $workbookPath, [StringComparison]::OrdinalIgnoreCase)) {
            $book = $candidate
            break
        }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($candidate)
    }

    # 打开和激活页签仅用于导航，不触发工作簿的事件处理程序。
    $oldEvents = $excel.EnableEvents
    $excel.EnableEvents = $false
    if ($null -eq $book) {
        $oldSecurity = $excel.AutomationSecurity
        try {
            $excel.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
            $book = $books.Open($workbookPath, 0) # 不更新外部链接
        } finally {
            $excel.AutomationSecurity = $oldSecurity
        }
    }
    $sheets = $book.Worksheets
    try {
        $sheet = $sheets.Item($sheetName)
    } catch {
        throw "工作簿中找不到页签：$sheetName"
    }
    if ($sheet.Visible -ne -1) {
        throw "页签被隐藏，无法直接切换：$sheetName"
    }
    $book.Activate()
    $sheet.Activate()
    if ($excel.WindowState -eq -4140) { $excel.WindowState = -4143 }
    $windowHandle = [IntPtr]$excel.Hwnd
    if (-not [JsonReading.ExcelWindow]::SetForegroundWindow($windowHandle)) {
        # 按进程 ID 唤起，不依赖随文件名/语言变化的 Excel 窗口标题。
        [uint32]$excelProcessId = 0
        [void][JsonReading.ExcelWindow]::GetWindowThreadProcessId($windowHandle, [ref]$excelProcessId)
        $shell = New-Object -ComObject WScript.Shell
        try { [void]$shell.AppActivate([int]$excelProcessId) }
        finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
        [void][JsonReading.ExcelWindow]::SetForegroundWindow($windowHandle)
    }
    # 返回实际激活结果，供调用方检查；只释放 COM 引用，Excel 留给用户继续操作。
    @{ file = $book.FullName; sheet = $sheet.Name; foreground = ([JsonReading.ExcelWindow]::GetForegroundWindow() -eq $windowHandle) } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $excel -and $null -ne $oldEvents) { $excel.EnableEvents = $oldEvents }
    foreach ($reference in @($sheet, $sheets, $book, $books, $excel)) {
        if ($null -ne $reference -and [Runtime.InteropServices.Marshal]::IsComObject($reference)) {
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($reference)
        }
    }
}
