#requires -Version 7.5
<# Narrow data-only entry. The approved contract and source pins are external
authority inputs. A successful receipt is never action/Job/QA permission. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ApprovedContractPath,
 [Parameter(Mandatory)][string]$ApprovedContractSha256,
 [Parameter(Mandatory)][string]$SourcePath,
 [Parameter(Mandatory)][string]$SourceSha256,
 [Parameter(Mandatory)][string]$Purpose,
 [Parameter(Mandatory)][string]$ManifestPath,
 # B is frozen separately by Root. No fallback to A, output or lineage exists.
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckerSourcePath,
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckerSourceSha256,
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckerApprovedContractPath,
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckerApprovedContractSha256,
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckerManifestPath,
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$CheckerManifestSha256,
 [Parameter(Mandatory)][string]$OutputDirectory,
 [switch]$Fixture
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'PreparationJson.psm1') -ErrorAction Stop
$errors=[Collections.Generic.List[object]]::new();$doc=$null;$contract=$null
function ErrorRow([string]$code,[string]$path,[string]$diagnostic=''){$errors.Add([ordered]@{code=$code;path=$path;classification='PREPARATION_BEFORE_START';diagnostic=$diagnostic})}
function Unique([Text.Json.JsonElement]$v,[string]$ptr){if($v.ValueKind -eq 'Object'){$set=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($p in $v.EnumerateObject()){if(-not $set.Add($p.Name)){throw ('PREP_DUPLICATE_KEY:'+ $ptr+'/'+$p.Name)};Unique $p.Value ($ptr+'/'+$p.Name)}}elseif($v.ValueKind -eq 'Array'){for($i=0;$i -lt $v.GetArrayLength();$i++){Unique $v[$i] ($ptr+'/'+$i)}}}
try{
 foreach($entry in (,@($ApprovedContractPath,$ApprovedContractSha256))){
  $p=$entry[0];if(-not [IO.Path]::IsPathFullyQualified($p) -or [IO.Path]::GetFullPath($p) -cne $p){throw 'PREP_CANONICAL_PATH'}
  for($q=$p;$q;){$item=Get-Item -LiteralPath $q -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PREP_LINK'};$q=[IO.Path]::GetDirectoryName($q)}
  if((Get-Item -LiteralPath $p).Length -gt 2097152 -or $entry[1] -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[1]){throw 'PREP_PIN_DRIFT'}
 }
 $contractRead=Read-PreparationJson -Path $ApprovedContractPath -Sha256 $ApprovedContractSha256 -AllowedRoots @([IO.Path]::GetDirectoryName($ApprovedContractPath)) -MaxBytes 65536
 $contract=$contractRead.Document;$cv=$contractRead.Root
 Unique $cv '/contract'
 $inputRoot=$cv.GetProperty('input_root').GetString();$testRoot=Join-Path (Split-Path $inputRoot) 'evidence\tmp'
 if(-not ($SourcePath.StartsWith($inputRoot+'\',[StringComparison]::Ordinal) -or ($Fixture -and $SourcePath.StartsWith($testRoot+'\',[StringComparison]::Ordinal)))){throw 'PREP_DOMAIN'}
 if(-not [IO.Path]::IsPathFullyQualified($SourcePath) -or [IO.Path]::GetFullPath($SourcePath) -cne $SourcePath){throw 'PREP_CANONICAL_PATH'}
 for($q=$SourcePath;$q;){$item=Get-Item -LiteralPath $q -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PREP_LINK'};$q=[IO.Path]::GetDirectoryName($q)}
 if((Get-Item -LiteralPath $SourcePath).Length -gt 2097152 -or $SourceSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $SourceSha256){throw 'PREP_PIN_DRIFT'}
 $readRoots=@($inputRoot);if($Fixture){$readRoots+=@($testRoot)}
 $sourceRead=Read-PreparationJson -Path $SourcePath -Sha256 $SourceSha256 -AllowedRoots $readRoots
 $doc=$sourceRead.Document;$v=$sourceRead.Root
 Unique $v ''
 $required=@('format','purpose','project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256','not_before','expires_at','writers','strict_record_keys','material')
 if($v.ValueKind -ne 'Object'){throw 'PREP_OBJECT'}
 $names=@($v.EnumerateObject()|ForEach-Object Name)
 foreach($n in $required){if($names -cnotcontains $n){ErrorRow 'MISSING_FIELD' ('/'+$n)}}
 foreach($n in $names){if($required -cnotcontains $n){ErrorRow 'UNKNOWN_FIELD' ('/'+$n)}}
 # Unsafe identity mismatch stops all dependent reads, never guessed or repaired.
 foreach($n in @('project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256','not_before','expires_at')){if($names -ccontains $n){$value=$v.GetProperty($n);if($value.ValueKind -ne 'String' -or $value.GetString() -cne $cv.GetProperty($n).GetString()){throw ('PREP_IDENTITY:'+ $n)}}}
 if($names -ccontains 'purpose'){if($v.GetProperty('purpose').ValueKind -ne 'String' -or $v.GetProperty('purpose').GetString() -cne $Purpose){throw 'PREP_PURPOSE'}}
 if($Purpose -ceq 'FORMAL_QA_SUBJECT'){throw 'PREP_UNSUPPORTED_FORMAL_QA_CARRIER_EVIDENCE'}
 $materialKeys=switch -CaseSensitive ($Purpose){
  'IMPLEMENTATION_RECORD'{@('format','job_id','role','session','manifest_sha256','writer_status','job_release')}
  'IMPLEMENTATION_RELEASE'{@('job_id','task_name','message')}
  'RECORD_PREFLIGHT'{@('expected','record')}
  'CAPACITY_SUBJECT'{@('format','status','role','session_ref','job_id','task_id','spec_sha256','manifest_sha256','source_root','execution_bindings_path','execution_bindings_sha256','role_admission','carrier_path','carrier_sha256','command','capacity_request')}
  default{throw 'PREP_UNSUPPORTED_PURPOSE'}
 }
 if($names -ccontains 'material'){
  $m=$v.GetProperty('material');if($m.ValueKind -ne 'Object'){throw 'PREP_MATERIAL_OBJECT'}
  $mn=@($m.EnumerateObject()|ForEach-Object Name)
  foreach($n in $materialKeys){if($mn -cnotcontains $n){ErrorRow 'MISSING_FIELD' ('/material/'+$n)}}
  foreach($n in $mn){if($materialKeys -cnotcontains $n){ErrorRow 'UNKNOWN_FIELD' ('/material/'+$n)}}
  function Shape([Text.Json.JsonElement]$node,[string[]]$required,[string]$ptr){
   if($node.ValueKind -ne 'Object'){ErrorRow 'OBJECT_REQUIRED' $ptr;return}
   $actual=@($node.EnumerateObject()|ForEach-Object Name)
   foreach($n in $required){if($actual -cnotcontains $n){ErrorRow 'MISSING_FIELD' ($ptr+'/'+$n)}}
   foreach($n in $actual){if($required -cnotcontains $n){ErrorRow 'UNKNOWN_FIELD' ($ptr+'/'+$n)}}
  }
  if($Purpose -ceq 'IMPLEMENTATION_RECORD' -and $mn -ccontains 'session'){Shape $m.GetProperty('session') @('format','role','session_ref','source_claim','native_authenticated','dispatch_request','dispatch_return','natural_final','natural_end','stop_requested','completion_observation') '/material/session'}
  if($Purpose -ceq 'RECORD_PREFLIGHT' -and $mn -ccontains 'expected'){Shape $m.GetProperty('expected') @('project_root','project_id','control_root','input_root','server_path','server_sha256','node_path','node_sha256','node_version','config_sha256') '/material/expected'}
  $seen=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  function Inventory([Text.Json.JsonElement]$node,[string]$ptr){
   if($seen.Count -gt 128 -or $ptr.Length -gt 8192){throw 'PREP_GRAPH_BOUND'}
   if($node.ValueKind -eq 'Object'){
    $nn=@($node.EnumerateObject()|ForEach-Object Name)
    foreach($id in @('job_id','task_id','spec_sha256')){if($nn -ccontains $id){$value=$node.GetProperty($id);if($value.ValueKind -ne 'String' -or $value.GetString() -cne $cv.GetProperty($id).GetString()){throw ('PREP_IDENTITY:'+ $ptr+'/'+$id)}}}
    if($nn -ccontains 'path' -or $nn -ccontains 'sha256'){
     if($nn.Count -ne 2 -or $nn -cnotcontains 'path' -or $nn -cnotcontains 'sha256'){throw ('PREP_UNSUPPORTED_REFERENCE:'+ $ptr)}
     $p=$node.GetProperty('path');$h=$node.GetProperty('sha256');if($p.ValueKind -ne 'String' -or $h.ValueKind -ne 'String' -or $h.GetString() -cnotmatch '^[a-f0-9]{64}$'){throw ('PREP_REF_TYPE:'+ $ptr)}
     $path=$p.GetString();if([IO.Path]::GetFullPath($path) -cne $path -or -not ($path.StartsWith($inputRoot+'\',[StringComparison]::Ordinal) -or ($Fixture -and $path.StartsWith($testRoot+'\',[StringComparison]::Ordinal)))){throw ('PREP_REF_DOMAIN:'+ $ptr)}
     if(-not [IO.File]::Exists($path)){ErrorRow 'MISSING_FILE' ($ptr+'/path')}
     elseif($seen.ContainsKey($path)){if($seen[$path] -cne $h.GetString()){throw ('PREP_CONFLICTING_REF:'+ $ptr)}}
     else{
      for($q=$path;$q;){$item=Get-Item -LiteralPath $q -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PREP_LINK'};$q=[IO.Path]::GetDirectoryName($q)}
      if((Get-Item -LiteralPath $path).Length -gt 2097152){throw 'PREP_LEAF_SIZE'}
      try{$leafRead=Read-PreparationJson -Path $path -Sha256 $h.GetString() -AllowedRoots $readRoots}catch{if($_.Exception.Message -like 'PIN_DRIFT*'){ErrorRow 'PIN_DRIFT' $ptr;return};throw}
      $seen.Add($path,$h.GetString());$leaf=$leafRead.Document
      try{
       Unique $leaf.RootElement $ptr
       if($ptr -ceq '/material/writer_status'){Shape $leaf.RootElement @('format','job_id','manifest_sha256','scope','unknown_writers','writers','observation') $ptr}
       if($ptr -ceq '/material/session/natural_final'){Shape $leaf.RootElement @('message_type','sender','payload','truncated') $ptr}
       Inventory $leaf.RootElement $ptr
      }finally{$leaf.Dispose()}
     }
    }else{foreach($p in $node.EnumerateObject()){Inventory $p.Value ($ptr+'/'+$p.Name)}}
   }elseif($node.ValueKind -eq 'Array'){for($i=0;$i -lt $node.GetArrayLength();$i++){Inventory $node[$i] ($ptr+'/'+$i)}}
  }
  Inventory $m '/material'
 }
 if($errors.Count -eq 0){
  $a=@{ApprovedContractPath=$ApprovedContractPath;ApprovedContractSha256=$ApprovedContractSha256;SourcePath=$SourcePath;SourceSha256=$SourceSha256;Purpose=$Purpose;ManifestPath=$ManifestPath;ManifestSha256=$cv.GetProperty('manifest_sha256').GetString();Fixture=$Fixture}
  $output=Join-Path $OutputDirectory 'material.json';$lineage=Join-Path $OutputDirectory 'lineage.json'
  $derived=& (Join-Path $PSScriptRoot 'Derive-Material.ps1') @a -OutputPath $output -LineagePath $lineage
   $b=@{ApprovedContractPath=$CheckerApprovedContractPath;ApprovedContractSha256=$CheckerApprovedContractSha256;SourcePath=$CheckerSourcePath;SourceSha256=$CheckerSourceSha256;Purpose=$Purpose;ManifestPath=$CheckerManifestPath;ManifestSha256=$CheckerManifestSha256;Fixture=$Fixture}
   $checked=& (Join-Path $PSScriptRoot 'Test-Material.ps1') @b -ActualPath $derived.path -ActualSha256 $derived.sha256
   [pscustomobject]@{status='CHECKED_NOT_EXECUTED';material=$derived;check=$checked;expected_source=[ordered]@{path=$CheckerSourcePath;sha256=$CheckerSourceSha256};expected_contract=[ordered]@{path=$CheckerApprovedContractPath;sha256=$CheckerApprovedContractSha256};errors=@();execution_allowed=$false}
 }else{[pscustomobject]@{status='REJECTED';errors=$errors.ToArray();execution_allowed=$false}}
}catch{
 $message=$_.Exception.Message.Split("`n")[0];$path=''
 if($message -cmatch '^([A-Z][A-Z0-9_]+)(?::(.*))?$'){$code=$Matches[1];if($Matches.ContainsKey(2)){$path=$Matches[2]}}
 else{$code=switch -Regex ($_.Exception.GetType().Name){'FileNotFound|DirectoryNotFound|ItemNotFound'{'MISSING_FILE';break};'UnauthorizedAccess'{'ACCESS_DENIED';break};'JsonException'{'JSON_INVALID';break};'IOException'{'IO_FAILURE';break};'KeyNotFound'{'MISSING_FIELD';break};default{'INTERNAL_ERROR'}}}
 ErrorRow $code $path $message;[pscustomobject]@{status='REJECTED';errors=$errors.ToArray();execution_allowed=$false}
}
finally{if($doc){$doc.Dispose()};if($contract){$contract.Dispose()}}
