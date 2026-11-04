#requires -Version 7.5
<# Independent raw-JSON checker. It never imports the generator, converts JSON
through PSObject, reconstructs expected data with a generator mapping, or uses
the generated lineage as authority. Both FileRefs come from the current card.
This is a material check only; CHECKED does not start or approve an action. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$SourceSha256,
    [Parameter(Mandatory)][ValidateSet('IMPLEMENTATION_RECORD','RECORD_PREFLIGHT','IMPLEMENTATION_RELEASE','CAPACITY_SUBJECT','FORMAL_QA_SUBJECT')][string]$Purpose,
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$ManifestSha256,
    [Parameter(Mandatory)][string]$ActualPath,
    [Parameter(Mandatory)][string]$ActualSha256,
    [Parameter(Mandatory)][string]$ApprovedContractPath,
    [Parameter(Mandatory)][string]$ApprovedContractSha256,
    [switch]$Fixture
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'PreparationJson.psm1') -ErrorAction Stop
# Contract pin is supplied by the coordinator, never inferred from measured bytes.
if(-not [IO.Path]::IsPathFullyQualified($ApprovedContractPath) -or [IO.Path]::GetFullPath($ApprovedContractPath) -cne $ApprovedContractPath){throw 'CONTRACT_PATH'}
for($q=$ApprovedContractPath;$q;){$ci=Get-Item -LiteralPath $q -Force;if($ci.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'CONTRACT_LINK'};$q=[IO.Path]::GetDirectoryName($q)}
if((Get-Item -LiteralPath $ApprovedContractPath).Length -gt 65536){throw 'CONTRACT_SIZE'}
$contractBytes=[IO.File]::ReadAllBytes($ApprovedContractPath)
if($contractBytes.Length -gt 65536 -or $ApprovedContractSha256 -cnotmatch '^[a-f0-9]{64}$' -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($contractBytes)).ToLowerInvariant() -cne $ApprovedContractSha256){throw 'CONTRACT_PIN'}
$cd=[Text.Json.JsonDocument]::Parse([Text.UTF8Encoding]::new($false,$true).GetString($contractBytes))
$cv=$cd.RootElement
function ContractUnique([Text.Json.JsonElement]$v){if($v.ValueKind -eq 'Object'){$set=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($p in $v.EnumerateObject()){if(-not $set.Add($p.Name)){throw 'CONTRACT_DUPLICATE_KEY'};ContractUnique $p.Value}}elseif($v.ValueKind -eq 'Array'){foreach($x in $v.EnumerateArray()){ContractUnique $x}}}
ContractUnique $cv
$contractNames=@('format','input_root','project_root','project_id','job_id','task_id','spec_sha256','author','not_before','expires_at','request_sha256','start_sha256','manifest_sha256','source_count','server_path','server_sha256','node_path','node_sha256','node_version','config_sha256')
if($cv.ValueKind -ne 'Object' -or @($cv.EnumerateObject()).Count -ne $contractNames.Count){throw 'CONTRACT_KEYS'}
foreach($n in $contractNames){$v=$cv.GetProperty($n);if($n -ceq 'source_count'){if($v.ValueKind -ne 'Number' -or $v.GetInt32() -lt 1 -or $v.GetInt32() -gt 10000){throw 'CONTRACT_COUNT'}}elseif($v.ValueKind -ne 'String' -or -not $v.GetString()){throw ('CONTRACT_STRING:'+ $n)}}
if($cv.GetProperty('format').GetString() -cne 'xdev-material-approved-contract-1'){throw 'CONTRACT_FORMAT'}
foreach($n in $contractNames.Where({$_.EndsWith('_sha256')})){if($cv.GetProperty($n).GetString() -cnotmatch '^[a-f0-9]{64}$'){throw ('CONTRACT_HASH:'+ $n)}}
foreach($n in @('input_root','project_root','server_path','node_path')){$v=$cv.GetProperty($n).GetString();if(-not [IO.Path]::IsPathFullyQualified($v) -or [IO.Path]::GetFullPath($v) -cne $v){throw ('CONTRACT_PATH:'+ $n)}}
for($q=$ApprovedContractPath;$q;){$item=Get-Item -LiteralPath $q -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'CONTRACT_LINK'};$q=[IO.Path]::GetDirectoryName($q)}
foreach($n in @('not_before','expires_at')){$v=$cv.GetProperty($n).GetString();$date=[DateTimeOffset]::MinValue;if($v -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or -not [DateTimeOffset]::TryParseExact($v,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$date)){throw ('CONTRACT_DATE:'+ $n)}}
$approvedBegin=$cv.GetProperty('not_before').GetString();$approvedEnd=$cv.GetProperty('expires_at').GetString()
if([DateTimeOffset]::Parse($approvedBegin) -ge [DateTimeOffset]::Parse($approvedEnd)){throw 'CONTRACT_WINDOW'}
if($ManifestSha256 -cne $cv.GetProperty('manifest_sha256').GetString()){throw 'CONTRACT_MANIFEST'}
$approvedCount=$cv.GetProperty('source_count').GetInt32()
$approvedRequestHash=$cv.GetProperty('request_sha256').GetString();$approvedStartHash=$cv.GetProperty('start_sha256').GetString()
$approvedServer=$cv.GetProperty('server_path').GetString();$approvedServerHash=$cv.GetProperty('server_sha256').GetString()
$approvedNode=$cv.GetProperty('node_path').GetString();$approvedNodeHash=$cv.GetProperty('node_sha256').GetString();$approvedNodeVersion=$cv.GetProperty('node_version').GetString();$approvedConfigHash=$cv.GetProperty('config_sha256').GetString()
$currentInput=$cv.GetProperty('input_root').GetString()
$currentPhase=[IO.Path]::GetDirectoryName($currentInput)
$testData=Join-Path $currentPhase 'evidence\tmp'
$currentProject=$cv.GetProperty('project_root').GetString()
$currentId=$cv.GetProperty('project_id').GetString()
$currentJob=$cv.GetProperty('job_id').GetString()
$currentTask=$cv.GetProperty('task_id').GetString()
$currentSpec=$cv.GetProperty('spec_sha256').GetString()
$currentAuthor=$cv.GetProperty('author').GetString()
$opened=[Collections.Generic.List[IDisposable]]::new()
$observed=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
function Check([bool]$condition,[string]$code){if(-not $condition){throw $code}}
function RawHash([byte[]]$raw){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()}
function CheckedPath([string]$p){
    Check ([IO.Path]::IsPathFullyQualified($p) -and [IO.Path]::GetFullPath($p) -ceq $p) 'CHECK_CANONICAL_PATH'
    Check ($p.StartsWith($currentInput+'\',[StringComparison]::Ordinal) -or ($Fixture -and $p.StartsWith($testData+'\',[StringComparison]::Ordinal)) -or $p -ceq (Join-Path $currentPhase 'carriers\run-capacity.mjs')) 'CHECK_DOMAIN'
    for($q=$p;$q;){$f=Get-Item -LiteralPath $q -Force;Check (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and -not $f.LinkType) 'CHECK_LINK';$q=[IO.Path]::GetDirectoryName($q)}
}
function CheckUnique([Text.Json.JsonElement]$v){
    switch($v.ValueKind.ToString()){
        'Object'{$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($field in $v.EnumerateObject()){Check ($names.Add($field.Name)) 'CHECK_DUPLICATE_KEY';CheckUnique $field.Value}}
        'Array'{foreach($element in $v.EnumerateArray()){CheckUnique $element}}
    }
}
function LoadOriginal([string]$p,[string]$expectedHash){
    CheckedPath $p;Check ($expectedHash -cmatch '^[0-9a-f]{64}$') 'CHECK_HASH_SHAPE'
    $roots=@($currentInput,(Join-Path $currentPhase 'carriers'));if($Fixture){$roots+=@($testData)}
    $snapshot=Read-PreparationJson -Path $p -Sha256 $expectedHash -AllowedRoots $roots
    $doc=$snapshot.Document;$opened.Add($doc)
    if($observed.ContainsKey($p)){Check ($observed[$p] -ceq $expectedHash) 'CHECK_CONFLICTING_REF'}else{$observed.Add($p,$expectedHash)}
    [pscustomobject]@{doc=$doc}
}
function TextIs([Text.Json.JsonElement]$v,[string]$expected){Check ($v.ValueKind -eq 'String' -and $v.GetString() -ceq $expected) 'CHECK_CONTEXT'}
function ObjectKeys([Text.Json.JsonElement]$v,[string[]]$expected){
    Check ($v.ValueKind -eq 'Object') 'CHECK_OBJECT_KIND'
    $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($p in $v.EnumerateObject()){Check ($names.Add($p.Name)) 'CHECK_DUPLICATE_KEY'}
    Check ($names.Count -eq $expected.Count) 'CHECK_KEY_SET';foreach($n in $expected){Check ($names.Contains($n)) 'CHECK_KEY_SET'}
}
function CompareOriginal([Text.Json.JsonElement]$expected,[Text.Json.JsonElement]$actual,[string]$pointer){
    Check ($expected.ValueKind -eq $actual.ValueKind) ('CHECK_JSON_KIND:'+ $pointer)
    switch($expected.ValueKind.ToString()){
        'Object'{
            $names=@($expected.EnumerateObject()|ForEach-Object{$_.Name});ObjectKeys $actual $names
            foreach($field in $expected.EnumerateObject()){$escaped=$field.Name.Replace('~','~0').Replace('/','~1');CompareOriginal $field.Value $actual.GetProperty($field.Name) ($pointer+'/'+$escaped)}
        }
        'Array'{Check ($expected.GetArrayLength() -eq $actual.GetArrayLength()) ('CHECK_ARRAY_COUNT:'+ $pointer);for($i=0;$i -lt $expected.GetArrayLength();$i++){CompareOriginal $expected[$i] $actual[$i] ($pointer+'/'+$i)}}
        'String'{Check ([string]::Equals($expected.GetString(),$actual.GetString(),[StringComparison]::Ordinal)) ('CHECK_STRING_VALUE:'+ $pointer)}
        'Number'{Check ($expected.GetRawText() -ceq $actual.GetRawText()) ('CHECK_NUMBER_TEXT:'+ $pointer)}
        'True'{}
        'False'{}
        'Null'{}
        default{throw ('CHECK_UNSUPPORTED_KIND:'+ $pointer)}
    }
}
function VisitReferences([Text.Json.JsonElement]$v,[int]$depth=0){
    Check ($depth -lt 33 -and $observed.Count -lt 128) 'CHECK_GRAPH_BOUND'
    if($v.ValueKind -eq 'Object'){
        $names=@($v.EnumerateObject()|ForEach-Object{$_.Name})
        if($names -ccontains 'id' -and $names -ccontains 'sha256'){throw 'CHECK_UNSUPPORTED_CORE_EVIDENCE_ID'}
        if($names -ccontains 'path' -or $names -ccontains 'sha256'){
            Check ($names.Count -eq 2 -and $names -ccontains 'path' -and $names -ccontains 'sha256') 'CHECK_UNSUPPORTED_CARRIER_OR_RAW_REFERENCE'
            ObjectKeys $v @('path','sha256');Check ($v.GetProperty('path').ValueKind -eq 'String' -and $v.GetProperty('sha256').ValueKind -eq 'String') 'CHECK_REF_KIND'
            $p=$v.GetProperty('path').GetString();$h=$v.GetProperty('sha256').GetString()
            if($observed.ContainsKey($p)){Check ($observed[$p] -ceq $h) 'CHECK_CONFLICTING_REF'}else{$child=LoadOriginal $p $h;VisitReferences $child.doc.RootElement ($depth+1)}
        }else{
            foreach($field in $v.EnumerateObject()){
                # Structured old identities are forbidden even in pinned leaves.
                switch -CaseSensitive ($field.Name){'job_id'{TextIs $field.Value $currentJob};'task_id'{TextIs $field.Value $currentTask};'spec_sha256'{TextIs $field.Value $currentSpec};'manifest_sha256'{TextIs $field.Value $ManifestSha256};'project_id'{TextIs $field.Value $currentId};'project_root'{TextIs $field.Value $currentProject}}
                VisitReferences $field.Value ($depth+1)
            }
        }
    }elseif($v.ValueKind -eq 'Array'){foreach($child in $v.EnumerateArray()){VisitReferences $child ($depth+1)}}
}
function ComparePublicImplementation([Text.Json.JsonElement]$material){
    $session=$material.GetProperty('session');$finalRef=$session.GetProperty('natural_final');$completeRef=$session.GetProperty('completion_observation')
    ObjectKeys $finalRef @('path','sha256');ObjectKeys $completeRef @('path','sha256')
    $public=LoadOriginal $finalRef.GetProperty('path').GetString() $finalRef.GetProperty('sha256').GetString();$e=$public.doc.RootElement
    ObjectKeys $e @('message_type','sender','payload','truncated');TextIs $e.GetProperty('message_type') 'FINAL_ANSWER';TextIs $e.GetProperty('sender') $currentAuthor;Check ($e.GetProperty('truncated').ValueKind -eq 'False' -and $e.GetProperty('payload').ValueKind -eq 'String') 'CHECK_PUBLIC_FINAL_ENVELOPE'
    # Independently parse exactly the documented public JSON payload. No scan
    # or execution of arbitrary message text, and no generator projection.
    $text=$e.GetProperty('payload').GetString();$payload=[Text.Json.JsonDocument]::Parse($text);$opened.Add($payload);CheckUnique $payload.RootElement;$p=$payload.RootElement
    # Only the current status-bearing public session2 payload is supported.
    # A decision/result legacy payload requires a separately specified version.
    ObjectKeys $p @('session_ref','role','job_id','task_id','spec_sha256','manifest_sha256','status','changed_files','summary','runtime_commands','tests','limitations')
    TextIs $p.GetProperty('role') 'implementation';TextIs $p.GetProperty('session_ref') $currentAuthor
    TextIs $p.GetProperty('job_id') $currentJob;TextIs $p.GetProperty('task_id') $currentTask;TextIs $p.GetProperty('spec_sha256') $currentSpec;TextIs $p.GetProperty('manifest_sha256') $ManifestSha256
    TextIs $p.GetProperty('status') 'IMPLEMENTED'
    foreach($key in @('changed_files','limitations')){$values=$p.GetProperty($key);Check ($values.ValueKind -eq 'Array' -and $values.GetArrayLength() -le 10000) 'CHECK_FINAL_ARRAY';foreach($value in $values.EnumerateArray()){Check ($value.ValueKind -eq 'String') 'CHECK_FINAL_ARRAY_STRING'}}
    Check ($p.GetProperty('summary').ValueKind -eq 'String' -and $p.GetProperty('tests').ValueKind -eq 'String') 'CHECK_FINAL_TEXT';$count=$p.GetProperty('runtime_commands');Check ($count.ValueKind -eq 'Number' -and $count.GetInt32() -ge 0) 'CHECK_FINAL_COMMANDS'
    $observation=LoadOriginal $completeRef.GetProperty('path').GetString() $completeRef.GetProperty('sha256').GetString();$array=$observation.doc.RootElement.GetProperty('agents')
    Check ($array.ValueKind -eq 'Array' -and $array.GetArrayLength() -ge 1 -and $array.GetArrayLength() -le 128) 'CHECK_COMPLETION_ARRAY'
    $targetCount=0;$one=[Text.Json.JsonElement]::new()
    foreach($entry in $array.EnumerateArray()){ObjectKeys $entry @('agent_name','agent_status');Check ($entry.GetProperty('agent_name').ValueKind -eq 'String') 'CHECK_AGENT_NAME';if([string]::Equals($entry.GetProperty('agent_name').GetString(),$currentAuthor,[StringComparison]::Ordinal)){$targetCount++;$one=$entry}}
    Check ($targetCount -eq 1) 'CHECK_UNIQUE_COMPLETION_TARGET'
    $state=$one.GetProperty('agent_status');ObjectKeys $state @('completed');Check ($state.GetProperty('completed').ValueKind -eq 'String' -and [string]::Equals($state.GetProperty('completed').GetString(),$text,[StringComparison]::Ordinal)) 'CHECK_COMPLETION_MISMATCH'
}
function CheckImplementationRelease([Text.Json.JsonElement]$v){
    ObjectKeys $v @('job_id','task_name','message');TextIs $v.GetProperty('job_id') $currentJob;TextIs $v.GetProperty('task_name') $currentAuthor
    Check ($v.GetProperty('message').ValueKind -eq 'String' -and $v.GetProperty('message').GetString().Length -gt 0) 'CHECK_RELEASE_MESSAGE'
}
function CheckImplementationRecord([Text.Json.JsonElement]$v){
    ObjectKeys $v @('format','job_id','role','session','manifest_sha256','writer_status','job_release');TextIs $v.GetProperty('format') 'xdev-supervised-record-1';TextIs $v.GetProperty('job_id') $currentJob;TextIs $v.GetProperty('role') 'implementation';TextIs $v.GetProperty('manifest_sha256') $ManifestSha256
    $s=$v.GetProperty('session');ObjectKeys $s @('format','role','session_ref','source_claim','native_authenticated','dispatch_request','dispatch_return','natural_final','natural_end','stop_requested','completion_observation');TextIs $s.GetProperty('format') 'xdev-supervised-public-session-2';TextIs $s.GetProperty('role') 'implementation';TextIs $s.GetProperty('source_claim') 'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS';TextIs $s.GetProperty('session_ref') $currentAuthor
    Check ($s.GetProperty('native_authenticated').ValueKind -eq 'False' -and $s.GetProperty('natural_end').ValueKind -eq 'True' -and $s.GetProperty('stop_requested').ValueKind -eq 'False') 'CHECK_SESSION_FLAGS'
    ComparePublicImplementation $v
    $ref=$v.GetProperty('writer_status');ObjectKeys $ref @('path','sha256');$writer=LoadOriginal $ref.GetProperty('path').GetString() $ref.GetProperty('sha256').GetString();$w=$writer.doc.RootElement
    ObjectKeys $w @('format','job_id','manifest_sha256','scope','unknown_writers','writers','observation');TextIs $w.GetProperty('format') 'xdev-dot-public-writers-1';TextIs $w.GetProperty('scope') 'PUBLIC_HOST_ONLY';TextIs $w.GetProperty('job_id') $currentJob;TextIs $w.GetProperty('manifest_sha256') $ManifestSha256
    Check ($w.GetProperty('unknown_writers').ValueKind -eq 'False' -and $w.GetProperty('writers').ValueKind -eq 'Array' -and $w.GetProperty('writers').GetArrayLength() -eq 1) 'CHECK_WRITERS';TextIs $w.GetProperty('writers')[0] $currentAuthor
    $wo=$w.GetProperty('observation');$co=$s.GetProperty('completion_observation');ObjectKeys $wo @('path','sha256');TextIs $wo.GetProperty('path') $co.GetProperty('path').GetString();TextIs $wo.GetProperty('sha256') $co.GetProperty('sha256').GetString()
    $rr=$v.GetProperty('job_release');ObjectKeys $rr @('path','sha256');$release=LoadOriginal $rr.GetProperty('path').GetString() $rr.GetProperty('sha256').GetString();CheckImplementationRelease $release.doc.RootElement
}
function CheckCapacityInputs([Text.Json.JsonElement]$subject){
    $bindingPath=$subject.GetProperty('execution_bindings_path');$bindingHash=$subject.GetProperty('execution_bindings_sha256')
    Check ($bindingPath.ValueKind -eq 'String' -and $bindingHash.ValueKind -eq 'String') 'CHECK_BINDING_REF_KIND'
    $fixed=LoadOriginal $bindingPath.GetString() $bindingHash.GetString();$f=$fixed.doc.RootElement
    TextIs $f.GetProperty('format') 'xdev-opt-execution-bindings-1';TextIs $f.GetProperty('project_id') $currentId;TextIs $f.GetProperty('project_root') $currentProject
    TextIs $f.GetProperty('job_id') $currentJob;TextIs $f.GetProperty('task_id') $currentTask;TextIs $f.GetProperty('spec_sha256') $currentSpec;TextIs $f.GetProperty('manifest_sha256') $ManifestSha256
    Check ($f.GetProperty('source_count').ValueKind -eq 'Number' -and $f.GetProperty('source_count').GetInt32() -eq $approvedCount) 'CHECK_FULL361'
    TextIs $f.GetProperty('source_manifest').GetProperty('path') $ManifestPath;TextIs $f.GetProperty('source_manifest').GetProperty('sha256') $ManifestSha256
    TextIs $f.GetProperty('implementation_session') $currentAuthor;TextIs $f.GetProperty('capacity_session') $subject.GetProperty('session_ref').GetString()
    $path=$subject.GetProperty('carrier_path').GetString();$hash=$subject.GetProperty('carrier_sha256').GetString()
    TextIs $f.GetProperty('capacity_carrier').GetProperty('path') $path;TextIs $f.GetProperty('capacity_carrier').GetProperty('sha256') $hash
    CheckedPath $path;$info=Get-Item -LiteralPath $path -Force;Check (-not $info.PSIsContainer -and $info.Length -le 2097152) 'CHECK_CARRIER_LEAF'
    Check ((RawHash ([IO.File]::ReadAllBytes($path))) -ceq $hash) 'CHECK_PIN_DRIFT';if($observed.ContainsKey($path)){Check ($observed[$path] -ceq $hash) 'CHECK_CONFLICTING_REF'}else{$observed.Add($path,$hash)}
    $ar=$subject.GetProperty('role_admission');$admission=LoadOriginal $ar.GetProperty('path').GetString() $ar.GetProperty('sha256').GetString();$v=$admission.doc.RootElement
    TextIs $v.GetProperty('format') 'xdev-opt-role-admission-1';TextIs $v.GetProperty('status') 'ADMITTED';TextIs $v.GetProperty('session_ref') $subject.GetProperty('session_ref').GetString();TextIs $v.GetProperty('job_id') $currentJob;TextIs $v.GetProperty('manifest_sha256') $ManifestSha256;TextIs $v.GetProperty('scope') 'CAPACITY_ONLY';Check ($v.GetProperty('native_authenticated').ValueKind -eq 'False') 'CHECK_ADMISSION_FLAGS'
    $qr=$subject.GetProperty('capacity_request');$req=LoadOriginal $qr.GetProperty('path').GetString() $qr.GetProperty('sha256').GetString();$q=$req.doc.RootElement
    TextIs $q.GetProperty('format') 'xdev-opt-capacity-request-1';TextIs $q.GetProperty('job_id') $currentJob;TextIs $q.GetProperty('task_id') $currentTask;TextIs $q.GetProperty('spec_sha256') $currentSpec;TextIs $q.GetProperty('manifest_sha256') $ManifestSha256;TextIs $q.GetProperty('session_ref') $subject.GetProperty('session_ref').GetString()
    TextIs $q.GetProperty('execution_bindings_path') $bindingPath.GetString();TextIs $q.GetProperty('execution_bindings_sha256') $bindingHash.GetString()
}
try{
    # Capacity RESULT rows/raw child streams/Core evidence IDs have a different
    # bounded schema and domain from Core input FileRefs. No support is claimed
    # for that extra subject purpose; it is an explicit refusal, never CHECKED.
    Check ($Purpose -cne 'FORMAL_QA_SUBJECT') 'CHECK_UNSUPPORTED_FORMAL_QA_CARRIER_EVIDENCE'
    Check ([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($approvedBegin) -and [DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse($approvedEnd)) 'CHECK_WINDOW'
    $r=LoadOriginal (Join-Path $currentInput 'REQUEST.json') $approvedRequestHash;TextIs $r.doc.RootElement.GetProperty('spec').GetProperty('sha256') $currentSpec
    $a=LoadOriginal (Join-Path $currentInput 'ENTRY-ACTUAL-START.json') $approvedStartHash;TextIs $a.doc.RootElement.GetProperty('job_id') $currentJob;TextIs $a.doc.RootElement.GetProperty('task_id') $currentTask
    Check ($ManifestSha256 -ceq $cv.GetProperty('manifest_sha256').GetString()) 'CHECK_OLD_MANIFEST'
    $manifest=LoadOriginal $ManifestPath $ManifestSha256;Check ($manifest.doc.RootElement.ValueKind -eq 'Array' -and $manifest.doc.RootElement.GetArrayLength() -eq $approvedCount) 'CHECK_FULL361'
    $original=LoadOriginal $SourcePath $SourceSha256;$source=$original.doc.RootElement
    ObjectKeys $source @('format','purpose','project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256','not_before','expires_at','writers','strict_record_keys','material')
    TextIs $source.GetProperty('format') 'xdev-acceptance-material-source-1';TextIs $source.GetProperty('purpose') $Purpose;TextIs $source.GetProperty('project_id') $currentId;TextIs $source.GetProperty('project_root') $currentProject
    TextIs $source.GetProperty('job_id') $currentJob;TextIs $source.GetProperty('task_id') $currentTask;TextIs $source.GetProperty('spec_sha256') $currentSpec;TextIs $source.GetProperty('manifest_sha256') $ManifestSha256
    TextIs $source.GetProperty('not_before') $approvedBegin;TextIs $source.GetProperty('expires_at') $approvedEnd
    $writers=$source.GetProperty('writers');Check ($writers.ValueKind -eq 'Array' -and $writers.GetArrayLength() -eq 1) 'CHECK_WRITERS';TextIs $writers[0] $currentAuthor
    $keys=@('format','job_id','role','session','manifest_sha256','writer_status','job_release');$strict=$source.GetProperty('strict_record_keys');Check ($strict.ValueKind -eq 'Array' -and $strict.GetArrayLength() -eq 7) 'CHECK_STRICT_KEYS'
    for($i=0;$i -lt 7;$i++){TextIs $strict[$i] $keys[$i]}
    # Expected is the raw original /material object, not a regenerated projection.
    $expected=$source.GetProperty('material')
    switch($Purpose){
        'IMPLEMENTATION_RECORD'{
            ObjectKeys $expected $keys;TextIs $expected.GetProperty('format') 'xdev-supervised-record-1';TextIs $expected.GetProperty('job_id') $currentJob;TextIs $expected.GetProperty('role') 'implementation';TextIs $expected.GetProperty('manifest_sha256') $ManifestSha256
            $s=$expected.GetProperty('session');ObjectKeys $s @('format','role','session_ref','source_claim','native_authenticated','dispatch_request','dispatch_return','natural_final','natural_end','stop_requested','completion_observation')
            TextIs $s.GetProperty('format') 'xdev-supervised-public-session-2';TextIs $s.GetProperty('role') 'implementation';TextIs $s.GetProperty('source_claim') 'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS';TextIs $s.GetProperty('session_ref') $currentAuthor
            Check ($s.GetProperty('native_authenticated').ValueKind -eq 'False' -and $s.GetProperty('natural_end').ValueKind -eq 'True' -and $s.GetProperty('stop_requested').ValueKind -eq 'False') 'CHECK_SESSION_FLAGS'
        }
        'IMPLEMENTATION_RELEASE'{CheckImplementationRelease $expected}
        'RECORD_PREFLIGHT'{
            ObjectKeys $expected @('expected','record');$binding=$expected.GetProperty('expected')
            ObjectKeys $binding @('project_root','project_id','control_root','input_root','server_path','server_sha256','node_path','node_sha256','node_version','config_sha256')
            TextIs $binding.GetProperty('project_id') $currentId;TextIs $binding.GetProperty('project_root') $currentProject;TextIs $binding.GetProperty('input_root') $currentInput;TextIs $binding.GetProperty('control_root') (Join-Path $currentPhase 'control')
            TextIs $binding.GetProperty('server_path') $approvedServer;TextIs $binding.GetProperty('server_sha256') $approvedServerHash
            TextIs $binding.GetProperty('node_path') $approvedNode;TextIs $binding.GetProperty('node_sha256') $approvedNodeHash;TextIs $binding.GetProperty('node_version') $approvedNodeVersion;TextIs $binding.GetProperty('config_sha256') $approvedConfigHash
        }
        default{
            $sk=@('format','status','role','session_ref','job_id','task_id','spec_sha256','manifest_sha256','source_root','execution_bindings_path','execution_bindings_sha256','role_admission','carrier_path','carrier_sha256','command')
            if($Purpose -ceq 'CAPACITY_SUBJECT'){$sk+=@('capacity_request');$role='capacity';$file='run-capacity.mjs'}else{$sk+=@('qa_request','capacity_result');$role='qa';$file='run-core-qa.mjs'}
            ObjectKeys $expected $sk;TextIs $expected.GetProperty('format') 'xdev-opt-batch-subject-1';TextIs $expected.GetProperty('status') 'RELEASED';TextIs $expected.GetProperty('role') $role
            TextIs $expected.GetProperty('job_id') $currentJob;TextIs $expected.GetProperty('task_id') $currentTask;TextIs $expected.GetProperty('spec_sha256') $currentSpec;TextIs $expected.GetProperty('manifest_sha256') $ManifestSha256;TextIs $expected.GetProperty('source_root') $currentProject
            TextIs $expected.GetProperty('execution_bindings_path') (Join-Path $currentInput 'EXECUTION-BINDINGS.json');TextIs $expected.GetProperty('carrier_path') (Join-Path $currentPhase ('carriers\'+$file))
            Check ($expected.GetProperty('carrier_sha256').ValueKind -eq 'String' -and $expected.GetProperty('carrier_sha256').GetString() -cmatch '^[a-f0-9]{64}$') 'CHECK_CARRIER_HASH'
            Check ($expected.GetProperty('session_ref').ValueKind -eq 'String' -and $expected.GetProperty('session_ref').GetString() -cmatch '^/root/[^\s/]+$' -and $expected.GetProperty('session_ref').GetString() -cne $currentAuthor) 'CHECK_SUBJECT_SESSION'
            $c=$expected.GetProperty('command');TextIs $c.GetProperty('executable') $approvedNode;TextIs $c.GetProperty('cwd') $currentProject
            Check ($c.GetProperty('timeout_ms').ValueKind -eq 'Number' -and $c.GetProperty('timeout_ms').GetInt32() -eq 300000 -and $c.GetProperty('per_stream_bytes').ValueKind -eq 'Number' -and $c.GetProperty('per_stream_bytes').GetInt32() -eq 65536) 'CHECK_SUBJECT_LIMITS'
        }
    }
    if($Purpose -ceq 'CAPACITY_SUBJECT'){CheckCapacityInputs $expected}
    $actual=LoadOriginal $ActualPath $ActualSha256;CompareOriginal $expected $actual.doc.RootElement ''
    VisitReferences $expected
    if($Purpose -ceq 'IMPLEMENTATION_RECORD'){
        CheckImplementationRecord $expected
    }elseif($Purpose -ceq 'RECORD_PREFLIGHT'){
        $rr=$expected.GetProperty('record');ObjectKeys $rr @('path','sha256');$record=LoadOriginal $rr.GetProperty('path').GetString() $rr.GetProperty('sha256').GetString();CheckImplementationRecord $record.doc.RootElement
    }
    foreach($entry in $observed.GetEnumerator()){CheckedPath $entry.Key;Check ((RawHash ([IO.File]::ReadAllBytes($entry.Key))) -ceq $entry.Value) 'CHECK_PIN_DRIFT'}
    if((Get-FileHash -LiteralPath $ApprovedContractPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ApprovedContractSha256){throw 'CONTRACT_PIN_DRIFT'};[pscustomobject]@{status='CHECKED_NOT_EXECUTED';purpose=$Purpose;source_path=$SourcePath;source_sha256=$SourceSha256;actual_path=$ActualPath;actual_sha256=$ActualSha256;raw_original_comparison=$true;generated_lineage_used_as_expected=$false;execution_started=$false;references_checked=$observed.Count}
}finally{foreach($d in $opened){$d.Dispose()};$cd.Dispose()}
