#requires -Version 7.5
<# Historical author rules are data, never replacement or execution authority. #>
[CmdletBinding()]param([Parameter(Mandatory)][string]$RulesPath,[Parameter(Mandatory)][string]$RulesSha256,[Parameter(Mandatory)][string]$SourcePath,[Parameter(Mandatory)][string]$SourceSha256,[Parameter(Mandatory)][string[]]$AllowedRoots)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'PreparationJson.psm1') -ErrorAction Stop
function ExplicitPath([string]$value){
 # The adopted argv uses O:/ spelling. Normalize separators only; reject
 # relative paths and traversal instead of resolving them into authority.
 $path=$value.Replace('/','\')
 if(-not [IO.Path]::IsPathFullyQualified($path) -or [IO.Path]::GetFullPath($path) -cne $path){throw 'AUTHOR_CANONICAL_PATH'}
 return $path
}
$RulesPath=ExplicitPath $RulesPath;$SourcePath=ExplicitPath $SourcePath
$AllowedRoots=@($AllowedRoots|ForEach-Object {ExplicitPath $_})
function Closed([Text.Json.JsonElement]$v,[string[]]$keys){
 if($v.ValueKind -ne 'Object'){throw 'AUTHOR_SCHEMA_OBJECT'}
 $names=@($v.EnumerateObject()|ForEach-Object Name)
 if($names.Count -ne $keys.Count){throw 'AUTHOR_SCHEMA_KEYS'}
 foreach($key in $keys){if($names -cnotcontains $key){throw ('AUTHOR_SCHEMA_KEY|'+$key)}}
}
function Integer([Text.Json.JsonElement]$v){
 $n=0L;if($v.ValueKind -ne 'Number' -or -not $v.TryGetInt64([ref]$n) -or $n -lt 0){throw 'AUTHOR_NONNEGATIVE_INTEGER'};return $n
}
function Reference([Text.Json.JsonElement]$v,[string[]]$keys){
 Closed $v $keys
 foreach($key in @('path','sha256')){if($v.GetProperty($key).ValueKind -ne 'String' -or -not $v.GetProperty($key).GetString()){throw 'AUTHOR_REF_STRING'}}
 if($v.GetProperty('sha256').GetString() -cnotmatch '^[a-f0-9]{64}$'){throw 'AUTHOR_REF_PIN'}
 if($keys -ccontains 'bytes'){$null=Integer $v.GetProperty('bytes')}
 # Deliberately do not follow historical paths. Only explicit SourcePath is read.
}
$read=$null
try{
 $read=Read-PreparationJson -Path $RulesPath -Sha256 $RulesSha256 -AllowedRoots $AllowedRoots
 $r=$read.Root
 Closed $r @('format','status','source','original_source','destination','job_id','task_id','spec','baseline','actual_start','carriers','known_rule_count','pending_rule_index','actual_author','write_released','rules')
 # The pinned document has sixteen fields; its task's numeral 17 was a typo.
 foreach($key in @('format','status','destination','job_id','task_id','actual_author')){$s=Get-PreparationString -Read $read -Pointer ('/'+$key);if(-not $s){throw 'AUTHOR_TOP_STRING'}}
 if((Get-PreparationString -Read $read -Pointer '/format') -cne 'root6-helper-rules-pending-actual-session-1'){throw 'AUTHOR_FORMAT'}
 Reference $r.GetProperty('source') @('path','bytes','sha256')
 Reference $r.GetProperty('original_source') @('path','sha256')
 Reference $r.GetProperty('spec') @('path','sha256')
 Reference $r.GetProperty('baseline') @('path','sha256','bytes')
 Reference $r.GetProperty('actual_start') @('path','sha256','bytes')
 $carriers=$r.GetProperty('carriers');if($carriers.ValueKind -ne 'Array' -or $carriers.GetArrayLength() -ne 2){throw 'AUTHOR_CARRIERS'}
 foreach($carrier in $carriers.EnumerateArray()){Reference $carrier @('path','bytes','sha256')}
 if($r.GetProperty('write_released').ValueKind -notin @('True','False')){throw 'AUTHOR_TOP_BOOLEAN'}
 $known=Integer $r.GetProperty('known_rule_count');$pending=Integer $r.GetProperty('pending_rule_index')
 $array=$r.GetProperty('rules');if($array.ValueKind -ne 'Array' -or $array.GetArrayLength() -lt 1 -or $array.GetArrayLength() -gt 64 -or $array.GetArrayLength() -ne ($known+1) -or $pending -ne $known){throw 'AUTHOR_HISTORICAL_COUNTS'}
 $source=Read-PreparationRaw -Path $SourcePath -Sha256 $SourceSha256 -AllowedRoots $AllowedRoots
 if($SourceSha256 -cne $r.GetProperty('source').GetProperty('sha256').GetString() -or $source.Bytes -ne (Integer $r.GetProperty('source').GetProperty('bytes')) -or $SourceSha256 -cne $r.GetProperty('original_source').GetProperty('sha256').GetString()){throw 'AUTHOR_SOURCE_BINDING'}
 $indices=[Collections.Generic.HashSet[long]]::new();$rows=@()
 for($i=0;$i -lt $array.GetArrayLength();$i++){
  $v=$array[$i];Closed $v @('index','old','new','occurrences','origin','status','only')
  $index=Integer $v.GetProperty('index');if(-not $indices.Add($index)){throw 'AUTHOR_DUPLICATE_INDEX'}
  foreach($key in @('old','new','origin','status','only')){$null=Get-PreparationString -Read $read -Pointer ('/rules/'+$i+'/'+$key)}
  $literal=Get-PreparationString -Read $read -Pointer ('/rules/'+$i+'/old');if(-not $literal){throw 'AUTHOR_EMPTY_LITERAL'}
  $expected=Integer $v.GetProperty('occurrences');$actual=[regex]::Matches($source.Text,[regex]::Escape($literal)).Count
  $rows+=@{index=$index;expected=$expected;actual=$actual;passed=($expected -eq $actual)}
 }
 for($i=0;$i -lt $array.GetArrayLength();$i++){if(-not $indices.Contains([long]$i)){throw 'AUTHOR_INDEX_SET'}}
 $pendingRows=@($read.Data.rules|Where-Object index -EQ $pending)
 if($pendingRows.Count -ne 1 -or $pendingRows[0].status -cne 'PENDING_ACTUAL_FULL_AUTHOR_TASK_NAME'){throw 'AUTHOR_PENDING_DECLARATION'}
 if(@($rows|Where-Object passed -EQ $false).Count){throw 'AUTHOR_LITERAL_COUNT_MISMATCH'}
 [ordered]@{status='CHECKED_LITERAL_ONLY';execution_allowed=$false;reader='PreparationJson.psm1';rules_ref=@{path=$RulesPath;sha256=$RulesSha256};source_ref=@{path=$SourcePath;sha256=$SourceSha256};original_text=$read.Text;metadata=$read.Data;pending_metadata=@{known_rule_count=$known;pending_rule_index=$pending;rule=$pendingRows[0];interpretation='HISTORICAL_PENDING_RETAINED'};rows=$rows}|ConvertTo-Json -Depth 32 -Compress
}finally{if($read){$read.Document.Dispose()}}
