#requires -Version 7.5
<#
Extract one explicitly approved current material, preserving native JSON types.
SourcePath/SourceSha256 and ManifestPath/ManifestSha256 must be pinned by the
current Root card. A matching hash is a byte binding, not an authority receipt.
The source envelope has a fixed /material pointer, never a supplied recipe.
Purpose is one of the five cases below. Protocol objects receive no admin keys.
This tool does not launch, authorize, record or test any Core/Node/SDK action.
Test-Material.ps1 independently consumes the original, not this lineage output.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$SourceSha256,
    [Parameter(Mandatory)][ValidateSet('IMPLEMENTATION_RECORD','RECORD_PREFLIGHT','IMPLEMENTATION_RELEASE','CAPACITY_SUBJECT','FORMAL_QA_SUBJECT')][string]$Purpose,
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$ManifestSha256,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$LineagePath,
    [Parameter(Mandatory)][string]$ApprovedContractPath,
    [Parameter(Mandatory)][string]$ApprovedContractSha256,
    [switch]$Fixture
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
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
$inputRoot=$cv.GetProperty('input_root').GetString()
$phaseRoot=[IO.Path]::GetDirectoryName($inputRoot)
$fixtureRoot=Join-Path $phaseRoot 'evidence\tmp'
$projectRoot=$cv.GetProperty('project_root').GetString()
$projectId=$cv.GetProperty('project_id').GetString()
$job=$cv.GetProperty('job_id').GetString()
$task=$cv.GetProperty('task_id').GetString()
$spec=$cv.GetProperty('spec_sha256').GetString()
$author=$cv.GetProperty('author').GetString()
$begin=$approvedBegin;$end=$approvedEnd
$recordKeys=@('format','job_id','role','session','manifest_sha256','writer_status','job_release')
$reads=[Collections.Generic.List[object]]::new()
$documents=[Collections.Generic.List[IDisposable]]::new()
function Require([bool]$ok,[string]$code){if(-not $ok){throw $code}}
function Digest([byte[]]$bytes){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
function Within([string]$base,[string]$path){$path.StartsWith($base+'\',[StringComparison]::Ordinal)}
function SafePath([string]$path,[bool]$output=$false){
    Require ([IO.Path]::IsPathFullyQualified($path) -and [IO.Path]::GetFullPath($path) -ceq $path) 'MATERIAL_CANONICAL_PATH'
    $knownCarrier=Join-Path $phaseRoot 'carriers\run-capacity.mjs'
    Require ((Within $inputRoot $path) -or ($Fixture -and (Within $fixtureRoot $path)) -or (-not $output -and $path -ceq $knownCarrier)) 'MATERIAL_DOMAIN'
    $cursor=$path
    if($output){Require (-not [IO.File]::Exists($path) -and -not [IO.Directory]::Exists($path)) 'MATERIAL_OUTPUT_EXISTS';$cursor=[IO.Path]::GetDirectoryName($path);Require ([IO.Directory]::Exists($cursor)) 'MATERIAL_OUTPUT_PARENT'}
    while($cursor){
        $item=Get-Item -LiteralPath $cursor -Force
        Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and -not $item.LinkType) 'MATERIAL_LINK'
        $parent=[IO.Path]::GetDirectoryName($cursor);if($parent -ceq $cursor){break};$cursor=$parent
    }
}
function Unique([Text.Json.JsonElement]$e){
    if($e.ValueKind -eq 'Object'){$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);foreach($p in $e.EnumerateObject()){Require ($names.Add($p.Name)) 'MATERIAL_DUPLICATE_KEY';Unique $p.Value}}
    elseif($e.ValueKind -eq 'Array'){foreach($v in $e.EnumerateArray()){Unique $v}}
}
function Keys([Text.Json.JsonElement]$e,[string[]]$keys){
    Require ($e.ValueKind -eq 'Object') 'MATERIAL_OBJECT_TYPE'
    $actual=@($e.EnumerateObject()|ForEach-Object{$_.Name})
    Require ($actual.Count -eq $keys.Count) 'MATERIAL_KEY_SET'
    foreach($k in $keys){Require ($actual -ccontains $k) 'MATERIAL_KEY_SET'}
}
function StringValue([Text.Json.JsonElement]$e){Require ($e.ValueKind -eq 'String') 'MATERIAL_STRING_TYPE';$e.GetString()}
function EqualString([Text.Json.JsonElement]$e,[string]$value){Require ((StringValue $e) -ceq $value) 'MATERIAL_SCOPE_VALUE'}
function Hex([Text.Json.JsonElement]$e){Require ((StringValue $e) -cmatch '^[a-f0-9]{64}$') 'MATERIAL_HASH_TYPE'}
function ReadPinned([string]$path,[string]$sha){
    Require ($sha -cmatch '^[a-f0-9]{64}$') 'MATERIAL_HASH_TYPE';SafePath $path
    $allowed=@($inputRoot,(Join-Path $phaseRoot 'carriers'));if($Fixture){$allowed+=@($fixtureRoot)}
    $read=Read-PreparationJson -Path $path -Sha256 $sha -AllowedRoots $allowed
    $doc=$read.Document;$documents.Add($doc)
    $reads.Add([pscustomobject]@{path=$path;sha256=$sha})
    [pscustomobject]@{document=$doc;text=$read.Text}
}
function Graph([Text.Json.JsonElement]$e,[int]$depth=0){
    Require ($depth -le 32) 'MATERIAL_GRAPH_DEPTH'
    if($e.ValueKind -eq 'Object'){
        $props=@($e.EnumerateObject());$names=@($props|ForEach-Object{$_.Name})
        if($names -ccontains 'id' -and $names -ccontains 'sha256'){throw 'MATERIAL_UNSUPPORTED_CORE_EVIDENCE_ID'}
        if(($names -ccontains 'path') -or ($names -ccontains 'sha256')){
            # Carrier row/stream receipts are not Core input FileRefs. Do not
            # reinterpret their path/bytes/id/status as a two-key JSON leaf.
            Require ($names.Count -eq 2 -and $names -ccontains 'path' -and $names -ccontains 'sha256') 'MATERIAL_UNSUPPORTED_CARRIER_OR_OPAQUE_REFERENCE'
            Keys $e @('path','sha256');$p=StringValue $e.GetProperty('path');Hex $e.GetProperty('sha256')
            Require ($reads.Count -lt 128) 'MATERIAL_GRAPH_LIMIT'
            $seen=$false;foreach($r in $reads){if($r.path -ceq $p){Require ($r.sha256 -ceq $e.GetProperty('sha256').GetString()) 'MATERIAL_AMBIGUOUS_REF';$seen=$true}}
            if(-not $seen){$leaf=ReadPinned $p $e.GetProperty('sha256').GetString();Graph $leaf.document.RootElement ($depth+1)}
        }else{foreach($p in $props){
            switch -CaseSensitive ($p.Name){'job_id'{EqualString $p.Value $job};'task_id'{EqualString $p.Value $task};'spec_sha256'{EqualString $p.Value $spec};'manifest_sha256'{EqualString $p.Value $ManifestSha256};'project_id'{EqualString $p.Value $projectId};'project_root'{EqualString $p.Value $projectRoot}}
            Graph $p.Value ($depth+1)
        }}
    }elseif($e.ValueKind -eq 'Array'){foreach($v in $e.EnumerateArray()){Graph $v ($depth+1)}}
}
function ImplementationEvidence([Text.Json.JsonElement]$record){
    $s=$record.GetProperty('session');$fr=$s.GetProperty('natural_final');$cr=$s.GetProperty('completion_observation')
    Keys $fr @('path','sha256');Keys $cr @('path','sha256')
    $final=ReadPinned (StringValue $fr.GetProperty('path')) (StringValue $fr.GetProperty('sha256'))
    $envelope=$final.document.RootElement;Keys $envelope @('message_type','sender','payload','truncated')
    EqualString $envelope.GetProperty('message_type') 'FINAL_ANSWER';EqualString $envelope.GetProperty('sender') $author;Require ($envelope.GetProperty('truncated').ValueKind -eq 'False') 'MATERIAL_FINAL_TRUNCATED'
    # Only this known public-final payload is parsed. Arbitrary chat/message
    # strings, locators and embedded evidence descriptions remain opaque data.
    $payload=StringValue $envelope.GetProperty('payload');$decision=[Text.Json.JsonDocument]::Parse($payload);$documents.Add($decision);Unique $decision.RootElement;$d=$decision.RootElement
    # Supported public session2 payload: status is the sole outcome discriminator.
    # Legacy decision/result payloads have no supported discriminator here.
    Keys $d @('session_ref','role','job_id','task_id','spec_sha256','manifest_sha256','status','changed_files','summary','runtime_commands','tests','limitations')
    EqualString $d.GetProperty('role') 'implementation';EqualString $d.GetProperty('session_ref') $author
    EqualString $d.GetProperty('job_id') $job;EqualString $d.GetProperty('task_id') $task;EqualString $d.GetProperty('spec_sha256') $spec;EqualString $d.GetProperty('manifest_sha256') $ManifestSha256
    EqualString $d.GetProperty('status') 'IMPLEMENTED'
    foreach($name in @('changed_files','limitations')){$array=$d.GetProperty($name);Require ($array.ValueKind -eq 'Array' -and $array.GetArrayLength() -le 10000) 'MATERIAL_FINAL_ARRAY';foreach($item in $array.EnumerateArray()){$null=StringValue $item}}
    $null=StringValue $d.GetProperty('summary');$null=StringValue $d.GetProperty('tests');$commands=$d.GetProperty('runtime_commands');Require ($commands.ValueKind -eq 'Number' -and $commands.GetInt32() -ge 0) 'MATERIAL_FINAL_COMMANDS'
    $completion=ReadPinned (StringValue $cr.GetProperty('path')) (StringValue $cr.GetProperty('sha256'));$agents=$completion.document.RootElement.GetProperty('agents')
    Require ($agents.ValueKind -eq 'Array' -and $agents.GetArrayLength() -ge 1 -and $agents.GetArrayLength() -le 128) 'MATERIAL_COMPLETION_ARRAY'
    $targetRows=[Collections.Generic.List[Text.Json.JsonElement]]::new()
    foreach($agent in $agents.EnumerateArray()){Keys $agent @('agent_name','agent_status');$name=StringValue $agent.GetProperty('agent_name');if($name -ceq $author){$targetRows.Add($agent)}}
    Require ($targetRows.Count -eq 1) 'MATERIAL_UNIQUE_COMPLETION_TARGET'
    $status=$targetRows[0].GetProperty('agent_status');Keys $status @('completed')
    Require ([string]::Equals((StringValue $status.GetProperty('completed')),$payload,[StringComparison]::Ordinal)) 'MATERIAL_COMPLETION_MISMATCH'
}
function ImplementationRelease([Text.Json.JsonElement]$release){
    Keys $release @('job_id','task_name','message');EqualString $release.GetProperty('job_id') $job;EqualString $release.GetProperty('task_name') $author
    Require ((StringValue $release.GetProperty('message')).Length -gt 0) 'MATERIAL_RELEASE_MESSAGE'
}
function ImplementationRecord([Text.Json.JsonElement]$record){
    Keys $record $recordKeys;EqualString $record.GetProperty('format') 'xdev-supervised-record-1';EqualString $record.GetProperty('role') 'implementation';EqualString $record.GetProperty('job_id') $job;EqualString $record.GetProperty('manifest_sha256') $ManifestSha256
    $s=$record.GetProperty('session');Keys $s @('format','role','session_ref','source_claim','native_authenticated','dispatch_request','dispatch_return','natural_final','natural_end','stop_requested','completion_observation')
    EqualString $s.GetProperty('format') 'xdev-supervised-public-session-2';EqualString $s.GetProperty('role') 'implementation';EqualString $s.GetProperty('source_claim') 'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS';EqualString $s.GetProperty('session_ref') $author
    Require ($s.GetProperty('native_authenticated').ValueKind -eq 'False' -and $s.GetProperty('stop_requested').ValueKind -eq 'False' -and $s.GetProperty('natural_end').ValueKind -eq 'True') 'MATERIAL_SESSION_BOOLEAN'
    ImplementationEvidence $record
    $w=$record.GetProperty('writer_status');Keys $w @('path','sha256');$writer=ReadPinned (StringValue $w.GetProperty('path')) (StringValue $w.GetProperty('sha256'));$we=$writer.document.RootElement
    Keys $we @('format','job_id','manifest_sha256','scope','unknown_writers','writers','observation');EqualString $we.GetProperty('format') 'xdev-dot-public-writers-1';EqualString $we.GetProperty('scope') 'PUBLIC_HOST_ONLY';EqualString $we.GetProperty('job_id') $job;EqualString $we.GetProperty('manifest_sha256') $ManifestSha256
    Require ($we.GetProperty('unknown_writers').ValueKind -eq 'False' -and $we.GetProperty('writers').ValueKind -eq 'Array' -and $we.GetProperty('writers').GetArrayLength() -eq 1) 'MATERIAL_WRITERS_TYPE';EqualString $we.GetProperty('writers')[0] $author
    $wo=$we.GetProperty('observation');$co=$s.GetProperty('completion_observation');Keys $wo @('path','sha256');EqualString $wo.GetProperty('path') (StringValue $co.GetProperty('path'));EqualString $wo.GetProperty('sha256') (StringValue $co.GetProperty('sha256'))
    $releaseRef=$record.GetProperty('job_release');Keys $releaseRef @('path','sha256');$release=ReadPinned (StringValue $releaseRef.GetProperty('path')) (StringValue $releaseRef.GetProperty('sha256'));ImplementationRelease $release.document.RootElement
}
function CapacityEvidence([Text.Json.JsonElement]$subject){
    # A single named current carrier is raw source bytes, not an arbitrary
    # FileRef graph expansion. Its expected hash comes from the independently
    # pinned current EXECUTION-BINDINGS, never from hashing the live file first.
    $fixed=ReadPinned (StringValue $subject.GetProperty('execution_bindings_path')) (StringValue $subject.GetProperty('execution_bindings_sha256'));$f=$fixed.document.RootElement
    EqualString $f.GetProperty('format') 'xdev-opt-execution-bindings-1';EqualString $f.GetProperty('project_id') $projectId;EqualString $f.GetProperty('project_root') $projectRoot
    EqualString $f.GetProperty('job_id') $job;EqualString $f.GetProperty('task_id') $task;EqualString $f.GetProperty('spec_sha256') $spec;EqualString $f.GetProperty('manifest_sha256') $ManifestSha256
    Require ($f.GetProperty('source_count').ValueKind -eq 'Number' -and $f.GetProperty('source_count').GetInt32() -eq $approvedCount) 'MATERIAL_FULL361_REQUIRED'
    EqualString $f.GetProperty('source_manifest').GetProperty('path') $ManifestPath;EqualString $f.GetProperty('source_manifest').GetProperty('sha256') $ManifestSha256
    EqualString $f.GetProperty('implementation_session') $author;EqualString $f.GetProperty('capacity_session') (StringValue $subject.GetProperty('session_ref'))
    $cp=StringValue $subject.GetProperty('carrier_path');$ch=StringValue $subject.GetProperty('carrier_sha256')
    EqualString $f.GetProperty('capacity_carrier').GetProperty('path') $cp;EqualString $f.GetProperty('capacity_carrier').GetProperty('sha256') $ch;SafePath $cp
    $carrierInfo=Get-Item -LiteralPath $cp -Force;Require (-not $carrierInfo.PSIsContainer -and $carrierInfo.Length -le 2097152) 'MATERIAL_CARRIER_LEAF'
    Require ((Digest ([IO.File]::ReadAllBytes($cp))) -ceq $ch) 'MATERIAL_PIN_DRIFT';$reads.Add([pscustomobject]@{path=$cp;sha256=$ch})
    $ar=$subject.GetProperty('role_admission');$admission=ReadPinned (StringValue $ar.GetProperty('path')) (StringValue $ar.GetProperty('sha256'));$a=$admission.document.RootElement
    EqualString $a.GetProperty('format') 'xdev-opt-role-admission-1';EqualString $a.GetProperty('status') 'ADMITTED';EqualString $a.GetProperty('session_ref') (StringValue $subject.GetProperty('session_ref'));EqualString $a.GetProperty('job_id') $job;EqualString $a.GetProperty('manifest_sha256') $ManifestSha256;EqualString $a.GetProperty('scope') 'CAPACITY_ONLY';Require ($a.GetProperty('native_authenticated').ValueKind -eq 'False') 'MATERIAL_ADMISSION_FLAGS'
    $qr=$subject.GetProperty('capacity_request');$request=ReadPinned (StringValue $qr.GetProperty('path')) (StringValue $qr.GetProperty('sha256'));$q=$request.document.RootElement
    EqualString $q.GetProperty('format') 'xdev-opt-capacity-request-1';EqualString $q.GetProperty('job_id') $job;EqualString $q.GetProperty('task_id') $task;EqualString $q.GetProperty('spec_sha256') $spec;EqualString $q.GetProperty('manifest_sha256') $ManifestSha256;EqualString $q.GetProperty('session_ref') (StringValue $subject.GetProperty('session_ref'))
    EqualString $q.GetProperty('execution_bindings_path') (StringValue $subject.GetProperty('execution_bindings_path'));EqualString $q.GetProperty('execution_bindings_sha256') (StringValue $subject.GetProperty('execution_bindings_sha256'))
}
function NewFile([string]$path,[byte[]]$bytes){$s=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}}
try{
    # This purpose depends on the carrier's successful capacity result, nested
    # bounded JSON evidence, raw TAP streams and Core {id,sha256} receipts. Those
    # are deliberately unsupported here, rather than silently widening the
    # strict input graph or treating raw bytes as JSON. Root must use a separate
    # specifically approved native material procedure for that subject.
    Require ($Purpose -cne 'FORMAL_QA_SUBJECT') 'MATERIAL_UNSUPPORTED_FORMAL_QA_CARRIER_EVIDENCE'
    Require ([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($begin) -and [DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse($end)) 'MATERIAL_WINDOW'
    SafePath $OutputPath $true;SafePath $LineagePath $true;Require ($OutputPath -cne $LineagePath) 'MATERIAL_OUTPUT_COLLISION'
    $request=ReadPinned (Join-Path $inputRoot 'REQUEST.json') $approvedRequestHash
    $start=ReadPinned (Join-Path $inputRoot 'ENTRY-ACTUAL-START.json') $approvedStartHash
    EqualString $start.document.RootElement.GetProperty('job_id') $job;EqualString $start.document.RootElement.GetProperty('task_id') $task
    EqualString $request.document.RootElement.GetProperty('spec').GetProperty('sha256') $spec
    Require ($ManifestSha256 -ceq $cv.GetProperty('manifest_sha256').GetString()) 'MATERIAL_OLD_MANIFEST'
    $mf=ReadPinned $ManifestPath $ManifestSha256;Require ($mf.document.RootElement.ValueKind -eq 'Array' -and $mf.document.RootElement.GetArrayLength() -eq $approvedCount) 'MATERIAL_FULL361_REQUIRED'
    foreach($m in $mf.document.RootElement.EnumerateArray()){Keys $m @('path','sha256');Hex $m.GetProperty('sha256')}
    $source=ReadPinned $SourcePath $SourceSha256;$root=$source.document.RootElement
    Keys $root @('format','purpose','project_id','project_root','job_id','task_id','spec_sha256','manifest_sha256','not_before','expires_at','writers','strict_record_keys','material')
    EqualString $root.GetProperty('format') 'xdev-acceptance-material-source-1';EqualString $root.GetProperty('purpose') $Purpose
    EqualString $root.GetProperty('project_id') $projectId;EqualString $root.GetProperty('project_root') $projectRoot
    EqualString $root.GetProperty('job_id') $job;EqualString $root.GetProperty('task_id') $task;EqualString $root.GetProperty('spec_sha256') $spec
    EqualString $root.GetProperty('manifest_sha256') $ManifestSha256;EqualString $root.GetProperty('not_before') $begin;EqualString $root.GetProperty('expires_at') $end
    $writers=$root.GetProperty('writers');Require ($writers.ValueKind -eq 'Array' -and $writers.GetArrayLength() -eq 1) 'MATERIAL_WRITERS_TYPE';EqualString $writers[0] $author
    $strict=$root.GetProperty('strict_record_keys');Require ($strict.ValueKind -eq 'Array' -and $strict.GetArrayLength() -eq 7) 'MATERIAL_RECORD_KEYS_TYPE'
    for($i=0;$i -lt 7;$i++){EqualString $strict[$i] $recordKeys[$i]}
    $material=$root.GetProperty('material');$projection=@()
    switch($Purpose){
        'IMPLEMENTATION_RECORD'{
            $projection=$recordKeys;Keys $material $projection;EqualString $material.GetProperty('format') 'xdev-supervised-record-1';EqualString $material.GetProperty('role') 'implementation'
            EqualString $material.GetProperty('job_id') $job;EqualString $material.GetProperty('manifest_sha256') $ManifestSha256
            $session=$material.GetProperty('session');Keys $session @('format','role','session_ref','source_claim','native_authenticated','dispatch_request','dispatch_return','natural_final','natural_end','stop_requested','completion_observation')
            EqualString $session.GetProperty('format') 'xdev-supervised-public-session-2';EqualString $session.GetProperty('role') 'implementation';EqualString $session.GetProperty('source_claim') 'COORDINATOR_TRANSFERRED_PUBLIC_TOOLS';EqualString $session.GetProperty('session_ref') $author
            Require ($session.GetProperty('native_authenticated').ValueKind -eq 'False' -and $session.GetProperty('stop_requested').ValueKind -eq 'False' -and $session.GetProperty('natural_end').ValueKind -eq 'True') 'MATERIAL_SESSION_BOOLEAN'
        }
        'RECORD_PREFLIGHT'{
            $projection=@('expected','record');Keys $material $projection;$expected=$material.GetProperty('expected')
            Keys $expected @('project_root','project_id','control_root','input_root','server_path','server_sha256','node_path','node_sha256','node_version','config_sha256')
            EqualString $expected.GetProperty('project_id') $projectId;EqualString $expected.GetProperty('project_root') $projectRoot
            EqualString $expected.GetProperty('input_root') $inputRoot;EqualString $expected.GetProperty('control_root') (Join-Path $phaseRoot 'control')
            EqualString $expected.GetProperty('server_path') $approvedServer
            EqualString $expected.GetProperty('server_sha256') $approvedServerHash
            EqualString $expected.GetProperty('node_path') $approvedNode;EqualString $expected.GetProperty('node_sha256') $approvedNodeHash;EqualString $expected.GetProperty('node_version') $approvedNodeVersion
            EqualString $expected.GetProperty('config_sha256') $approvedConfigHash
        }
        'IMPLEMENTATION_RELEASE'{
            $projection=@('job_id','task_name','message');Keys $material $projection
            ImplementationRelease $material
        }
        default{
            $projection=@('format','status','role','session_ref','job_id','task_id','spec_sha256','manifest_sha256','source_root','execution_bindings_path','execution_bindings_sha256','role_admission','carrier_path','carrier_sha256','command')
            if($Purpose -ceq 'CAPACITY_SUBJECT'){$projection+=@('capacity_request');$role='capacity';$carrier='run-capacity.mjs'}else{$projection+=@('qa_request','capacity_result');$role='qa';$carrier='run-core-qa.mjs'}
            Keys $material $projection;EqualString $material.GetProperty('format') 'xdev-opt-batch-subject-1';EqualString $material.GetProperty('status') 'RELEASED';EqualString $material.GetProperty('role') $role
            EqualString $material.GetProperty('job_id') $job;EqualString $material.GetProperty('task_id') $task;EqualString $material.GetProperty('spec_sha256') $spec;EqualString $material.GetProperty('manifest_sha256') $ManifestSha256
            EqualString $material.GetProperty('source_root') $projectRoot;EqualString $material.GetProperty('execution_bindings_path') (Join-Path $inputRoot 'EXECUTION-BINDINGS.json');Hex $material.GetProperty('execution_bindings_sha256')
            Require ((StringValue $material.GetProperty('session_ref')) -cmatch '^/root/[^\s/]+$' -and $material.GetProperty('session_ref').GetString() -cne $author) 'MATERIAL_SUBJECT_SESSION'
            EqualString $material.GetProperty('carrier_path') (Join-Path $phaseRoot ('carriers\'+$carrier));Hex $material.GetProperty('carrier_sha256')
            $command=$material.GetProperty('command');EqualString $command.GetProperty('executable') $approvedNode;EqualString $command.GetProperty('cwd') $projectRoot
            Require ($command.GetProperty('timeout_ms').ValueKind -eq 'Number' -and $command.GetProperty('timeout_ms').GetInt32() -eq 300000 -and $command.GetProperty('per_stream_bytes').ValueKind -eq 'Number' -and $command.GetProperty('per_stream_bytes').GetInt32() -eq 65536) 'MATERIAL_SUBJECT_LIMITS'
        }
    }
    if($Purpose -ceq 'CAPACITY_SUBJECT'){CapacityEvidence $material}
    Graph $material
    if($Purpose -ceq 'IMPLEMENTATION_RECORD'){
        ImplementationRecord $material
    }elseif($Purpose -ceq 'RECORD_PREFLIGHT'){
        $rr=$material.GetProperty('record');Keys $rr @('path','sha256');$record=ReadPinned (StringValue $rr.GetProperty('path')) (StringValue $rr.GetProperty('sha256'));ImplementationRecord $record.document.RootElement
    }
    # Fixed projection only. JsonNode never passes through a PSObject conversion.
    $node=[Text.Json.Nodes.JsonNode]::Parse($source.text);$body=$node['material'];$out=[Text.Json.Nodes.JsonObject]::new()
    $pointers=[Collections.Generic.List[object]]::new()
    foreach($key in $projection){$out.Add($key,$body[$key].DeepClone());$pointers.Add([ordered]@{output_pointer='/'+$key;source_pointer='/material/'+$key;source_raw=$material.GetProperty($key).GetRawText()})}
    $raw=[Text.UTF8Encoding]::new($false,$true).GetBytes($out.ToJsonString())
    foreach($r in $reads){SafePath $r.path;Require ((Digest ([IO.File]::ReadAllBytes($r.path))) -ceq $r.sha256) 'MATERIAL_PIN_DRIFT'}
    $lineage=[ordered]@{format='xdev-material-lineage-1';purpose=$Purpose;job_id=$job;task_id=$task;spec_sha256=$spec;manifest_sha256=$ManifestSha256;source=[ordered]@{path=$SourcePath;sha256=$SourceSha256};output=[ordered]@{path=$OutputPath;sha256=(Digest $raw)};pointer_origin=$pointers.ToArray();reads=$reads.ToArray();native_identity_authenticated=$false;execution_started=$false}
    $lineageBytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($lineage|ConvertTo-Json -Depth 32))
    if((Get-FileHash -LiteralPath $ApprovedContractPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ApprovedContractSha256){throw 'CONTRACT_PIN_DRIFT'};NewFile $OutputPath $raw;NewFile $LineagePath $lineageBytes
    [pscustomobject]@{status='DERIVED_NOT_EXECUTED';purpose=$Purpose;path=$OutputPath;sha256=(Digest $raw);lineage_path=$LineagePath;execution_started=$false}
}finally{foreach($d in $documents){$d.Dispose()};$cd.Dispose()}
