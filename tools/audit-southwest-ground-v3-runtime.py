#!/usr/bin/env python3
"""CPU-only acceptance audit for Southwest ground v3 runtime textures.

The pinned KTX builder remains the source of truth for Khronos validation,
container metadata, layer ordering, and hashes.  This audit runs that existing
``-CheckOnly`` path, verifies the lossless fallback manifest, and checks the AO
alpha authored into every packed PNG.  It then decodes one packed KTX layer at
a time into a temporary directory and compares it with the corresponding 2K
source, so no persistent extraction set or large temporary footprint remains.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PACK_ROOT = ROOT / "assets" / "pbr" / "eanpa_southwest_ground_v3"
RUNTIME_ROOT = PACK_ROOT / "runtime"
SOURCE_MANIFEST_PATH = PACK_ROOT / "manifest.json"
FALLBACK_ROOT = RUNTIME_ROOT / "fallback_1k"
FALLBACK_MANIFEST_PATH = FALLBACK_ROOT / "manifest.json"
KTX_MANIFEST_PATH = RUNTIME_ROOT / "southwest-ground-v3-ktx2-manifest.json"
KTX_CHECK_PATH = ROOT / "tools" / "build-southwest-ground-v3-ktx2.ps1"
KTX_EXE = ROOT / "tools" / "vendor" / "ktx" / "4.4.2" / "bin" / "ktx.exe"

EXPECTED_LAYER_COUNT = 14
SOURCE_SIZE = (2048, 2048)
FALLBACK_SIZE = (1024, 1024)

# These floors are intentionally far below the current authored ranges while
# still rejecting a constant/default AO channel or a nearly-flat placeholder.
MIN_AO_CODE_RANGE = 32
MIN_AO_STDDEV = 2.0

# UASTC quality 4 is lossy.  These distributional limits were measured against
# the pinned Khronos 4.4.2 RGBA8 transcoder and leave narrow rounding headroom.
MAX_AO_MAE = 13.0
MAX_AO_RMSE = 17.0
MAX_AO_P99 = 50.0
MAX_AO_ABS_BIAS = 0.12
MIN_AO_CORRELATION = 0.84


class AuditFailure(RuntimeError):
    """A deterministic runtime acceptance check failed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AuditFailure(message)


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"required manifest is missing: {path.relative_to(ROOT)}")
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def assert_record_file(root: Path, record: dict[str, Any], label: str) -> Path:
    path = root / record["path"]
    require(path.is_file(), f"{label} is missing: {path.relative_to(ROOT)}")
    require(sha256_file(path) == record["sha256"], f"{label} hash mismatch: {path.name}")
    if "byte_size" in record:
        require(path.stat().st_size == record["byte_size"], f"{label} byte-size mismatch: {path.name}")
    return path


def read_alpha(path: Path, expected_size: tuple[int, int], label: str) -> np.ndarray:
    with Image.open(path) as image:
        require(image.format == "PNG", f"{label} is not PNG: {path.name}")
        require(image.mode == "RGBA", f"{label} is not authored RGBA8: {path.name} ({image.mode})")
        require(image.size == expected_size, f"{label} dimensions mismatch: {path.name} ({image.size})")
        return np.asarray(image.getchannel("A"), dtype=np.uint8).copy()


def alpha_stats(alpha: np.ndarray) -> dict[str, float | int]:
    minimum = int(alpha.min())
    maximum = int(alpha.max())
    return {
        "min": minimum,
        "max": maximum,
        "range": maximum - minimum,
        "stddev": round(float(alpha.std(dtype=np.float64)), 6),
    }


def assert_nonflat_ao(stats: dict[str, float | int], label: str) -> None:
    require(int(stats["range"]) >= MIN_AO_CODE_RANGE,
            f"{label} AO range is too small: {stats['range']} codes")
    require(float(stats["stddev"]) >= MIN_AO_STDDEV,
            f"{label} AO variance is too small: stddev={stats['stddev']}")


def correlation(left: np.ndarray, right: np.ndarray) -> float:
    """Pearson correlation with bounded scratch memory for a 2K channel."""
    require(left.shape == right.shape, "AO correlation shape mismatch")
    count = left.size
    sums = np.zeros(5, dtype=np.float64)
    rows_per_chunk = 128
    for first_row in range(0, left.shape[0], rows_per_chunk):
        left_chunk = left[first_row:first_row + rows_per_chunk].astype(np.float64)
        right_chunk = right[first_row:first_row + rows_per_chunk].astype(np.float64)
        sums[0] += left_chunk.sum()
        sums[1] += right_chunk.sum()
        sums[2] += np.square(left_chunk).sum()
        sums[3] += np.square(right_chunk).sum()
        sums[4] += np.multiply(left_chunk, right_chunk).sum()
    left_mean = sums[0] / count
    right_mean = sums[1] / count
    left_variance = sums[2] / count - left_mean * left_mean
    right_variance = sums[3] / count - right_mean * right_mean
    covariance = sums[4] / count - left_mean * right_mean
    require(left_variance > 0 and right_variance > 0, "AO correlation received a flat channel")
    return covariance / math.sqrt(left_variance * right_variance)


