#requires -Version 7.5
Set-StrictMode -Version Latest
function Read-PreparationRaw {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,[Parameter(Mandatory)][string[]]$AllowedRoots,[ValidateRange(1,2097152)][int]$MaxBytes=2097152)
 if(-not [IO.Path]::IsPathFullyQualified($Path) -or [IO.Path]::GetFullPath($Path) -cne $Path){throw 'PATH_CANONICAL'}
 $inside=$false;foreach($r in $AllowedRoots){if(-not [IO.Path]::IsPathFullyQualified($r) -or [IO.Path]::GetFullPath($r) -cne $r){throw 'ROOT_CANONICAL'};if($Path.StartsWith($r.TrimEnd('\')+'\',[StringComparison]::Ordinal)){$inside=$true}}
 if(-not $inside){throw 'PATH_DOMAIN'}
 if($Sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'PIN_SHAPE'}
 # The same leaf/ancestor guards use filesystem attributes directly. No path
 # safety result is cached between reads or actions.
 for($q=$Path;$q;){try{$attributes=[IO.File]::GetAttributes($q)}catch [IO.FileNotFoundException]{throw ('MISSING_FILE|'+$Path)}catch [IO.DirectoryNotFoundException]{throw ('MISSING_FILE|'+$Path)};if($attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PATH_LINK'};if($q -ceq $Path -and ($attributes -band [IO.FileAttributes]::Directory)){throw 'INPUT_SIZE'};$q=[IO.Path]::GetDirectoryName($q)}
 $info=[IO.FileInfo]::new($Path);if($info.Length -gt $MaxBytes){throw 'INPUT_SIZE'}
 $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $memory=[IO.MemoryStream]::new()
 try{$buffer=[byte[]]::new(4096);while(($n=$stream.Read($buffer,0,$buffer.Length)) -gt 0){if($memory.Length+$n -gt $MaxBytes){throw 'INPUT_SIZE'};$memory.Write($buffer,0,$n)};$bytes=$memory.ToArray()}finally{$stream.Dispose();$memory.Dispose()}
 $actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant();if($actual -cne $Sha256){throw ('PIN_DRIFT|'+$Path)}
 [pscustomobject]@{Path=$Path;Sha256=$Sha256;Bytes=$bytes.Length;Text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)}
}
function Read-PreparationJson {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,[Parameter(Mandatory)][string[]]$AllowedRoots,[ValidateRange(1,2097152)][int]$MaxBytes=2097152)
 $raw=Read-PreparationRaw -Path $Path -Sha256 $Sha256 -AllowedRoots $AllowedRoots -MaxBytes $MaxBytes
 $options=[Text.Json.JsonDocumentOptions]::new();$options.MaxDepth=32
 $doc=[Text.Json.JsonDocument]::Parse($raw.Text,$options)
 try{
  function CheckUnique([Text.Json.JsonElement]$e){if($e.ValueKind -eq 'Object'){$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($p in $e.EnumerateObject()){if(-not $names.Add($p.Name)){throw ('JSON_DUPLICATE_KEY|'+$p.Name)};CheckUnique $p.Value}}elseif($e.ValueKind -eq 'Array'){foreach($v in $e.EnumerateArray()){CheckUnique $v}}}
  CheckUnique $doc.RootElement
  $data=ConvertFrom-Json -InputObject $raw.Text -AsHashtable -DateKind String -NoEnumerate -Depth 32
  # Caller disposes Document. Data is administrative convenience; Root retains
  # protocol number lexical form and native JSON kinds without PS roundtrips.
  [pscustomobject]@{Path=$raw.Path;Sha256=$raw.Sha256;Bytes=$raw.Bytes;Text=$raw.Text;Data=$data;Document=$doc;Root=$doc.RootElement}
 }catch{$doc.Dispose();throw}
}
function Get-PreparationString {
 [CmdletBinding()]param([Parameter(Mandatory)]$Read,[Parameter(Mandatory)][AllowEmptyString()][string]$Pointer,[switch]$UtcMilliseconds)
 $v=$Read.Root
 if($Pointer){if(-not $Pointer.StartsWith('/')){throw 'JSON_POINTER'};foreach($part in $Pointer.Substring(1).Split('/')){$key=$part.Replace('~1','/').Replace('~0','~');if($v.ValueKind -eq 'Object'){$v=$v.GetProperty($key)}elseif($v.ValueKind -eq 'Array' -and $key -cmatch '^(0|[1-9][0-9]*)$' -and [int]$key -lt $v.GetArrayLength()){$v=$v[[int]$key]}else{throw 'JSON_POINTER'}}}
 if($v.ValueKind -ne 'String'){throw 'JSON_STRING'};$text=$v.GetString()
 if($UtcMilliseconds){$date=[DateTimeOffset]::MinValue;if($text -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or -not [DateTimeOffset]::TryParseExact($text,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$date)){throw 'JSON_UTC_MILLISECONDS'}}
 $text
}
Export-ModuleMember -Function Read-PreparationRaw,Read-PreparationJson,Get-PreparationString
