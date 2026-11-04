#requires -Version 7.5
<# Package-local data preparation, not a second Job/execution coordinator.
All operations need caller-supplied approved plan or exact state pin. No command
is executed; Observe only records externally supplied evidence and outcome. #>
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Init','Check','Freeze','Observe','Correct','Context','Expand')][string]$Action,
 [string]$PlanPath,[string]$PlanSha256,[string]$PackageDirectory,
 [string]$StatePath,[string]$StateSha256,
 [string]$ItemId,
 [ValidateSet('SUCCESS','COMMAND_FAILURE','ENVIRONMENT_FAILURE','UNKNOWN')][string]$Outcome,
 [string]$ObservationPath,[string]$ObservationSha256,
 [string]$DiagnosticPath,[string]$DiagnosticSha256,[string]$DiagnosticAttemptId,
 [switch]$Fixture
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'PreparationJson.psm1') -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'PreparationDiagnostics.psm1') -ErrorAction Stop
$timer=[Diagnostics.Stopwatch]::StartNew();$readBytes=0L;$readCount=0;$lock=$null;$attempted=$false;$root=$null;$phase='PREPARATION_BEFORE_START'
function Fail([string]$code,[string]$path=''){throw ($code+'|'+$path)}
function Canonical([string]$p,[bool]$new=$false){
 if(-not [IO.Path]::IsPathFullyQualified($p) -or [IO.Path]::GetFullPath($p) -cne $p){Fail 'PATH_CANONICAL' $p}
 $q=if($new){[IO.Path]::GetDirectoryName($p)}else{$p}
 for(;$q;){try{$attributes=[IO.File]::GetAttributes($q)}catch [IO.FileNotFoundException]{Fail 'MISSING_FILE' $p}catch [IO.DirectoryNotFoundException]{Fail 'MISSING_FILE' $p};if($attributes -band [IO.FileAttributes]::ReparsePoint){Fail 'PATH_LINK' $p};if($new -and $q -ceq [IO.Path]::GetDirectoryName($p) -and -not ($attributes -band [IO.FileAttributes]::Directory)){Fail 'PATH_TYPE' $p};$q=[IO.Path]::GetDirectoryName($q)}
}
function FileSha256([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Ref([string]$p){@{path=$p;sha256=(FileSha256 $p)}}
function Unique([Text.Json.JsonElement]$e,[int]$depth=0){
 if($depth -gt 32){Fail 'JSON_DEPTH'}
 if($e.ValueKind -eq 'Object'){$n=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($v in $e.EnumerateObject()){if(-not $n.Add($v.Name)){Fail 'JSON_DUPLICATE_KEY' $v.Name};Unique $v.Value ($depth+1)}}elseif($e.ValueKind -eq 'Array'){foreach($v in $e.EnumerateArray()){Unique $v ($depth+1)}}
}
function ReadJson([string]$p,[string]$sha,[switch]$WithRaw){
 # Administrative refs are explicitly pinned by caller/state. Business leaves
 # additionally pass Domain before reading; parent is not new authorization.
 $r=Read-PreparationJson -Path $p -Sha256 $sha -AllowedRoots @([IO.Path]::GetDirectoryName($p))
 try{$script:readCount++;$script:readBytes+=$r.Bytes;if($WithRaw){@{data=$r.Data;text=$r.Text}}else{$r.Data}}finally{$r.Document.Dispose()}
}
function FailureInfo($errorRecord,[string]$fallbackPath=''){
 $message=$errorRecord.Exception.Message;$parts=$message.Split('|',2)
 if($parts[0] -cmatch '^[A-Z][A-Z0-9_]+$'){@{code=$parts[0];path=if($parts.Count -gt 1){$parts[1]}else{$fallbackPath};diagnostic=$message};return}
 if($message -cmatch '^((?:CHECK|MATERIAL|PREP|DIAG)_[A-Z0-9_]+)(?::(.*))?$'){@{code=$Matches[1];path=if($Matches.ContainsKey(2)){$Matches[2]}else{$fallbackPath};diagnostic=$message};return}
 $code=switch -Regex ($errorRecord.Exception.GetType().Name){'FileNotFound|DirectoryNotFound|ItemNotFound'{'MISSING_FILE';break};'UnauthorizedAccess'{'ACCESS_DENIED';break};'JsonException'{'JSON_INVALID';break};'KeyNotFound'{'MISSING_FIELD';break};'IOException'{'IO_FAILURE';break};default{'INTERNAL_ERROR'}}
 @{code=$code;path=$fallbackPath;diagnostic=$message}
}
function Keys($v,[string[]]$keys,[string]$ptr){
 if($v -isnot [Collections.IDictionary]){Fail 'JSON_OBJECT' $ptr}
 if($v.Count -ne $keys.Count){Fail 'JSON_KEYS' $ptr}
 foreach($k in $keys){if(-not $v.Contains($k)){Fail 'MISSING_FIELD' ($ptr+'/'+$k)}}
}
function Text($v,[string]$ptr){if($v -isnot [string] -or -not $v){Fail 'JSON_STRING' $ptr}}
function Array($v,[string]$ptr){if($v -isnot [array]){Fail 'JSON_ARRAY' $ptr}}
function FileRef($v,[string]$ptr){Keys $v @('path','sha256') $ptr;Text $v.path ($ptr+'/path');Text $v.sha256 ($ptr+'/sha256');if($v.sha256 -cnotmatch '^[a-f0-9]{64}$'){Fail 'PIN_SHAPE' $ptr};Canonical $v.path $true;if(Test-Path -LiteralPath $v.path){Canonical $v.path}}
function Save([string]$p,$v){
 Canonical $p $true
 $raw=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $v -Depth 50 -Compress))
 $f=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$f.Write($raw,0,$raw.Length);$f.Flush($true)}finally{$f.Dispose()};Ref $p
}
function SameRef($a,$b){$a.path -ceq $b.path -and $a.sha256 -ceq $b.sha256}
function SameScope($a,$b){foreach($k in @('project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256')){if(-not $a.Contains($k) -or -not $b.Contains($k) -or $a[$k] -cne $b[$k]){return $false}};return $true}
function LoadPlan([string]$p,[string]$sha){
 $v=ReadJson $p $sha
 $legacy=$v.format -ceq 'xdev-preparation-package-plan-1'
 if(-not $legacy -and $v.format -cne 'xdev-preparation-package-plan-2'){Fail 'PLAN_FORMAT'}
 $planKeys=@('format','package_id','version','scope','material_contract','manifest','required_constraints','sources','materials','memory')
 if(-not $legacy){$planKeys+=@('checker_contract','checker_manifest')}
 Keys $v $planKeys '/plan'
 if($legacy -and $Action -cnotin @('Context','Expand')){Fail 'LEGACY_PLAN_REBIND_REQUIRED'}
 foreach($k in @('package_id','version')){Text $v[$k] ('/plan/'+$k);if($v[$k].Length -gt 80){Fail 'IDENTITY_LENGTH' $k}}
 Keys $v.scope @('project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256') '/scope';foreach($k in $v.scope.Keys){Text $v.scope[$k] ('/scope/'+$k)}
 FileRef $v.material_contract '/material_contract';FileRef $v.manifest '/manifest'
 $mc=ReadJson $v.material_contract.path $v.material_contract.sha256
 foreach($k in $v.scope.Keys){if($mc[$k] -cne $v.scope[$k]){Fail 'PLAN_SCOPE' ('/scope/'+$k)}}
 if($mc.manifest_sha256 -cne $v.manifest.sha256 -or $v.manifest.sha256 -cne $v.scope.manifest_sha256){Fail 'PLAN_MANIFEST'}
 $bc=$null
 if(-not $legacy){
  FileRef $v.checker_contract '/checker_contract';FileRef $v.checker_manifest '/checker_manifest'
  $bc=ReadJson $v.checker_contract.path $v.checker_contract.sha256
  if(-not (SameScope $bc $v.scope)){Fail 'CHECKER_PLAN_SCOPE'}
  if($bc.manifest_sha256 -cne $v.checker_manifest.sha256 -or $v.checker_manifest.sha256 -cne $v.scope.manifest_sha256){Fail 'CHECKER_PLAN_MANIFEST'}
 }
 Array $v.required_constraints '/required_constraints';if($v.required_constraints.Count -lt 1 -or $v.required_constraints.Count -gt 32){Fail 'CONSTRAINTS_BOUND'};foreach($c in $v.required_constraints){Text $c '/required_constraints';if($c.Length -gt 2048){Fail 'CONSTRAINT_LENGTH'}}
 Keys $v.memory @('mode','adoption') '/memory';if($v.memory.mode -cne 'EXTERNAL_EXPLICIT_ONLY' -or $v.memory.adoption -cne 'NOT_ESTABLISHED'){Fail 'MEMORY_UNSUPPORTED'}
 Array $v.sources '/sources';Array $v.materials '/materials'
 if($v.sources.Count -lt 1 -or $v.sources.Count -gt 64 -or $v.materials.Count -lt 1 -or $v.materials.Count -gt 32){Fail 'PLAN_BOUND'}
 $ids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($s in $v.sources){Keys $s @('id','ref','depends_on') '/sources';Text $s.id '/sources/id';if($s.id -cnotmatch '^[a-z][a-z0-9_-]{0,47}$' -or -not $ids.Add($s.id)){Fail 'SOURCE_ID'};FileRef $s.ref ('/sources/'+$s.id);Array $s.depends_on ('/sources/'+$s.id+'/depends_on')}
 foreach($s in $v.sources){foreach($id in $s.depends_on){Text $id '/depends_on';if(-not $ids.Contains($id)){Fail 'DEPENDENCY_UNKNOWN' $id}}}
 function Walk([string]$id,[string[]]$trail){if($trail -ccontains $id){Fail 'DEPENDENCY_CYCLE' $id};$s=@($v.sources|Where-Object id -CEQ $id)[0];foreach($d in $s.depends_on){Walk $d ($trail+@($id))}}
 foreach($s in $v.sources){Walk $s.id @()}
 $mids=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($m in $v.materials){$materialKeys=@('id','purpose','source_id','depends_on');if(-not $legacy){$materialKeys+=@('checker_source_id')};Keys $m $materialKeys '/materials';if($m.id -isnot [string] -or $m.id -cnotmatch '^[a-z][a-z0-9_-]{0,47}$' -or -not $mids.Add($m.id)){Fail 'MATERIAL_ID'};if($m.purpose -cnotin @('IMPLEMENTATION_RECORD','IMPLEMENTATION_RELEASE','RECORD_PREFLIGHT','CAPACITY_SUBJECT')){Fail 'PURPOSE_UNSUPPORTED' $m.purpose};if(-not $ids.Contains($m.source_id)){Fail 'SOURCE_UNKNOWN' $m.source_id};if(-not $legacy){Text $m.checker_source_id '/materials/checker_source_id';if(-not $ids.Contains($m.checker_source_id)){Fail 'CHECKER_SOURCE_UNKNOWN' $m.checker_source_id};$as=@($v.sources|Where-Object id -CEQ $m.source_id)[0];$bs=@($v.sources|Where-Object id -CEQ $m.checker_source_id)[0];if($m.source_id -ceq $m.checker_source_id -or [string]::Equals($as.ref.path,$bs.ref.path,[StringComparison]::OrdinalIgnoreCase)){Fail 'CHECKER_SOURCE_NOT_INDEPENDENT'}};Array $m.depends_on '/materials/depends_on';foreach($id in $m.depends_on){Text $id '/materials/depends_on';if(-not $ids.Contains($id)){Fail 'DEPENDENCY_UNKNOWN' $id}}}
 @{plan=$v;contract=$mc;checker_contract=$bc;legacy=$legacy;ref=@{path=$p;sha256=$sha}}
}
function Domain([string]$p,$contract){
 $test=Join-Path (Split-Path $contract.input_root) 'evidence\tmp'
 if(-not ($p.StartsWith($contract.input_root+'\',[StringComparison]::Ordinal) -or ($Fixture -and $p.StartsWith($test+'\',[StringComparison]::Ordinal)))){Fail 'PATH_DOMAIN' $p}
}
function SourcesFor($plan,$material){
 $set=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 function Add([string]$id){if($set.Add($id)){$s=@($plan.sources|Where-Object id -CEQ $id)[0];foreach($d in $s.depends_on){Add $d}}}
 Add $material.source_id;Add $material.checker_source_id;foreach($d in $material.depends_on){Add $d};@($set|Sort-Object -CaseSensitive)
}
function SourceDomain([string]$p,$contract,$plan){
 try{Domain $p $contract}catch{if($plan.format -cne 'xdev-preparation-package-plan-2'){throw};$bc=ReadJson $plan.checker_contract.path $plan.checker_contract.sha256;Domain $p $bc}
}
function VerifySources($plan,$contract){
 $errs=[Collections.Generic.List[object]]::new()
 $authority=@($plan.material_contract,$plan.manifest);if($plan.format -ceq 'xdev-preparation-package-plan-2'){$authority+=@($plan.checker_contract,$plan.checker_manifest)}
 foreach($a in $authority){try{$null=ReadJson $a.path $a.sha256}catch{$errs.Add((FailureInfo $_ $a.path))}}
 foreach($s in $plan.sources){SourceDomain $s.ref.path $contract $plan;try{$null=ReadJson $s.ref.path $s.ref.sha256}catch{$e=FailureInfo $_ $s.ref.path;$e.source_id=$s.id;$errs.Add($e)}}
 if($errs.Count){return ,$errs.ToArray()};return ,@()
}
function Checker($plan,$contract,$item){
 $m=@($plan.materials|Where-Object id -CEQ $item.id)[0];$s=@($plan.sources|Where-Object id -CEQ $m.checker_source_id)[0]
 & (Join-Path $PSScriptRoot 'Test-Material.ps1') -ApprovedContractPath $plan.checker_contract.path -ApprovedContractSha256 $plan.checker_contract.sha256 -SourcePath $s.ref.path -SourceSha256 $s.ref.sha256 -Purpose $m.purpose -ManifestPath $plan.checker_manifest.path -ManifestSha256 $plan.checker_manifest.sha256 -ActualPath $item.artifact.path -ActualSha256 $item.artifact.sha256 -Fixture:$Fixture
}
function ObservationErrors($state,$plan,$contract){
 $errors=[Collections.Generic.List[object]]::new()
 foreach($item in $state.items){if($item.state -cne 'CONSUMED'){continue}
  try{
   FileRef $item.observation '/item/observation';Domain $item.observation.path $contract
   $v=ReadJson $item.observation.path $item.observation.sha256
   Keys $v @('format','package_id','version','item_id','outcome','scope','detail') '/observation'
   if($v.format -cne 'xdev-preparation-external-observation-1' -or $v.package_id -cne $state.package_id -or $v.item_id -cne $item.id -or $v.outcome -cne $item.outcome -or -not (SameScope $v.scope $plan.scope)){Fail 'OBSERVATION_BINDING'}
   # Version was bound when Observe committed. A later allowed plan version
   # preserves this pinned historical observation, not a new execution claim.
  }catch{$e=FailureInfo $_ $item.observation.path;$e.item_id=$item.id;$e.classification='PREPARATION_BEFORE_START';$e.evidence_kind='CONSUMED_OBSERVATION';$errors.Add($e)}
 }
 return ,$errors.ToArray()
}
function NewState($loaded){@{format='xdev-preparation-package-state-1';package_id=$loaded.plan.package_id;version=$loaded.plan.version;plan=$loaded.ref;revision=1;previous=$null;state='DRAFT';items=@($loaded.plan.materials|ForEach-Object{@{id=$_.id;state='DRAFT';artifact=$null;lineage=$null;observation=$null;outcome=$null}});errors=@();delta=@();execution_allowed=$false}}
function DiagnosticEntries($state){if($state.format -ceq 'xdev-preparation-package-state-2'){return ,$state.diagnostics};return ,@()}
function LoadDiagnostic($entry,$state,$plan,$contract){
 Domain $entry.ref.path $contract;$roots=@($contract.input_root);if($Fixture){$roots+=@(Join-Path (Split-Path $contract.input_root) 'evidence\tmp')}
 Read-PreparationDiagnostic -Path $entry.ref.path -Sha256 $entry.ref.sha256 -AllowedRoots $roots -Scope $plan.scope -PackageId $state.package_id -Version $entry.observed_version -ItemId $entry.item_id -AttemptId $entry.attempt_id
}
function DiagnosticView($state,$plan,$contract){
 $events=@();$errors=@();$similar=@();$entries=DiagnosticEntries $state
 foreach($entry in $entries){try{$d=LoadDiagnostic $entry $state $plan $contract;$events+=@(Get-PreparationDiagnosticSummary -Diagnostic $d)}catch{$e=FailureInfo $_ $entry.ref.path;$e.evidence_kind='RUNTIME_DIAGNOSTIC';$e.attempt_id=$entry.attempt_id;$errors+=@($e)}}
 for($i=0;$i -lt $events.Count;$i++){for($j=0;$j -lt $i;$j++){if($events[$i].failure_code -and $events[$i].failure_code -ceq $events[$j].failure_code -and $events[$i].last_observed_phase -ceq $events[$j].last_observed_phase){$similar+=@{relation='SIMILAR_FAILURE_NOT_ROOT_CAUSE';attempts=@($events[$j].attempt.id,$events[$i].attempt.id);layouts=@($events[$j].attempt.layout,$events[$i].attempt.layout);same_event=$false;retry_allowed=$false}}}}
 @{status=if($errors.Count){'STALE_DIAGNOSTIC_REFUSED'}elseif($entries.Count){'PINNED_EXTERNAL_DIAGNOSTICS'}else{'NOT_PROVIDED'};events=$events;errors=$errors;similar_failures=$similar;retry_allowed=$false}
}
function Commit($state){
 $sp=Join-Path $root ('state-{0:D4}.json' -f $state.revision);$sr=Save $sp $state
 $temp=Join-Path $root ('head-{0:D4}.json' -f $state.revision);$null=Save $temp $sr
 [IO.File]::Move($temp,(Join-Path $root 'HEAD.json'),$true)
 $sr
}
try{
 if($Action -ceq 'Init'){
  $loaded=LoadPlan $PlanPath $PlanSha256;$root=$PackageDirectory;Canonical $root $true;Domain $root $loaded.contract
  if(Test-Path -LiteralPath $root){Fail 'PACKAGE_EXISTS_NO_REPLAY'}
  foreach($s in $loaded.plan.sources){SourceDomain $s.ref.path $loaded.contract $loaded.plan}
  [IO.Directory]::CreateDirectory($root)|Out-Null
  $lock=[IO.File]::Open((Join-Path $root '.writer.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $attempted=$true;$null=Save (Join-Path $root 'attempt-0001.json') @{action=$Action;approved_plan=$loaded.ref}
  $state=NewState $loaded;$result=Commit $state
 }else{
  Canonical $StatePath;$root=Split-Path $StatePath
  if([IO.Path]::GetFileName($StatePath) -cnotmatch '^state-\d{4}\.json$'){Fail 'STATE_NAME'}
  $state=ReadJson $StatePath $StateSha256
  $stateKeys=@('format','package_id','version','plan','revision','previous','state','items','errors','delta','execution_allowed');if($state.format -ceq 'xdev-preparation-package-state-2'){$stateKeys+=@('diagnostics')};Keys $state $stateKeys '/state'
  if($state.format -ceq 'xdev-preparation-package-state-2'){Array $state.diagnostics '/state/diagnostics';if($state.diagnostics.Count -gt 32){Fail 'DIAG_STATE_BOUND'};foreach($e in $state.diagnostics){Keys $e @('item_id','observed_version','attempt_id','layout','ref') '/state/diagnostics';foreach($n in @('item_id','observed_version','attempt_id','layout')){Text $e[$n] ('/diagnostics/'+$n)};FileRef $e.ref '/state/diagnostics/ref'}}
  if(($state.revision -isnot [long] -and $state.revision -isnot [int]) -or $state.revision -lt 1 -or $state.revision -gt 9999 -or $state.state -cnotin @('DRAFT','CHECKED','FROZEN','CONSUMED','STALE','REJECTED')){Fail 'STATE_TYPE'}
  Array $state.items '/state/items';Array $state.errors '/state/errors';FileRef $state.plan '/state/plan'
  foreach($it in $state.items){Keys $it @('id','state','artifact','lineage','observation','outcome') '/state/items';if($it.state -cnotin @('DRAFT','CHECKED','FROZEN','CONSUMED','STALE','REJECTED')){Fail 'ITEM_STATE'}}
  if($state.format -cnotin @('xdev-preparation-package-state-1','xdev-preparation-package-state-2') -or $state.execution_allowed -isnot [bool] -or $state.execution_allowed){Fail 'STATE_FORMAT'}
  $loaded=LoadPlan $state.plan.path $state.plan.sha256;Domain $root $loaded.contract
  if($Action -cnotin @('Context','Expand')){$lock=[IO.File]::Open((Join-Path $root '.writer.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
  $headPath=Join-Path $root 'HEAD.json';Canonical $headPath;$head=Get-Content -LiteralPath $headPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
  if($head.path -cne $StatePath -or $head.sha256 -cne $StateSha256){Fail 'STATE_CAS_CONFLICT'}
  if($loaded.legacy -and $Action -cnotin @('Context','Expand')){Fail 'LEGACY_PLAN_REBIND_REQUIRED'}
  $next=[int]$state.revision+1
  if($next -gt 9999){Fail 'STATE_REVISION_BOUND'}
  $pending=[IO.File]::Exists((Join-Path $root ('attempt-{0:D4}.json' -f $next))) -or [IO.File]::Exists((Join-Path $root ('state-{0:D4}.json' -f $next)))
  if($pending -and $Action -ceq 'Context'){
   $knownDiagnostics=DiagnosticView $state $loaded.plan $loaded.contract
   [pscustomobject]@{status='CURRENT_CONTEXT';scope=$loaded.plan.scope;required_constraints=$loaded.plan.required_constraints;package_state='UNKNOWN';items=$state.items;diagnostics=$knownDiagnostics;errors=@($state.errors)+@($knownDiagnostics.errors)+@(@{code='UNKNOWN_UNCOMMITTED_ATTEMPT'});original_refs=$loaded.plan.sources;compatibility=if($loaded.legacy){'LEGACY_PLAN_REBIND_REQUIRED'}else{'EXPLICIT_DUAL_SOURCE'};memory=$loaded.plan.memory;execution_allowed=$false;retry_allowed=$false;tokens='UNKNOWN'};exit
  }
  if($pending){Fail 'UNKNOWN_UNCOMMITTED_ATTEMPT'}
  if($Action -ceq 'Context'){
   $sourceErrors=VerifySources $loaded.plan $loaded.contract;$obsErrors=ObservationErrors $state $loaded.plan $loaded.contract;$sourceErrors=@($sourceErrors)+@($obsErrors);if($loaded.legacy){$sourceErrors+=@(@{code='LEGACY_PLAN_REBIND_REQUIRED';diagnostic='Independent checker bindings absent; read-only disclosure only'})}
   $diagnostics=DiagnosticView $state $loaded.plan $loaded.contract;$sourceErrors+=@($diagnostics.errors)
   [pscustomobject]@{status='CURRENT_CONTEXT';scope=$loaded.plan.scope;required_constraints=$loaded.plan.required_constraints;package_state=$state.state;version=$state.version;items=@($state.items|ForEach-Object{@{id=$_.id;state=$_.state;outcome=$_.outcome}});delta=$state.delta;errors=@($state.errors)+@($sourceErrors);diagnostics=$diagnostics;original_refs=$loaded.plan.sources;compatibility=if($loaded.legacy){'LEGACY_PLAN_REBIND_REQUIRED'}else{'EXPLICIT_DUAL_SOURCE'};state_ref=@{path=$StatePath;sha256=$StateSha256};memory=$loaded.plan.memory;applicability=if($sourceErrors.Count){'STALE_SOURCE_REFUSED'}else{'BYTES_CURRENT_NOT_AUTHORIZATION'};execution_allowed=$false;read_bytes=$readBytes;elapsed_ms=$timer.Elapsed.TotalMilliseconds;tokens='UNKNOWN'};exit
  }
  if($Action -ceq 'Expand'){
   if($DiagnosticAttemptId){$entries=DiagnosticEntries $state;$entry=@($entries|Where-Object attempt_id -CEQ $DiagnosticAttemptId);if($entry.Count -ne 1){Fail 'DIAG_ATTEMPT_UNKNOWN'};$d=LoadDiagnostic $entry[0] $state $loaded.plan $loaded.contract;[pscustomobject]@{status='EXPANDED_PINNED_DIAGNOSTIC';original=$d.Ref;text=$d.Text;execution_allowed=$false;retry_allowed=$false};exit}
   $selected=@($loaded.plan.sources|Where-Object id -CEQ $ItemId);if($selected.Count -ne 1){Fail 'SOURCE_UNKNOWN' $ItemId};SourceDomain $selected[0].ref.path $loaded.contract $loaded.plan
   $original=ReadJson $selected[0].ref.path $selected[0].ref.sha256 -WithRaw
   [pscustomobject]@{status='EXPANDED_PINNED_ORIGINAL';source=$selected[0];text=$original.text;compatibility=if($loaded.legacy){'LEGACY_PLAN_REBIND_REQUIRED'}else{'EXPLICIT_DUAL_SOURCE'};execution_allowed=$false};exit
  }
  if($state.state -ceq 'REJECTED' -and $Action -cne 'Correct'){Fail 'PACKAGE_REJECTED_NEEDS_CORRECTION'}
  if($state.state -ceq 'STALE' -and $Action -cne 'Correct'){Fail 'PACKAGE_STALE_NEEDS_CORRECTION'}
  $newLoaded=$null;$changed=@();$affected=@()
  if($Action -ceq 'Correct'){
   $diag=DiagnosticView $state $loaded.plan $loaded.contract;if($diag.errors.Count){Fail 'DIAG_STALE_NO_REPLAY'}
   $observationErrors=ObservationErrors $state $loaded.plan $loaded.contract
   if($observationErrors.Count){Fail 'CONSUMED_EVIDENCE_STALE_NO_REPLAY' $observationErrors[0].path}
   $newLoaded=LoadPlan $PlanPath $PlanSha256
   if($newLoaded.plan.package_id -cne $loaded.plan.package_id -or $newLoaded.plan.version -ceq $loaded.plan.version){Fail 'CORRECTION_VERSION'}
   if(-not (SameScope $newLoaded.plan.scope $loaded.plan.scope) -or -not (SameRef $newLoaded.plan.material_contract $loaded.plan.material_contract) -or -not (SameRef $newLoaded.plan.manifest $loaded.plan.manifest)){Fail 'CORRECTION_SCOPE_REBIND_REQUIRED'}
   if((ConvertTo-Json $newLoaded.plan.required_constraints -Compress) -cne (ConvertTo-Json $loaded.plan.required_constraints -Compress)){Fail 'CORRECTION_CONSTRAINT_REBIND_REQUIRED'}
   $bindingChanged=-not (SameRef $newLoaded.plan.checker_contract $loaded.plan.checker_contract) -or -not (SameRef $newLoaded.plan.checker_manifest $loaded.plan.checker_manifest)
   foreach($s in $loaded.plan.sources){if(@($newLoaded.plan.sources|Where-Object id -CEQ $s.id).Count -eq 0){$changed+=@($s.id)}}
   foreach($s in $newLoaded.plan.sources){$old=@($loaded.plan.sources|Where-Object id -CEQ $s.id);if($old.Count -ne 1 -or -not (SameRef $old[0].ref $s.ref) -or (ConvertTo-Json $old[0].depends_on -Compress) -cne (ConvertTo-Json $s.depends_on -Compress)){$changed+=@($s.id)}}
   foreach($m in $newLoaded.plan.materials){$old=@($loaded.plan.materials|Where-Object id -CEQ $m.id);$deps=SourcesFor $newLoaded.plan $m;if($bindingChanged -or $old.Count -ne 1 -or (ConvertTo-Json $old[0] -Compress) -cne (ConvertTo-Json $m -Compress) -or @($deps|Where-Object {$changed -ccontains $_}).Count){$affected+=@($m.id)}}
   foreach($item in $state.items){if($item.state -ceq 'CONSUMED' -and ($affected -ccontains $item.id -or @($newLoaded.plan.materials|Where-Object id -CEQ $item.id).Count -eq 0)){Fail 'CONSUMED_OR_UNKNOWN_NO_REPLAY' $item.id}}
  }
  if($Action -ceq 'Freeze' -and $state.state -cnotin @('CHECKED','FROZEN','CONSUMED')){Fail 'FREEZE_REQUIRES_CHECKED'}
  $obs=$null;$newDiagnostic=$null
  if(($DiagnosticPath -or $DiagnosticSha256) -and $Action -cne 'Observe'){Fail 'DIAG_OBSERVE_ONLY'}
  if($Action -ceq 'Observe'){
   $selected=@($state.items|Where-Object id -CEQ $ItemId);if($selected.Count -ne 1){Fail 'MATERIAL_UNKNOWN' $ItemId};$item=$selected[0]
   if($item.state -ceq 'CONSUMED'){Fail 'CONSUMED_OR_UNKNOWN_NO_REPLAY' $ItemId}
   if($item.state -cne 'FROZEN'){Fail 'OBSERVE_REQUIRES_FROZEN' $ItemId};if(-not $Outcome){Fail 'OUTCOME_REQUIRED'}
   # Cheap observation/diagnostic refusals precede unrelated dependency reads.
   Domain $ObservationPath $loaded.contract;$obs=ReadJson $ObservationPath $ObservationSha256
   Keys $obs @('format','package_id','version','item_id','outcome','scope','detail') '/observation'
   Keys $obs.scope @('project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256') '/observation/scope'
   if($obs.format -cne 'xdev-preparation-external-observation-1' -or $obs.package_id -cne $state.package_id -or $obs.version -cne $state.version -or $obs.item_id -cne $ItemId -or $obs.outcome -cne $Outcome -or -not (SameScope $obs.scope $loaded.plan.scope)){Fail 'OBSERVATION_BINDING'}
   if($DiagnosticPath -or $DiagnosticSha256 -or $DiagnosticAttemptId){
    if(-not $DiagnosticPath -or -not $DiagnosticSha256 -or -not $DiagnosticAttemptId){Fail 'DIAG_ARGUMENTS'}
    $entries=DiagnosticEntries $state;if($entries.Count -ge 32 -or @($entries|Where-Object attempt_id -CEQ $DiagnosticAttemptId).Count){Fail 'DIAG_ATTEMPT_ALREADY_RECORDED'}
    $descriptor=@{item_id=$ItemId;observed_version=$state.version;attempt_id=$DiagnosticAttemptId;layout='PENDING';ref=@{path=$DiagnosticPath;sha256=$DiagnosticSha256}}
    $d=LoadDiagnostic $descriptor $state $loaded.plan $loaded.contract;$descriptor.layout=$d.Data.attempt.layout
    $observedFailure=@($d.Data.layers.Values|Where-Object {$_.error.code -or ($null -ne $_.exit_code -and $_.exit_code -ne 0) -or $null -ne $_.signal -or $_.natural_exit -ceq $false -or $_.eof -ceq $false}).Count -gt 0
    if($Outcome -ceq 'SUCCESS' -and ($observedFailure -or $d.Data.ack.commit_state -cne 'COMMITTED' -or $d.Data.ack.save_acknowledged -cne $true -or $d.Data.ack.readback_acknowledged -cne $true)){Fail 'DIAG_SUCCESS_CONFLICT'}
    $newDiagnostic=$descriptor
   }
   # Every accepted Observe still performs all source/checker guards. No cache
   # survives this action, and final reads precede even the attempt marker.
   $se=VerifySources $loaded.plan $loaded.contract;if($se.Count){Fail 'SOURCE_STALE_BEFORE_OBSERVE'}
   $null=Checker $loaded.plan $loaded.contract $item
   $finalSources=VerifySources $loaded.plan $loaded.contract;if($finalSources.Count){Fail 'SOURCE_STALE_BEFORE_OBSERVE'}
   $null=ReadJson $ObservationPath $ObservationSha256
   if($newDiagnostic){$null=LoadDiagnostic $newDiagnostic $state $loaded.plan $loaded.contract}
  }
  if($Action -ceq 'Correct'){
   $newSources=VerifySources $newLoaded.plan $newLoaded.contract;if($newSources.Count){Fail 'SOURCE_STALE_BEFORE_CORRECT'}
   foreach($preserved in $state.items){if($preserved.state -cin @('CHECKED','FROZEN','CONSUMED') -and $affected -cnotcontains $preserved.id){$null=Checker $newLoaded.plan $newLoaded.contract $preserved}}
   $newSources=VerifySources $newLoaded.plan $newLoaded.contract;if($newSources.Count){Fail 'SOURCE_STALE_BEFORE_CORRECT'}
  }
  $attempted=$true;$null=Save (Join-Path $root ('attempt-{0:D4}.json' -f $next)) @{action=$Action;previous=@{path=$StatePath;sha256=$StateSha256};plan=if($newLoaded){$newLoaded.ref}else{$loaded.ref}}
  $state.previous=@{path=$StatePath;sha256=$StateSha256};$state.revision=$next
  switch -CaseSensitive ($Action){
   'Correct'{
    $newItems=@();foreach($m in $newLoaded.plan.materials){$old=@($state.items|Where-Object id -CEQ $m.id);if($affected -ccontains $m.id){$newItems+=@(@{id=$m.id;state='DRAFT';artifact=$null;lineage=$null;observation=$null;outcome=$null})}else{$newItems+=@($old[0])}}
    $state.items=$newItems;$state.plan=$newLoaded.ref;$state.version=$newLoaded.plan.version;$state.delta=@{changed_sources=$changed;affected_materials=$affected;preserved_materials=@($state.items|Where-Object state -CNE 'DRAFT'|ForEach-Object id)};$state.state='DRAFT';$consumedIds=@($state.items|Where-Object state -CEQ 'CONSUMED'|ForEach-Object id);$state.errors=@($state.errors|Where-Object {$_.Contains('item_id') -and $consumedIds -ccontains $_.item_id})
   }
   'Check'{
    $sourceErrors=VerifySources $loaded.plan $loaded.contract;$obsErrors=ObservationErrors $state $loaded.plan $loaded.contract;$sourceErrors=@($sourceErrors)+@($obsErrors)
    $diag=DiagnosticView $state $loaded.plan $loaded.contract;$sourceErrors+=@($diag.errors)
    if($sourceErrors.Count){$state.state='STALE';$state.errors=$sourceErrors}else{
     $staleEvidence=$false
     foreach($item in $state.items){
      if($item.state -ceq 'CONSUMED'){try{$null=Checker $loaded.plan $loaded.contract $item}catch{$staleEvidence=$true;$e=FailureInfo $_ $item.artifact.path;$e.item_id=$item.id;$e.classification='PREPARATION_BEFORE_START';$state.errors+=@($e)};continue}
      if($item.state -cin @('CHECKED','FROZEN')){try{$null=Checker $loaded.plan $loaded.contract $item}catch{$item.state='STALE';$e=FailureInfo $_ $item.artifact.path;$e.item_id=$item.id;$e.classification='PREPARATION_BEFORE_START';$state.errors+=@($e)};continue}
      $m=@($loaded.plan.materials|Where-Object id -CEQ $item.id)[0];$s=@($loaded.plan.sources|Where-Object id -CEQ $m.source_id)[0];$dir=Join-Path $root ('material-'+$item.id+'-'+$next);[IO.Directory]::CreateDirectory($dir)|Out-Null
      $bs=@($loaded.plan.sources|Where-Object id -CEQ $m.checker_source_id)[0]
      $r=& (Join-Path $PSScriptRoot 'Invoke-MaterialPreparation.ps1') -ApprovedContractPath $loaded.plan.material_contract.path -ApprovedContractSha256 $loaded.plan.material_contract.sha256 -SourcePath $s.ref.path -SourceSha256 $s.ref.sha256 -Purpose $m.purpose -ManifestPath $loaded.plan.manifest.path -CheckerSourcePath $bs.ref.path -CheckerSourceSha256 $bs.ref.sha256 -CheckerApprovedContractPath $loaded.plan.checker_contract.path -CheckerApprovedContractSha256 $loaded.plan.checker_contract.sha256 -CheckerManifestPath $loaded.plan.checker_manifest.path -CheckerManifestSha256 $loaded.plan.checker_manifest.sha256 -OutputDirectory $dir -Fixture:$Fixture
      if($r.status -ceq 'CHECKED_NOT_EXECUTED'){$item.state='CHECKED';$item.artifact=@{path=$r.material.path;sha256=$r.material.sha256};$item.lineage=Ref $r.material.lineage_path}else{$item.state='REJECTED';$state.errors+=@(@{item_id=$item.id;classification='PREPARATION_BEFORE_START';errors=$r.errors})}
     }
     $state.state=if(@($state.items|Where-Object state -CEQ 'REJECTED').Count){'REJECTED'}elseif($staleEvidence -or @($state.items|Where-Object state -CEQ 'STALE').Count){'STALE'}elseif(@($state.items|Where-Object state -CEQ 'CONSUMED').Count -eq $state.items.Count){'CONSUMED'}else{'CHECKED'}
    }
   }
   'Freeze'{
    $se=VerifySources $loaded.plan $loaded.contract;$oe=ObservationErrors $state $loaded.plan $loaded.contract;$se=@($se)+@($oe)
    $diag=DiagnosticView $state $loaded.plan $loaded.contract;$se+=@($diag.errors)
    if($se.Count){$state.state='STALE';$state.errors=$se}else{$freezeFailures=0;foreach($item in $state.items){try{$null=Checker $loaded.plan $loaded.contract $item;if($item.state -cne 'CONSUMED'){$item.state='FROZEN'}}catch{$freezeFailures++;if($item.state -cne 'CONSUMED'){$item.state='STALE'};$e=FailureInfo $_ $item.artifact.path;$e.item_id=$item.id;$e.classification='PREPARATION_BEFORE_START';$state.errors+=@($e)}};$state.state=if($freezeFailures){'STALE'}elseif(@($state.items|Where-Object state -CEQ 'CONSUMED').Count -eq $state.items.Count){'CONSUMED'}else{'FROZEN'}}
   }
   'Observe'{
    if($newDiagnostic){$entries=DiagnosticEntries $state;$state.format='xdev-preparation-package-state-2';$state.diagnostics=@($entries)+@($newDiagnostic)}
    $item.state='CONSUMED';$item.outcome=$Outcome;$item.observation=@{path=$ObservationPath;sha256=$ObservationSha256};$state.state='CONSUMED'
    if($Outcome -cne 'SUCCESS'){$state.errors+=@(@{item_id=$ItemId;classification=$Outcome;code='EXTERNAL_OBSERVATION_NOT_REPLAYABLE'})}
   }
  }
  if($Action -cin @('Check','Freeze') -and $state.state -cnotin @('STALE','REJECTED')){
   $last=VerifySources $loaded.plan $loaded.contract;$lastObs=ObservationErrors $state $loaded.plan $loaded.contract;$last=@($last)+@($lastObs)
   $last+=@((DiagnosticView $state $loaded.plan $loaded.contract).errors)
   if($last.Count){$state.state='STALE';$state.errors+=@($last)}
  }
  $result=Commit $state
 }
 [pscustomobject]@{status=$state.state;state_ref=$result;revision=$state.revision;errors=$state.errors;delta=$state.delta;execution_allowed=$false;elapsed_ms=$timer.Elapsed.TotalMilliseconds;read_bytes=$readBytes;read_count=$readCount;tokens='UNKNOWN'}
}catch{
 $errorInfo=FailureInfo $_;$code=$errorInfo.code
 $classification=if($attempted){'UNKNOWN'}elseif($code -like 'UNKNOWN*'){'UNKNOWN'}else{'PREPARATION_BEFORE_START'}
 [pscustomobject]@{status='REJECTED';classification=$classification;errors=@($errorInfo);execution_allowed=$false;retry_allowed=$false;elapsed_ms=$timer.Elapsed.TotalMilliseconds;read_bytes=$readBytes;tokens='UNKNOWN'}
}finally{if($lock){$lock.Dispose()}}
