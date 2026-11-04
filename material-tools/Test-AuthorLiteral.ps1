#requires -Version 7.5
<# External author adapter example: literal checks only, never applies edits. #>
[CmdletBinding()]param([Parameter(Mandatory)][string]$RulesPath,[Parameter(Mandatory)][string]$RulesSha256,[Parameter(Mandatory)][string]$SourcePath,[Parameter(Mandatory)][string]$SourceSha256,[Parameter(Mandatory)][string[]]$AllowedRoots)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'PreparationJson.psm1') -ErrorAction Stop
$rules=$null
try{
 $rules=Read-PreparationJson -Path $RulesPath -Sha256 $RulesSha256 -AllowedRoots $AllowedRoots
 $root=$rules.Root;$names=@($root.EnumerateObject()|ForEach-Object Name)
 if($names.Count -ne 2 -or $names -cnotcontains 'format' -or $names -cnotcontains 'rules' -or (Get-PreparationString -Read $rules -Pointer '/format') -cne 'xdev-author-literal-rules-1'){throw 'AUTHOR_RULES_SCHEMA'}
 $array=$root.GetProperty('rules');if($array.ValueKind -ne 'Array' -or $array.GetArrayLength() -lt 1 -or $array.GetArrayLength() -gt 64){throw 'AUTHOR_RULES_ARRAY'}
 $source=Read-PreparationRaw -Path $SourcePath -Sha256 $SourceSha256 -AllowedRoots $AllowedRoots
 $rows=@();for($i=0;$i -lt $array.GetArrayLength();$i++){$v=$array[$i];$keys=@($v.EnumerateObject()|ForEach-Object Name);if($keys.Count -ne 2 -or $keys -cnotcontains 'old' -or $keys -cnotcontains 'occurrences' -or $v.GetProperty('occurrences').ValueKind -ne 'Number'){throw 'AUTHOR_RULE_SCHEMA'};$literal=Get-PreparationString -Read $rules -Pointer ('/rules/'+$i+'/old');if(-not $literal){throw 'AUTHOR_EMPTY_LITERAL'};$expected=$v.GetProperty('occurrences').GetInt32();if($expected -lt 0){throw 'AUTHOR_OCCURRENCES'};$actual=[regex]::Matches($source.Text,[regex]::Escape($literal)).Count;$rows+=@{index=$i;literal=$literal;expected=$expected;actual=$actual;passed=($expected -eq $actual)}}
 [pscustomobject]@{status=if(@($rows|Where-Object passed -eq $false).Count){'REJECTED'}else{'CHECKED_LITERAL_ONLY'};rows=$rows;reader='PreparationJson.psm1';execution_allowed=$false}
}finally{if($rules){$rules.Document.Dispose()}}
