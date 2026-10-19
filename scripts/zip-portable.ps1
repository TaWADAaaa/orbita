param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\') + '\'
$outputPath = [IO.Path]::GetFullPath($Output)
$stream = [IO.File]::Open($outputPath, [IO.FileMode]::CreateNew)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
try {
  $files = Get-ChildItem -LiteralPath $sourcePath -Recurse -File -Force | Sort-Object FullName
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($sourcePath.Length).Replace('\','/')
    $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::new(2026, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    $inputStream = [IO.File]::OpenRead($file.FullName)
    $entryStream = $entry.Open()
    try { $inputStream.CopyTo($entryStream) } finally { $entryStream.Dispose(); $inputStream.Dispose() }
  }
} finally { $archive.Dispose(); $stream.Dispose() }
