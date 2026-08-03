[CmdletBinding()]
param(
    [ValidateRange(1, 4)]
    [int]$Threads = 4,

    [ValidateRange(1, 22)]
    [int]$ZstdLevel = 3,

    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$PackRoot = Join-Path $WorkspaceRoot 'assets\pbr\eanpa_southwest_ground_v3'
$RuntimeRoot = Join-Path $PackRoot 'runtime'
$SourceManifestPath = Join-Path $PackRoot 'manifest.json'
$KtxRoot = Join-Path $WorkspaceRoot 'tools\vendor\ktx\4.4.2'
$KtxExe = Join-Path $KtxRoot 'bin\ktx.exe'
$InstallerPath = Join-Path $WorkspaceRoot 'tools\vendor\ktx\KTX-Software-4.4.2-Windows-x64.exe'
$OutputManifestPath = Join-Path $RuntimeRoot 'southwest-ground-v3-ktx2-manifest.json'

$ExpectedLayerCount = 14
$ExpectedWidth = 2048
$ExpectedHeight = 2048
$ExpectedLevelCount = 12
$KtxReleaseVersion = 'v4.4.2'
$KtxReleaseUrl = 'https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2'
$KtxInstallerUrl = 'https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Windows-x64.exe'
$KtxInstallerSha256 = '1f323b0fec19794f5e6c0425a61d4b1da396872a10be862d105f4f4b2d2957fe'
$LoaderFilePaths = @(
    'vendor/three/addons/loaders/KTX2Loader.js',
    'vendor/three/addons/utils/WorkerPool.js',
    'vendor/three/addons/libs/ktx-parse.module.js',
    'vendor/three/addons/libs/zstddec.module.js',
    'vendor/three/addons/math/ColorSpaces.js',
    'vendor/three/addons/libs/basis/basis_transcoder.js',
    'vendor/three/addons/libs/basis/basis_transcoder.wasm'
)

function Get-Sha256Lower {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-File {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file is missing: $Path"
    }
}

function Get-PngDimensions {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $header = New-Object byte[] 24
        $read = $stream.Read($header, 0, $header.Length)
        if ($read -ne 24) {
            throw "PNG header is truncated: $Path"
        }

        $signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
        for ($i = 0; $i -lt $signature.Length; $i++) {
            if ($header[$i] -ne $signature[$i]) {
                throw "File is not a PNG: $Path"
            }
        }

        $width = [int](
            ([uint32]$header[16] -shl 24) -bor
            ([uint32]$header[17] -shl 16) -bor
            ([uint32]$header[18] -shl 8) -bor
            [uint32]$header[19]
        )
        $height = [int](
            ([uint32]$header[20] -shl 24) -bor
            ([uint32]$header[21] -shl 16) -bor
            ([uint32]$header[22] -shl 8) -bor
            [uint32]$header[23]
        )
        return [pscustomobject]@{ width = $width; height = $height }
    }
    finally {
        $stream.Dispose()
    }
}