def codec_metrics(source: np.ndarray, decoded: np.ndarray) -> dict[str, float | int]:
    delta = decoded.astype(np.int16) - source.astype(np.int16)
    absolute = np.abs(delta)
    metrics: dict[str, float | int] = {
        "mae": round(float(absolute.mean()), 6),
        "rmse": round(math.sqrt(float(np.square(delta.astype(np.float64)).mean())), 6),
        "p99_abs": round(float(np.percentile(absolute, 99)), 6),
        "max_abs": int(absolute.max()),
        "bias": round(float(delta.mean()), 6),
        "correlation": round(correlation(source, decoded), 6),
    }
    return metrics


def assert_codec_metrics(metrics: dict[str, float | int], layer_id: str) -> None:
    require(float(metrics["mae"]) <= MAX_AO_MAE,
            f"{layer_id} KTX AO MAE exceeds tolerance: {metrics['mae']}")
    require(float(metrics["rmse"]) <= MAX_AO_RMSE,
            f"{layer_id} KTX AO RMSE exceeds tolerance: {metrics['rmse']}")
    require(float(metrics["p99_abs"]) <= MAX_AO_P99,
            f"{layer_id} KTX AO p99 error exceeds tolerance: {metrics['p99_abs']}")
    require(abs(float(metrics["bias"])) <= MAX_AO_ABS_BIAS,
            f"{layer_id} KTX AO bias exceeds tolerance: {metrics['bias']}")
    require(float(metrics["correlation"]) >= MIN_AO_CORRELATION,
            f"{layer_id} KTX AO correlation is too low: {metrics['correlation']}")


def run_ktx_check() -> str:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    require(powershell is not None, "PowerShell is required for the pinned KTX CheckOnly audit")
    completed = subprocess.run(
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", str(KTX_CHECK_PATH),
            "-Threads", "4",
            "-CheckOnly",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    output = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part.strip())
    require(completed.returncode == 0, f"pinned KTX CheckOnly failed:\n{output}")
    pass_lines = [line.strip() for line in output.splitlines() if line.startswith("PASS KTX2 CHECK:")]
    require(len(pass_lines) == 1, f"pinned KTX CheckOnly did not emit its acceptance line:\n{output}")
    return pass_lines[0]


