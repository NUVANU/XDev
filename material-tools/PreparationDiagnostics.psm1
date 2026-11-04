#requires -Version 7.5
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'PreparationJson.psm1') -ErrorAction Stop
function Assert-DiagnosticKeys($v,[string[]]$keys){if($v -isnot [Collections.IDictionary] -or $v.Count -ne $keys.Count){throw 'DIAG_KEYS'};foreach($k in $keys){if(-not $v.Contains($k)){throw ('DIAG_MISSING_KEY|'+$k)}}}
function Assert-DiagnosticString($v){if($v -isnot [string] -or -not $v -or $v.Length -gt 2048){throw 'DIAG_STRING'}}
function Assert-DiagnosticNumber($v){if($null -ne $v -and ($v -is [bool] -or $v -isnot [ValueType] -or $v -is [DateTime] -or -not [double]::IsFinite([double]$v) -or [double]$v -lt 0)){throw 'DIAG_NUMBER'}}
function Read-PreparationDiagnostic {
 [CmdletBinding()]param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Sha256,[Parameter(Mandatory)][string[]]$AllowedRoots,[Parameter(Mandatory)]$Scope,[Parameter(Mandatory)][string]$PackageId,[Parameter(Mandatory)][string]$Version,[Parameter(Mandatory)][string]$ItemId,[Parameter(Mandatory)][string]$AttemptId)
 $read=Read-PreparationJson -Path $Path -Sha256 $Sha256 -AllowedRoots $AllowedRoots
 try{
  $v=$read.Data;Assert-DiagnosticKeys $v @('format','scope','package_id','version','item_id','attempt','source_refs','observed_utc','layers','phases','ack','conclusion')
  if($v.format -cne 'xdev-preparation-runtime-diagnostic-1'){throw 'DIAG_FORMAT'}
  Assert-DiagnosticKeys $v.scope @('project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256')
  foreach($k in $v.scope.Keys){Assert-DiagnosticString $v.scope[$k];if($v.scope[$k] -cne $Scope[$k]){throw ('DIAG_SCOPE|'+$k)}}
  foreach($k in @('package_id','version','item_id')){Assert-DiagnosticString $v[$k]}
  if($v.package_id -cne $PackageId -or $v.version -cne $Version -or $v.item_id -cne $ItemId){throw 'DIAG_BINDING'}
  Assert-DiagnosticKeys $v.attempt @('id','layout','source_sha256','resource_sha256','parameters_sha256')
  foreach($k in $v.attempt.Keys){Assert-DiagnosticString $v.attempt[$k]}
  if($v.attempt.id -cne $AttemptId){throw 'DIAG_ATTEMPT'}
  foreach($k in @('source_sha256','resource_sha256','parameters_sha256')){if($v.attempt[$k] -cnotmatch '^[a-f0-9]{64}$'){throw 'DIAG_FINGERPRINT'}}
  if($v.attempt.source_sha256 -cne $Scope.manifest_sha256){throw 'DIAG_SOURCE_VERSION'}
  if($v.observed_utc -ne $null){$null=Get-PreparationString -Read $read -Pointer '/observed_utc' -UtcMilliseconds}
  if($v.source_refs -isnot [array] -or $v.source_refs.Count -lt 1 -or $v.source_refs.Count -gt 16){throw 'DIAG_REFS_BOUND'}
  $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach($r in $v.source_refs){Assert-DiagnosticKeys $r @('name','path','sha256','bytes');foreach($k in @('name','path','sha256')){Assert-DiagnosticString $r[$k]};if(-not $names.Add($r.name)){throw 'DIAG_DUPLICATE_REF'};if(($r.bytes -isnot [int] -and $r.bytes -isnot [long]) -or $r.bytes -lt 0 -or $r.bytes -gt 2097152){throw 'DIAG_REF_BYTES'};$raw=Read-PreparationRaw -Path $r.path -Sha256 $r.sha256 -AllowedRoots $AllowedRoots;if($raw.Bytes -ne $r.bytes){throw 'DIAG_REF_BYTES'}}
  Assert-DiagnosticKeys $v.layers @('outer','bridge','child')
  foreach($n in @('outer','bridge','child')){$layer=$v.layers[$n];Assert-DiagnosticKeys $layer @('elapsed_ms','timeout_ms','exit_code','signal','eof','natural_exit','error');Assert-DiagnosticNumber $layer.elapsed_ms;Assert-DiagnosticNumber $layer.timeout_ms;if($null -ne $layer.exit_code -and $layer.exit_code -isnot [int] -and $layer.exit_code -isnot [long]){throw 'DIAG_EXIT_CODE'};foreach($b in @('eof','natural_exit')){if($null -ne $layer[$b] -and $layer[$b] -isnot [bool]){throw 'DIAG_BOOLEAN'}};if($null -ne $layer.signal){Assert-DiagnosticString $layer.signal};Assert-DiagnosticKeys $layer.error @('layer','code','message');foreach($k in $layer.error.Keys){if($null -ne $layer.error[$k]){Assert-DiagnosticString $layer.error[$k]}}}
  if($v.phases -isnot [array] -or $v.phases.Count -gt 4){throw 'DIAG_PHASES'};$phaseNames=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach($p in $v.phases){Assert-DiagnosticKeys $p @('name','begin_ms','end_ms');if($p.name -cnotin @('STARTUP','VALIDATION','SAVE','READBACK') -or -not $phaseNames.Add($p.name)){throw 'DIAG_PHASE_NAME'};Assert-DiagnosticNumber $p.begin_ms;Assert-DiagnosticNumber $p.end_ms;if($null -ne $p.begin_ms -and $null -ne $p.end_ms -and $p.end_ms -lt $p.begin_ms){throw 'DIAG_PHASE_CLOCK'}}
  Assert-DiagnosticKeys $v.ack @('save_acknowledged','readback_acknowledged','commit_state');foreach($k in @('save_acknowledged','readback_acknowledged')){if($null -ne $v.ack[$k] -and $v.ack[$k] -isnot [bool]){throw 'DIAG_ACK_TYPE'}}
  if($v.ack.commit_state -cnotin @('UNKNOWN','COMMITTED') -or ($v.ack.commit_state -ceq 'COMMITTED' -and $v.ack.save_acknowledged -cne $true)){throw 'DIAG_COMMIT_STATE'}
  Assert-DiagnosticKeys $v.conclusion @('status','text');if($v.conclusion.status -cnotin @('OBSERVED','HYPOTHESIS','UNKNOWN')){throw 'DIAG_CONCLUSION'};Assert-DiagnosticString $v.conclusion.text
  [pscustomobject]@{Data=$v;Text=$read.Text;Bytes=$read.Bytes;Ref=@{path=$Path;sha256=$Sha256}}
 }finally{$read.Document.Dispose()}
}
function Get-PreparationDiagnosticSummary {
 [CmdletBinding()]param([Parameter(Mandatory)]$Diagnostic)
 $v=$Diagnostic.Data;$phases=@();foreach($name in @('STARTUP','VALIDATION','SAVE','READBACK')){$p=@($v.phases|Where-Object name -CEQ $name);$known=$p.Count -eq 1 -and $null -ne $p[0].begin_ms -and $null -ne $p[0].end_ms;$phases+=@{name=$name;status=if($known){'OBSERVED_INTERVAL'}else{'UNKNOWN'};elapsed_ms=if($known){$p[0].end_ms-$p[0].begin_ms}else{$null}}}
 $code=$null;foreach($n in @('child','bridge','outer')){if($v.layers[$n].error.code){$code=$v.layers[$n].error.code;break}}
 [pscustomobject]@{attempt=$v.attempt;observed_version=$v.version;item_id=$v.item_id;layers=$v.layers;phases=$phases;last_observed_phase=if($v.phases.Count){$v.phases[-1].name}else{'UNKNOWN'};ack=$v.ack;conclusion=$v.conclusion;failure_code=$code;missing_ack=($v.ack.save_acknowledged -cne $true -or $v.ack.readback_acknowledged -cne $true);source_refs=$v.source_refs;original=$Diagnostic.Ref;execution_allowed=$false;retry_allowed=$false;next_evidence='External stage/ACK evidence or current external decision; no retry permission supplied'}
}
Export-ModuleMember -Function Read-PreparationDiagnostic,Get-PreparationDiagnosticSummary