function Invoke-Ktx {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $output = & $KtxExe @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "ktx $($Arguments -join ' ') failed with exit code $LASTEXITCODE`n$output"
        }
        return ($output -join "`n")
    }

    & $KtxExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "ktx $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Assert-KtxInfo {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('srgb', 'linear')][string]$Transfer
    )

    Invoke-Ktx -Arguments @('validate', '--warnings-as-errors', $Path)
    $infoJson = Invoke-Ktx -Arguments @('info', '--format', 'mini-json', $Path) -Capture
    $info = $infoJson | ConvertFrom-Json

    if (-not $info.valid) { throw "KTX info did not report a valid file: $Path" }
    if ($info.header.pixelWidth -ne $ExpectedWidth) { throw "Unexpected KTX width in ${Path}: $($info.header.pixelWidth)" }
    if ($info.header.pixelHeight -ne $ExpectedHeight) { throw "Unexpected KTX height in ${Path}: $($info.header.pixelHeight)" }
    if ($info.header.pixelDepth -ne 0) { throw "Expected a 2D array, not a 3D texture: $Path" }
    if ($info.header.layerCount -ne $ExpectedLayerCount) { throw "Unexpected KTX layer count in ${Path}: $($info.header.layerCount)" }
    if ($info.header.faceCount -ne 1) { throw "Unexpected KTX face count in ${Path}: $($info.header.faceCount)" }
    if ($info.header.levelCount -ne $ExpectedLevelCount) { throw "Unexpected KTX mip count in ${Path}: $($info.header.levelCount)" }
    if ($info.header.supercompressionScheme -ne 'KTX_SS_ZSTD') { throw "Expected Zstd supercompression: $Path" }

    $dfd = $info.dataFormatDescriptor.blocks[0]
    if ($dfd.colorModel -ne 'KHR_DF_MODEL_UASTC') { throw "Expected UASTC payload: $Path" }

    $expectedTransfer = if ($Transfer -eq 'srgb') { 'KHR_DF_TRANSFER_SRGB' } else { 'KHR_DF_TRANSFER_LINEAR' }
    if ($dfd.transferFunction -ne $expectedTransfer) {
        throw "Unexpected transfer function in ${Path}: $($dfd.transferFunction)"
    }

    $expectedPrimaries = if ($Transfer -eq 'srgb') { 'KHR_DF_PRIMARIES_BT709' } else { 'KHR_DF_PRIMARIES_UNSPECIFIED' }
    if ($dfd.colorPrimaries -ne $expectedPrimaries) {
        throw "Unexpected color primaries in ${Path}: $($dfd.colorPrimaries)"
    }

    $writerParameters = [string]$info.keyValueData.KTXwriterScParams
    if ($writerParameters -notmatch '(?:^|\s)--uastc-quality 4(?:\s|$)') { throw "UASTC quality 4 is not recorded in $Path" }
    if ($writerParameters -notmatch "(?:^|\s)--zstd $ZstdLevel(?:\s|$)") { throw "Zstd level is not recorded in $Path" }
    if ($writerParameters -match '(?i)rdo|normal') { throw "RDO or normal-mode was unexpectedly enabled in $Path" }

    return $info
}

Assert-File -Path $SourceManifestPath
Assert-File -Path $KtxExe
Assert-File -Path $InstallerPath

if ((Get-Sha256Lower -Path $InstallerPath) -ne $KtxInstallerSha256) {
    throw 'The vendored Khronos KTX-Software installer does not match the pinned SHA-256.'
}

$versionText = Invoke-Ktx -Arguments @('--version') -Capture
if ($versionText -notmatch 'v4\.4\.2') {
    throw "Expected KTX-Software v4.4.2, got: $versionText"
}

$sourceManifest = Get-Content -LiteralPath $SourceManifestPath -Raw | ConvertFrom-Json
$layerOrder = @($sourceManifest.layer_order)
if ($layerOrder.Count -ne $ExpectedLayerCount) {
    throw "Expected $ExpectedLayerCount material layers, got $($layerOrder.Count)."
}

$layerById = @{}
foreach ($layer in $sourceManifest.layers) {
    $layerById[[string]$layer.id] = $layer
}

$albedoInputs = [System.Collections.Generic.List[string]]::new()
$packedInputs = [System.Collections.Generic.List[string]]::new()
$inputRecords = [System.Collections.Generic.List[object]]::new()