def extract_layer(packed_ktx: Path, index: int, output: Path) -> None:
    if output.exists():
        output.unlink()
    completed = subprocess.run(
        [
            str(KTX_EXE), "extract", "--transcode", "rgba8",
            "--level", "0", "--layer", str(index),
            str(packed_ktx), str(output),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    diagnostic = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part.strip())
    require(completed.returncode == 0,
            f"KTX AO extraction failed for layer {index}: {diagnostic}")
    require(output.is_file(), f"KTX AO extraction produced no PNG for layer {index}")


def audit() -> dict[str, Any]:
    ktx_check = run_ktx_check()
    require(KTX_EXE.is_file(), f"vendored KTX executable is missing: {KTX_EXE.relative_to(ROOT)}")

    source_manifest = load_json(SOURCE_MANIFEST_PATH)
    fallback_manifest = load_json(FALLBACK_MANIFEST_PATH)
    ktx_manifest = load_json(KTX_MANIFEST_PATH)
    layer_order = source_manifest.get("layer_order")
    require(isinstance(layer_order, list) and len(layer_order) == EXPECTED_LAYER_COUNT,
            "authoritative manifest does not contain exactly fourteen ordered layers")
    require(fallback_manifest.get("layer_order") == layer_order,
            "fallback manifest layer order differs from the authoritative manifest")
    require(ktx_manifest.get("layer_order") == layer_order,
            "KTX manifest layer order differs from the authoritative manifest")
    require(fallback_manifest.get("source_manifest", {}).get("sha256") == sha256_file(SOURCE_MANIFEST_PATH),
            "fallback manifest does not reference the exact authoritative manifest")

    source_by_id = {entry["id"]: entry for entry in source_manifest["layers"]}
    fallback_by_id = {entry["id"]: entry for entry in fallback_manifest["layers"]}
    require(len(source_by_id) == EXPECTED_LAYER_COUNT, "authoritative manifest layer records are incomplete")
    require(len(fallback_by_id) == EXPECTED_LAYER_COUNT, "fallback manifest layer records are incomplete")

    packed_output = [record for record in ktx_manifest["outputs"]
                     if record.get("key") == "packed_nxy_rough_ao"]
    require(len(packed_output) == 1, "KTX manifest must contain one packed AO array")
    packed_ktx = assert_record_file(PACK_ROOT, packed_output[0], "packed KTX array")

    layer_results: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="eanpa-southwest-ground-v3-ao-") as temporary:
        decoded_path = Path(temporary) / "decoded-layer.png"
        for index, layer_id in enumerate(layer_order):
            source_entry = source_by_id[layer_id]
            fallback_entry = fallback_by_id[layer_id]
            require(source_entry.get("order") == index, f"authoritative order mismatch: {layer_id}")
            require(fallback_entry.get("order") == index, f"fallback order mismatch: {layer_id}")

            source_record = source_entry["runtime"]["packed_normal_xy_roughness_ao"]
            fallback_record = fallback_entry["files"]["packed_normal_xy_roughness_ao"]
            source_path = assert_record_file(PACK_ROOT, source_record, "authoritative packed PNG")
            fallback_path = assert_record_file(FALLBACK_ROOT, fallback_record, "fallback packed PNG")
            require(fallback_record.get("source_sha256") == source_record["sha256"],
                    f"fallback packed source hash mismatch: {layer_id}")

            source_alpha = read_alpha(source_path, SOURCE_SIZE, "authoritative packed PNG")
            fallback_alpha = read_alpha(fallback_path, FALLBACK_SIZE, "fallback packed PNG")
            source_stats = alpha_stats(source_alpha)
            fallback_stats = alpha_stats(fallback_alpha)
            assert_nonflat_ao(source_stats, f"{layer_id} authoritative")
            assert_nonflat_ao(fallback_stats, f"{layer_id} fallback")

            extract_layer(packed_ktx, index, decoded_path)
            try:
                decoded_alpha = read_alpha(decoded_path, SOURCE_SIZE, "decoded packed KTX layer")
                decoded_stats = alpha_stats(decoded_alpha)
                assert_nonflat_ao(decoded_stats, f"{layer_id} decoded KTX")
                metrics = codec_metrics(source_alpha, decoded_alpha)
                assert_codec_metrics(metrics, layer_id)
            finally:
                decoded_path.unlink(missing_ok=True)

            layer_results.append({
                "index": index,
                "id": layer_id,
                "authoritative_ao": source_stats,
                "fallback_ao": fallback_stats,
                "decoded_ktx_ao": decoded_stats,
                "codec_error": metrics,
            })

    array_records = []
    for record in ktx_manifest["outputs"]:
        path = assert_record_file(PACK_ROOT, record, f"{record['key']} KTX array")
        array_records.append({
            "key": record["key"],
            "path": path.relative_to(ROOT).as_posix(),
            "byte_size": path.stat().st_size,
            "sha256": sha256_file(path),
            "dimensions": record["dimensions"],
            "layers": record["layer_count"],
            "mips": record["mip_level_count"],
        })

    return {
        "ktx_check": ktx_check,
        "manifest_sha256": {
            "authoritative": sha256_file(SOURCE_MANIFEST_PATH),
            "fallback": sha256_file(FALLBACK_MANIFEST_PATH),
            "ktx": sha256_file(KTX_MANIFEST_PATH),
        },
        "arrays": array_records,
        "ao_acceptance": {
            "minimum_code_range": MIN_AO_CODE_RANGE,
            "minimum_stddev": MIN_AO_STDDEV,
            "maximum_mae": MAX_AO_MAE,
            "maximum_rmse": MAX_AO_RMSE,
            "maximum_p99_abs": MAX_AO_P99,
            "maximum_absolute_bias": MAX_AO_ABS_BIAS,
            "minimum_correlation": MIN_AO_CORRELATION,
        },
        "layers": layer_results,
        "temporary_decode_policy": "one level-0 RGBA8 layer at a time; deleted immediately",
    }


def main() -> None:
    try:
        summary = audit()
    except (AuditFailure, KeyError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"southwest ground v3 runtime audit: FAIL\n- {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(f"southwest ground v3 runtime audit: PASS ({EXPECTED_LAYER_COUNT} AO layers, CPU only)")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