for ($index = 0; $index -lt $layerOrder.Count; $index++) {
    $id = [string]$layerOrder[$index]
    if (-not $layerById.ContainsKey($id)) { throw "Manifest layer is missing: $id" }

    $layer = $layerById[$id]
    if ([int]$layer.order -ne $index) { throw "Layer order mismatch for ${id}: expected $index, got $($layer.order)" }

    $albedoPath = Join-Path $PackRoot ([string]$layer.runtime.albedo.path)
    $packedPath = Join-Path $PackRoot ([string]$layer.runtime.packed_normal_xy_roughness_ao.path)
    Assert-File -Path $albedoPath
    Assert-File -Path $packedPath

    foreach ($path in @($albedoPath, $packedPath)) {
        $dimensions = Get-PngDimensions -Path $path
        if ($dimensions.width -ne $ExpectedWidth -or $dimensions.height -ne $ExpectedHeight) {
            throw "Expected ${ExpectedWidth}x${ExpectedHeight} PNG, got $($dimensions.width)x$($dimensions.height): $path"
        }
    }

    $albedoHash = Get-Sha256Lower -Path $albedoPath
    $packedHash = Get-Sha256Lower -Path $packedPath
    if ($albedoHash -ne ([string]$layer.runtime.albedo.sha256).ToLowerInvariant()) { throw "Albedo hash mismatch: $id" }
    if ($packedHash -ne ([string]$layer.runtime.packed_normal_xy_roughness_ao.sha256).ToLowerInvariant()) { throw "Packed PBR hash mismatch: $id" }

    $albedoInputs.Add((Resolve-Path -LiteralPath $albedoPath).Path)
    $packedInputs.Add((Resolve-Path -LiteralPath $packedPath).Path)
    $inputRecords.Add([ordered]@{
        index = $index
        id = $id
        albedo_height_png = [ordered]@{ path = "runtime/$([System.IO.Path]::GetFileName($albedoPath))"; sha256 = $albedoHash }
        packed_nxy_rough_ao_png = [ordered]@{ path = "runtime/$([System.IO.Path]::GetFileName($packedPath))"; sha256 = $packedHash }
    })
}

$outputs = @(
    [ordered]@{
        key = 'albedo_height'
        filename = 'SouthwestGroundV3_AlbedoHeight_14x2K_UASTC.ktx2'
        format = 'R8G8B8A8_SRGB'
        transfer = 'srgb'
        primaries = 'bt709'
        inputs = $albedoInputs.ToArray()
        channel_contract = [ordered]@{
            RGB = 'graded sRGB albedo; hardware sRGB decode applies to RGB'
            A = 'linear displacement-derived transition height; sRGB transfer does not apply to alpha'
        }
    },
    [ordered]@{
        key = 'packed_nxy_rough_ao'
        filename = 'SouthwestGroundV3_PackedNxyRoughAO_14x2K_UASTC.ktx2'
        format = 'R8G8B8A8_UNORM'
        transfer = 'linear'
        primaries = 'none'
        inputs = $packedInputs.ToArray()
        channel_contract = [ordered]@{
            R = 'linear tangent-space NormalGL X encoded as UNORM8'
            G = 'linear tangent-space NormalGL Y encoded as UNORM8'
            B = 'linear roughness encoded as UNORM8'
            A = 'linear ambient occlusion encoded as UNORM8'
        }
    }
)

if ($CheckOnly) {
    Assert-File -Path $OutputManifestPath
    $builtManifest = Get-Content -LiteralPath $OutputManifestPath -Raw | ConvertFrom-Json
    if ([int]$builtManifest.schema_version -ne 1) { throw 'Unexpected KTX runtime manifest schema.' }
    if ([int]$builtManifest.layer_count -ne $ExpectedLayerCount) { throw 'KTX runtime manifest layer count mismatch.' }
    if (Compare-Object @($builtManifest.layer_order) $layerOrder -SyncWindow 0) { throw 'KTX runtime manifest layer order mismatch.' }
    if ([int]$builtManifest.runtime_resolution[0] -ne $ExpectedWidth -or [int]$builtManifest.runtime_resolution[1] -ne $ExpectedHeight) {
        throw 'KTX runtime manifest resolution mismatch.'
    }

    $manifestInputs = @($builtManifest.inputs)
    if ($manifestInputs.Count -ne $ExpectedLayerCount) { throw 'KTX runtime manifest input count mismatch.' }
    for ($index = 0; $index -lt $inputRecords.Count; $index++) {
        $expected = $inputRecords[$index]
        $actual = $manifestInputs[$index]
        if ([int]$actual.index -ne $index -or [string]$actual.id -cne [string]$expected.id) {
            throw 'KTX manifest input layer order mismatch.'
        }
        if ([string]$actual.albedo_height_png.sha256 -cne [string]$expected.albedo_height_png.sha256) {
            throw 'KTX manifest albedo input hash mismatch.'
        }
        if ([string]$actual.packed_nxy_rough_ao_png.sha256 -cne [string]$expected.packed_nxy_rough_ao_png.sha256) {
            throw 'KTX manifest packed input hash mismatch.'
        }
    }
    $manifestOutputs = @($builtManifest.outputs)
    if ($manifestOutputs.Count -ne $outputs.Count) { throw 'KTX runtime manifest output count mismatch.' }
    foreach ($output in $outputs) {
        $finalPath = Join-Path $RuntimeRoot $output.filename
        Assert-File -Path $finalPath
        $null = Assert-KtxInfo -Path $finalPath -Transfer $output.transfer
        $record = @($manifestOutputs | Where-Object { $_.key -ceq $output.key })
        if ($record.Count -ne 1) { throw 'KTX runtime manifest output record mismatch.' }
        $record = $record[0]
        $file = Get-Item -LiteralPath $finalPath
        $hash = Get-Sha256Lower -Path $finalPath
        $expectedOutputPath = 'runtime/' + $output.filename
        if ([string]$record.path -cne $expectedOutputPath) { throw 'KTX output path mismatch.' }
        if ([string]$record.sha256 -cne $hash) { throw 'KTX output hash mismatch.' }
        if ([int64]$record.byte_size -ne $file.Length) { throw 'KTX output byte-size mismatch.' }
        if ([int]$record.layer_count -ne $ExpectedLayerCount -or [int]$record.mip_level_count -ne $ExpectedLevelCount) {
            throw 'KTX output geometry metadata mismatch.'
        }
        if ([int]$record.dimensions[0] -ne $ExpectedWidth -or [int]$record.dimensions[1] -ne $ExpectedHeight) {
            throw 'KTX output dimensions mismatch.'
        }
        if ([int]$record.uastc_quality -ne 4 -or [bool]$record.uastc_rdo -or [bool]$record.normal_mode) {
            throw 'KTX output encoder-policy mismatch.'
        }
    }
    $manifestLoaderFiles = @($builtManifest.official_three_loader.files)
    if ($manifestLoaderFiles.Count -ne $LoaderFilePaths.Count) { throw 'KTX runtime manifest loader-file count mismatch.' }
    foreach ($relativePath in $LoaderFilePaths) {
        $absolutePath = Join-Path $WorkspaceRoot $relativePath
        Assert-File -Path $absolutePath
        $record = @($manifestLoaderFiles | Where-Object { $_.path -ceq $relativePath })
        if ($record.Count -ne 1) { throw 'KTX runtime manifest loader record mismatch.' }
        $loaderHash = Get-Sha256Lower -Path $absolutePath
        $loaderSize = (Get-Item -LiteralPath $absolutePath).Length
        if ([string]$record[0].sha256 -cne $loaderHash) { throw 'Vendored Three loader hash mismatch.' }
        if ([int64]$record[0].byte_size -ne $loaderSize) { throw 'Vendored Three loader byte-size mismatch.' }
    }
    Write-Host 'PASS KTX2 CHECK: 2 arrays; 14 layers each; 2048x2048; 12 mips; UASTC quality 4; Zstd; PNG, output, loader, and manifest hashes match.'
    exit 0
}

$outputRecords = [System.Collections.Generic.List[object]]::new()
foreach ($output in $outputs) {
    $finalPath = Join-Path $RuntimeRoot $output.filename
    $buildingPath = "$finalPath.building"
    if (Test-Path -LiteralPath $buildingPath) { Remove-Item -LiteralPath $buildingPath -Force }

    $arguments = @(
        'create',
        '--format', $output.format,
        '--layers', [string]$ExpectedLayerCount,
        '--generate-mipmap',
        '--mipmap-filter', 'lanczos4',
        '--mipmap-wrap', 'wrap',
        '--encode', 'uastc',
        '--uastc-quality', '4',
        '--zstd', [string]$ZstdLevel,
        '--assign-tf', $output.transfer,
        '--assign-primaries', $output.primaries,
        '--assign-texcoord-origin', 'top-left',
        '--threads', [string]$Threads,
        '--testrun'
    ) + [string[]]$output.inputs + @($buildingPath)

    Write-Host "Building $($output.filename) from $ExpectedLayerCount layers..."
    Invoke-Ktx -Arguments $arguments
    $info = Assert-KtxInfo -Path $buildingPath -Transfer $output.transfer
    Move-Item -LiteralPath $buildingPath -Destination $finalPath -Force

    $file = Get-Item -LiteralPath $finalPath
    $outputRecords.Add([ordered]@{
        key = $output.key
        path = "runtime/$($output.filename)"
        sha256 = Get-Sha256Lower -Path $finalPath
        byte_size = $file.Length
        dimensions = @($ExpectedWidth, $ExpectedHeight)
        layer_count = $ExpectedLayerCount
        mip_level_count = $ExpectedLevelCount
        texture_kind = '2d-array'
        payload = 'Basis Universal UASTC 4x4'
        uastc_quality = 4
        uastc_rdo = $false
        normal_mode = $false
        supercompression = "Zstandard level $ZstdLevel"
        mip_filter = 'lanczos4'
        mip_wrap = 'wrap'
        transfer_function = $info.dataFormatDescriptor.blocks[0].transferFunction
        color_primaries = $info.dataFormatDescriptor.blocks[0].colorPrimaries
        channel_contract = $output.channel_contract
    })
}

$loaderRecords = foreach ($relativePath in $LoaderFilePaths) {
    $absolutePath = Join-Path $WorkspaceRoot $relativePath
    Assert-File -Path $absolutePath
    [ordered]@{
        path = $relativePath
        sha256 = Get-Sha256Lower -Path $absolutePath
        byte_size = (Get-Item -LiteralPath $absolutePath).Length
    }
}

$outputManifest = [ordered]@{
    schema_version = 1
    generated_by = 'tools/build-southwest-ground-v3-ktx2.ps1'
    source_manifest = 'assets/pbr/eanpa_southwest_ground_v3/manifest.json'
    layer_order = $layerOrder
    layer_count = $ExpectedLayerCount
    runtime_resolution = @($ExpectedWidth, $ExpectedHeight)
    input_pngs_preserved = $true
    compression_policy = [ordered]@{
        codec = 'Basis Universal UASTC 4x4'
        quality = 4
        rdo = $false
        normal_mode = $false
        zstd_level = $ZstdLevel
        mipmaps = 'complete 2048-to-1 chain'
        mip_filter = 'lanczos4'
        mip_wrap = 'wrap'
        threads = $Threads
    }
    official_ktx_tool = [ordered]@{
        name = 'Khronos KTX-Software'
        version = $KtxReleaseVersion
        release_url = $KtxReleaseUrl
        installer_url = $KtxInstallerUrl
        installer_path = 'tools/vendor/ktx/KTX-Software-4.4.2-Windows-x64.exe'
        installer_sha256 = $KtxInstallerSha256
    }
    official_three_loader = [ordered]@{
        version = 'r184'
        tag_url = 'https://github.com/mrdoob/three.js/releases/tag/r184'
        tag_object_sha = 'e78e81725013343d38ceb7b13070c9ff5b8dafbb'
        commit_sha = 'd3b629c0c2097cec664ad16369bb6eae3b10e335'
        immutable_source_root = 'https://raw.githubusercontent.com/mrdoob/three.js/d3b629c0c2097cec664ad16369bb6eae3b10e335/examples/jsm'
        files = @($loaderRecords)
    }
    inputs = @($inputRecords)
    outputs = @($outputRecords)
    runtime_integration = [ordered]@{
        loader_import = './vendor/three/addons/loaders/KTX2Loader.js'
        transcoder_path = './vendor/three/addons/libs/basis/'
        required_setup = @(
            'const loader = new KTX2Loader();',
            "loader.setTranscoderPath('./vendor/three/addons/libs/basis/');",
            'loader.detectSupport(renderer);'
        )
        texture_results = 'Each file loads as a THREE.CompressedArrayTexture with 14 depth layers.'
        color_space_contract = 'Albedo-height reports sRGB and applies decoding to RGB only; packed normalXY/roughness/AO reports no color space and stays linear.'
    }
}

$manifestJson = $outputManifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($OutputManifestPath, "$manifestJson`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "Wrote $OutputManifestPath"
$outputRecords | ForEach-Object { Write-Host ("{0}: {1:N2} MiB, SHA-256 {2}" -f $_.path, ($_.byte_size / 1MB), $_.sha256) }
