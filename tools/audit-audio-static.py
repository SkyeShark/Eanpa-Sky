#!/usr/bin/env python3
"""CPU-only acceptance audit for Eanpa's retained and generated scene audio.

Requires the repository's existing ffmpeg/ffprobe tools plus NumPy. The audit
does not play audio, create a browser/AudioContext, use the GPU, or modify any
asset. It decodes the exact Ogg files used by Web Audio and reports both source
and post-runtime-trim levels.
"""

from __future__ import annotations

import hashlib
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys

import numpy as np


ROOT = pathlib.Path(__file__).resolve().parents[1]
AUDIO_ROOT = ROOT / "assets" / "audio"
AUDIO_SOURCE = ROOT / "src" / "audio_system.js"
STONE_BUILDER = ROOT / "tools" / "build-stone-footsteps.py"

GROUPS = {
    "sand": [f"footstep_sand_{index:02d}.ogg" for index in range(1, 5)],
    "gravel": [f"footstep_gravel_{index:02d}.ogg" for index in range(1, 5)],
    "sandstone": [f"footstep_sandstone_{index:02d}.ogg" for index in range(1, 5)],
    "stone": [f"footstep_stone_{index:02d}.ogg" for index in range(1, 5)],
    "land": ["landing_soft.ogg", "landing_medium.ogg", "landing_heavy.ogg"],
    "gate": ["gate_open.ogg", "gate_close.ogg"],
    "flashlight": ["flashlight_click_on.ogg", "flashlight_click_off.ogg"],
    "desert_wind": ["ambience_desert_wind.wav"],
    "desert_birds": [
        "bird_cactus_wren_01.mp3", "bird_cactus_wren_02.mp3",
        "bird_roadrunner_01.mp3", "bird_roadrunner_02.mp3",
    ],
    "rain": ["rain_desert_loop.ogg"],
    "thunder_close": [f"thunder_close_{index:02d}.ogg" for index in range(1, 4)],
    "thunder_distant": [f"thunder_distant_{index:02d}.ogg" for index in range(1, 4)],
    "thunder_explosive": [f"thunder_explosive_{index:02d}.wav" for index in range(1, 4)],
}
FILES = [name for names in GROUPS.values() for name in names]
EXPECTED_CHANNELS = {
    name: (1 if name.startswith("landing_") or name.startswith("gate_")
           or name.startswith("flashlight_click_") or name.startswith("bird_")
           or name.startswith("ambience_desert_wind")
           or name.startswith("footstep_stone_") else 2)
    for name in FILES
}
EXPECTED_CODECS = {
    name: ("pcm_s16le" if name.endswith(".wav") else "mp3" if name.endswith(".mp3") else "vorbis")
    for name in FILES
}
EXPECTED_SAMPLE_RATES = {
    name: (32000 if name.startswith("bird_") or name.startswith("ambience_desert_wind") else 48000)
    for name in FILES
}
RUNTIME_TRIMS = {"footstep_gravel_04.ogg": 0.22}
STONE_SOURCES = (
    ("footstep_stone_01.ogg", "Fantozzi-StoneL1.ogg",
     "2d85768f04a85b6068f3548b33d6e0b0424c5e62b0941042d593affd3a9555d4"),
    ("footstep_stone_02.ogg", "Fantozzi-StoneR1.ogg",
     "d6949efd0255d50efe4853cc077b18e3ee96b155707ccf4199fd530aaac82d58"),
    ("footstep_stone_03.ogg", "Fantozzi-StoneL2.ogg",
     "1cdd36f02590d2b968b1dd311334e71db8514d7c276e62ad474d01c26b37d4de"),
    ("footstep_stone_04.ogg", "Fantozzi-StoneR2.ogg",
     "075c27afbf29b7771cb01a7bf51530b835e82c56698ca5551318fa0c6b7adb9f"),
)
STONE_RUNTIME_HASHES = {
    "footstep_stone_01.ogg":
        "63156059e7fee60501811a5134f0a2f7c5ae8dc4af211973178e11c3e445be7a",
    "footstep_stone_02.ogg":
        "ab487ce5a8621ff56be0d2d7a8c17b9aead0b0b5a7fd77b3c34dbb431e315f45",
    "footstep_stone_03.ogg":
        "4078db7e6d1ddf51c33079e5218bc4e54e332a68d7f5730b57a3591992977005",
    "footstep_stone_04.ogg":
        "f6ddcba13fc9fe118e0000914de95804ae87823d1c238a8ac99f297f5523621b",
}
SOURCE_HASHES = {
    "XC163986 - Greater Roadrunner - Geococcyx californianus.mp3":
        "f4517f251497639a1f18e9443f5202253e07e374d5d4a427306c9c7568d212ec",
    "XC254875 - Greater Roadrunner - Geococcyx californianus.mp3":
        "25ccdc86e0f05498782dda7cc28b07f56988d8995a2b8a0540438f7608d73fe5",
    "XC543301 - Cactus Wren - Campylorhynchus brunneicapillus.mp3":
        "09e11abdaea43bd1664af746f4fe6cd328fc091e33a52cbba15a910d21f5ca8f",
    "XC920390 - Cactus Wren - Campylorhynchus brunneicapillus.mp3":
        "693ee95003819fd6953c07f1bccccb97ebef0104ebd4c5309ff41ed3654496f6",
}
RUNTIME_AMBIENCE_HASHES = {
    "ambience_desert_wind.wav":
        "d1350fa03881b5eb36caf6bee5ec681397ece863664b81e4a4355d10af9ce0ca",
    "bird_cactus_wren_01.mp3":
        "5a74d45d30f0a74b1cc8fd2fb13605957e8c21e3bbf22bb7183924deccc050ec",
    "bird_cactus_wren_02.mp3":
        "eddbceab117bf7147607a2e6471fa82173ecb3daa18a484baacefaf90596eb37",
    "bird_roadrunner_01.mp3":
        "b0e244972360bb54ecaee0a6a19e8dd0f6b577d2785a8e1efc7b9420ceadff0e",
    "bird_roadrunner_02.mp3":
        "284c276f35b0be48e7d946357bfc0fbfeedb5b900cfc8097a9c28d0d88f78667",
}

failures: list[str] = []
checks = 0


def check(condition: bool, message: str, detail: str = "") -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(f"{message}{': ' + detail if detail else ''}")


def db(value: float) -> float:
    return 20.0 * math.log10(max(abs(value), 1e-12))


def command(args: list[str], *, stdout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=True,
        text=True,
        stdout=stdout if stdout is not None else subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def probe(path: pathlib.Path) -> dict[str, float | int | str]:
    result = command([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", str(path),
    ])
    payload = json.loads(result.stdout)
    stream = payload["streams"][0]
    return {
        "codec": stream["codec_name"],
        "sample_rate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "duration": float(payload["format"]["duration"]),
    }


def decode(path: pathlib.Path, channels: int) -> np.ndarray:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    samples = np.frombuffer(result.stdout, dtype="<f4")
    if samples.size % channels:
        raise RuntimeError(f"decoded sample count is not divisible by {channels}: {path.name}")
    return samples.reshape(-1, channels)


def loudness(path: pathlib.Path) -> tuple[float, float, float]:
    result = command([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
        "loudnorm=I=-24:LRA=7:TP=-2:print_format=json", "-f", "null", "-",
    ], stdout=subprocess.DEVNULL)
    blocks = re.findall(r"\{[\s\S]*?\}", result.stderr)
    payload = json.loads(blocks[-1])
    parse = lambda value: float(value) if value not in {"-inf", "inf"} else float(value)
    return parse(payload["input_i"]), parse(payload["input_lra"]), parse(payload["input_tp"])


def active_rms(samples: np.ndarray, threshold_db: float = -45.0) -> float:
    mask = np.max(np.abs(samples), axis=1) > 10 ** (threshold_db / 20.0)
    active = samples[mask]
    return float(np.sqrt(np.mean(active * active))) if active.size else 0.0


def validate_duration(name: str, duration: float) -> bool:
    if name.startswith("footstep_"): return 0.25 <= duration <= 0.8
    if name.startswith("landing_"): return 0.3 <= duration <= 0.6
    if name.startswith("gate_"): return 1.8 <= duration <= 2.6
    if name.startswith("flashlight_click_"): return 0.06 <= duration <= 0.22
    if name.startswith("ambience_desert_wind"): return 17.04 <= duration <= 17.06
    if name.startswith("bird_"): return 4.2 <= duration <= 6.1
    if name.startswith("rain_"): return 43.49 <= duration <= 43.51
    if name.startswith("thunder_explosive"): return 3.9 <= duration <= 4.1
    if name.startswith("thunder_"): return 6.0 <= duration <= 15.0
    return False


for executable in ["ffmpeg", "ffprobe"]:
    check(shutil.which(executable) is not None, f"{executable} is available")
if failures:
    raise SystemExit("\n".join(failures))

actual_files = sorted(
    path.name
    for extension in ("*.ogg", "*.mp3", "*.wav")
    for path in AUDIO_ROOT.glob(extension)
)
check(actual_files == sorted(FILES), "Runtime Ogg inventory is exact",
      f"expected {len(FILES)}, found {len(actual_files)}")

audio_source = AUDIO_SOURCE.read_text(encoding="utf-8")
readme = (AUDIO_ROOT / "README.md").read_text(encoding="utf-8")
sources_readme = (AUDIO_ROOT / "cc0_sources" / "SOURCES.md").read_text(encoding="utf-8")
check("'footstep_gravel_04.ogg': 0.22" in audio_source,
      "Runtime contains the measured gravel-04 trim")
check("if (FILES.rain.includes(name)) beginRain();" in audio_source,
      "Rain starts immediately when its own decoded buffer is ready")
check("CC0" in readme and "CC0" in sources_readme, "CC0 provenance remains documented")
check("Generated flashlight clicks" in readme and "stable_audio_3_medium_base.safetensors" in readme,
      "Stable Audio 3 flashlight provenance is documented separately")
check("7162612" in readme and "7162613" in readme,
      "Flashlight generation seeds are retained")
check("Real CC0 stone footsteps" in readme
      and "Fantozzi-StoneL1.ogg" in readme and "Fantozzi-StoneR1.ogg" in readme
      and "Fantozzi-StoneL2.ogg" in readme and "Fantozzi-StoneR2.ogg" in readme,
      "Real Fantozzi stone-footstep provenance and L1/R1/L2/R2 order are documented")
check("Generated stone footsteps" not in readme,
      "Rejected generated-stone provenance is retired")
check("playFlashlightToggle" in audio_source and "gain: 0.12" in audio_source,
      "Flashlight toggle path uses restrained non-spatial gain")
check("...FILES.flashlightOn, ...FILES.flashlightOff" in audio_source,
      "Flashlight clicks receive priority decoding")
check("...FILES.stone" in audio_source, "Real CC0 stone contacts receive priority decoding")
check("walkSurfaceTypeAt?.(x, z, footY)" in audio_source
      and "return 'stone'" in audio_source,
      "Authored temple walk surfaces route to the dedicated stone family")
check("wash >= 0.42 ? 'sand' : 'gravel'" in audio_source,
      "Ordinary terrain defaults to gravel and sand is wash-limited")
check("DESERT_WIND_LEVEL = 0.06" in audio_source
      and "windSource.loop = true" in audio_source,
      "Desert wind uses a restrained continuous gapless loop")
check("BIRD_INITIAL_GAP_SECONDS = Object.freeze([70, 150])" in audio_source
      and "BIRD_QUIET_GAP_SECONDS = Object.freeze([140, 320])" in audio_source,
      "Bird scheduler keeps SeedThree calls behind long randomized quiet gaps")
check("name !== birdLastAsset" in audio_source,
      "Bird scheduler prevents an immediate asset repeat")
check("BIRD_DISTANCE_METERS = Object.freeze([48, 105])" in audio_source
      and "BIRD_GAIN_RANGE = Object.freeze([0.08, 0.14])" in audio_source
      and "rolloffFactor: 0.48" in audio_source,
      "Bird calls are restrained by authored distance, gain, and HRTF falloff")
check("rain > 0.14" in audio_source and "armNextBird(false, now)" in audio_source,
      "Birds remain quiet during material rain and re-arm a long gap")
check("XC543301" in readme and "XC920390" in readme
      and "XC163986" in readme and "XC254875" in readme,
      "All four xeno-canto catalogue IDs are documented")
check("CC BY-NC-SA 3.0" in readme and "CC BY-NC-SA 4.0" in readme,
      "Recording-specific noncommercial ShareAlike licenses are explicit")
check("1924920684" in readme and "Dry desert wind blowing steadily" in readme,
      "Stable Audio desert-wind seed and prompt are retained")
licensed_sources = AUDIO_ROOT / "licensed_sources" / "xeno_canto_desert"
for name, expected_hash in SOURCE_HASHES.items():
    source = licensed_sources / name
    check(source.is_file(), f"Retained xeno-canto original exists: {name}")
    if source.is_file():
        check(hashlib.sha256(source.read_bytes()).hexdigest() == expected_hash,
              f"Retained xeno-canto original hash is stable: {name}")
generated_wind = AUDIO_ROOT / "generated_sources" / "seedthree_desert_wind"
wind_raw = generated_wind / "wind_desert_raw_00001.mp3"
check(wind_raw.is_file() and hashlib.sha256(wind_raw.read_bytes()).hexdigest()
      == "85038d052ef46f6f73b341b321965b3ea447dfbf92f3f6c79d8b303778d7e6fc",
      "Retained Stable Audio desert-wind raw source hash is stable")
wind_seedthree = generated_wind / "wind_desert_seedthree.wav"
check(wind_seedthree.is_file() and hashlib.sha256(wind_seedthree.read_bytes()).hexdigest()
      == "c52505d825462791436cc5b0f5422c8215503fe115d32049190d32438b56acf0",
      "Exact SeedThree desert-wind loop is retained before DC recentering")
check((generated_wind / "SeedThree_audio_README.txt").is_file()
      and (generated_wind / "SeedThree_LICENSE.txt").is_file(),
      "SeedThree audio notes and MIT project license are retained separately")
for name, expected_hash in RUNTIME_AMBIENCE_HASHES.items():
    runtime_asset = AUDIO_ROOT / name
    check(runtime_asset.is_file() and hashlib.sha256(runtime_asset.read_bytes()).hexdigest()
          == expected_hash, f"Runtime ambience derivative hash is stable: {name}")
for retained in ["fantozzi", "corsica", "landing", "ylmir", "yd", "kenney",
                 "themightyglider", "thunder"]:
    check((AUDIO_ROOT / "cc0_sources" / retained).is_dir(),
          f"Retained CC0 source folder exists: {retained}")

stone_source_root = AUDIO_ROOT / "cc0_sources" / "fantozzi"
for runtime_name, source_name, expected_hash in STONE_SOURCES:
    source = stone_source_root / source_name
    check(source.is_file(), f"Retained Fantozzi source exists: {source_name}")
    if source.is_file():
        check(hashlib.sha256(source.read_bytes()).hexdigest() == expected_hash,
              f"Retained Fantozzi source hash is stable: {source_name}")
    runtime = AUDIO_ROOT / runtime_name
    check(runtime.is_file()
          and hashlib.sha256(runtime.read_bytes()).hexdigest()
          == STONE_RUNTIME_HASHES[runtime_name],
          f"Runtime stone derivative hash is exact: {runtime_name}")

check(STONE_BUILDER.is_file(), "Reproducible real-stone builder is retained")
stone_builder_source = STONE_BUILDER.read_text(encoding="utf-8") if STONE_BUILDER.is_file() else ""
source_positions = [
    stone_builder_source.find(source_name)
    for _, source_name, _ in STONE_SOURCES
]
check(all(position >= 0 for position in source_positions)
      and source_positions == sorted(source_positions),
      "Stone builder fixes source order to L1, R1, L2, R2")
check("pan=mono|c0=0.5*c0+0.5*c1" in stone_builder_source
      and "highpass=f=30:p=1" in stone_builder_source
      and "lowpass=f=15000:p=1" in stone_builder_source
      and '"-ar", "48000", "-ac", "1"' in stone_builder_source
      and '"-serial_offset", str(100 + index)' in stone_builder_source,
      "Stone builder fixes dry mono 48 kHz filtering and deterministic Ogg output")
for forbidden in ["atrim", "atempo", "rubberband", "acompressor", "compand",
                  "aecho", "afir", "loudnorm"]:
    check(forbidden not in stone_builder_source,
          f"Stone builder does not use {forbidden}")

metrics: dict[str, dict[str, float | int | str | np.ndarray]] = {}
for name in FILES:
    path = AUDIO_ROOT / name
    metadata = probe(path)
    samples = decode(path, int(metadata["channels"]))
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples * samples)))
    dc = float(np.mean(samples))
    active = active_rms(samples)
    trim = RUNTIME_TRIMS.get(name, 1.0)
    integrated, lra, true_peak = loudness(path)
    sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    metrics[name] = {
        **metadata, "samples": samples, "peak": peak, "rms": rms, "dc": dc,
        "active_rms": active, "trim": trim, "adjusted_peak": peak * trim,
        "adjusted_active_rms": active * trim, "lufs": integrated, "lra": lra,
        "true_peak": true_peak, "sha256": sha256,
    }
    check(metadata["codec"] == EXPECTED_CODECS[name], f"{name} uses its authored codec",
          str(metadata["codec"]))
    check(metadata["sample_rate"] == EXPECTED_SAMPLE_RATES[name],
          f"{name} decodes at its authored sample rate", str(metadata["sample_rate"]))
    check(metadata["channels"] == EXPECTED_CHANNELS[name], f"{name} has authored channel count",
          str(metadata["channels"]))
    check(validate_duration(name, float(metadata["duration"])), f"{name} duration is in its authored range",
          f"{metadata['duration']:.3f} s")
    check(np.isfinite(samples).all(), f"{name} contains only finite decoded samples")
    check(abs(dc) < 0.001, f"{name} has negligible DC offset", f"{dc:+.7f}")
    check(peak * trim < 0.85, f"{name} post-trim sample peak retains headroom",
          f"{db(peak * trim):.2f} dBFS")

gravel_hot = metrics["footstep_gravel_04.ogg"]
check(float(gravel_hot["peak"]) > 2.4, "Audit detects the retained gravel-04 raw over-level",
      f"{db(float(gravel_hot['peak'])):.2f} dBFS")
check(float(gravel_hot["adjusted_peak"]) < 0.56, "Runtime gravel-04 trim restores peak headroom",
      f"{db(float(gravel_hot['adjusted_peak'])):.2f} dBFS")

stone_tail_metrics: dict[str, dict[str, float]] = {}
for runtime_name, source_name, _ in STONE_SOURCES:
    metric = metrics[runtime_name]
    samples = metric["samples"]
    assert isinstance(samples, np.ndarray)
    sample_rate = int(metric["sample_rate"])
    tail20 = samples[-round(0.020 * sample_rate):]
    tail60 = samples[-round(0.060 * sample_rate):]
    tail20_rms = float(np.sqrt(np.mean(tail20 * tail20)))
    tail60_rms = float(np.sqrt(np.mean(tail60 * tail60)))
    active_db = db(float(metric["active_rms"]))
    peak_db = db(float(metric["peak"]))
    peak_frame = int(np.argmax(np.max(np.abs(samples), axis=1)))
    peak_time = peak_frame / sample_rate
    source_duration = float(probe(stone_source_root / source_name)["duration"])
    runtime_duration = float(metric["duration"])
    stone_tail_metrics[runtime_name] = {
        "tail20_rms_dbfs": db(tail20_rms),
        "tail60_rms_dbfs": db(tail60_rms),
        "peak_time_seconds": peak_time,
    }
    check(0.32 <= runtime_duration <= 0.38,
          f"{runtime_name} retains its compact natural one-shot duration",
          f"{runtime_duration:.6f} s")
    check(abs(runtime_duration - source_duration) <= 0.002,
          f"{runtime_name} preserves the complete source duration",
          f"source={source_duration:.6f} s runtime={runtime_duration:.6f} s")
    check(-8.5 <= peak_db <= -5.0,
          f"{runtime_name} retains conservative transient headroom",
          f"{peak_db:.2f} dBFS")
    check(-25.0 <= active_db <= -24.0,
          f"{runtime_name} active RMS is conservatively matched",
          f"{active_db:.2f} dBFS")
    check(0.002 <= peak_time <= 0.085,
          f"{runtime_name} preserves its early natural impact transient",
          f"{peak_time:.4f} s")
    check(db(tail60_rms) <= -38.0 and db(tail20_rms) <= -52.0,
          f"{runtime_name} has no sustained scrape tail",
          f"last60={db(tail60_rms):.2f}, last20={db(tail20_rms):.2f} dBFS")
    check(active_db - db(tail20_rms) >= 27.0,
          f"{runtime_name} tail decays materially below its active contact",
          f"{active_db - db(tail20_rms):.2f} dB")

family_ranges: dict[str, float] = {}
for group, maximum_spread in [
    ("sand", 2.0), ("sandstone", 2.5), ("gravel", 4.1), ("stone", 0.5),
]:
    levels = [db(float(metrics[name]["adjusted_active_rms"])) for name in GROUPS[group]]
    spread = max(levels) - min(levels)
    family_ranges[group] = spread
    check(spread <= maximum_spread, f"{group} active footstep levels remain consistent",
          f"{spread:.2f} dB")

# Calculate the maximum decoded sample peak after the exact runtime voice/bus
# gains. These are conservative reference-distance ceilings; spatial panning
# can only attenuate them farther away.
effects_bus = 0.88 * 0.78
weather_bus = 0.62 * 0.78
nearest_bird_attenuation = 22.0 / (22.0 + 0.48 * (48.0 - 22.0))
post_bus_peaks = {
    "footstep": max(float(metrics[name]["adjusted_peak"])
                    for group in ["sand", "gravel", "sandstone", "stone"]
                    for name in GROUPS[group]) * 0.22 * effects_bus,
    "landing": max(float(metrics[name]["adjusted_peak"]) for name in GROUPS["land"]) * 0.52 * effects_bus,
    "gate": max(float(metrics[name]["adjusted_peak"]) for name in GROUPS["gate"]) * 0.72 * effects_bus,
    "flashlight": max(float(metrics[name]["adjusted_peak"]) for name in GROUPS["flashlight"]) * 0.12 * effects_bus,
    "desert_wind": float(metrics[GROUPS["desert_wind"][0]]["adjusted_peak"]) * 0.06 * weather_bus,
    "desert_bird": max(float(metrics[name]["adjusted_peak"]) for name in GROUPS["desert_birds"])
                   * 0.14 * nearest_bird_attenuation * effects_bus,
    "thunder": max(float(metrics[name]["adjusted_peak"]) for name in GROUPS["thunder_close"]) * 0.88 * effects_bus,
    "rain": float(metrics[GROUPS["rain"][0]]["adjusted_peak"]) * 0.72 * 0.62 * 0.78,
}
ceilings_db = {
    "footstep": -18.0, "landing": -11.0, "gate": -8.0,
    "flashlight": -24.0, "desert_wind": -30.0, "desert_bird": -25.0,
    "thunder": -6.0, "rain": -14.0,
}
for group, peak in post_bus_peaks.items():
    check(db(peak) <= ceilings_db[group], f"{group} reference-distance runtime peak is conservative",
          f"{db(peak):.2f} dBFS")

rain = metrics["rain_desert_loop.ogg"]
rain_samples = rain["samples"]
assert isinstance(rain_samples, np.ndarray)
seam = rain_samples[0] - rain_samples[-1]
seam_rms = float(np.sqrt(np.mean(seam * seam)))
ordinary = np.diff(rain_samples, axis=0)
ordinary_delta_rms = float(np.sqrt(np.mean(ordinary * ordinary)))
ordinary_frame_delta = np.sqrt(np.mean(ordinary * ordinary, axis=1))
ordinary_larger_percent = float(np.mean(ordinary_frame_delta > seam_rms) * 100.0)
window = 72_000  # 1.5 seconds at 48 kHz
head_rms = float(np.sqrt(np.mean(rain_samples[:window] ** 2)))
tail_rms = float(np.sqrt(np.mean(rain_samples[-window:] ** 2)))
check(seam_rms <= ordinary_delta_rms, "Rain loop boundary is quieter than an ordinary decoded transition",
      f"ratio={seam_rms / ordinary_delta_rms:.3f}")
check(ordinary_larger_percent >= 25.0, "Rain loop seam is buried within ordinary transition distribution",
      f"{ordinary_larger_percent:.2f}% larger")
check(abs(db(head_rms) - db(tail_rms)) <= 1.2, "Rain loop head/tail energy is matched",
      f"{abs(db(head_rms) - db(tail_rms)):.2f} dB")
check(-21.0 <= float(rain["lufs"]) <= -20.0, "Rain integrated loudness matches its documented master",
      f"{rain['lufs']:.2f} LUFS")
check(-6.0 <= float(rain["true_peak"]) <= -5.0, "Rain true peak retains mastered headroom",
      f"{rain['true_peak']:.2f} dBTP")

wind = metrics["ambience_desert_wind.wav"]
wind_samples = wind["samples"]
assert isinstance(wind_samples, np.ndarray)
wind_seam = wind_samples[0] - wind_samples[-1]
wind_seam_rms = float(np.sqrt(np.mean(wind_seam * wind_seam)))
wind_ordinary = np.diff(wind_samples, axis=0)
wind_ordinary_delta_rms = float(np.sqrt(np.mean(wind_ordinary * wind_ordinary)))
wind_frame_delta = np.sqrt(np.mean(wind_ordinary * wind_ordinary, axis=1))
wind_ordinary_larger_percent = float(np.mean(wind_frame_delta > wind_seam_rms) * 100.0)
wind_window = 48_000  # 1.5 seconds at the authored 32 kHz
wind_head_rms = float(np.sqrt(np.mean(wind_samples[:wind_window] ** 2)))
wind_tail_rms = float(np.sqrt(np.mean(wind_samples[-wind_window:] ** 2)))
check(wind_seam_rms <= wind_ordinary_delta_rms,
      "Desert wind loop boundary is quieter than an ordinary decoded transition",
      f"ratio={wind_seam_rms / wind_ordinary_delta_rms:.3f}")
check(wind_ordinary_larger_percent >= 25.0,
      "Desert wind loop seam is buried within ordinary transition distribution",
      f"{wind_ordinary_larger_percent:.2f}% larger")
check(abs(db(wind_head_rms) - db(wind_tail_rms)) <= 1.2,
      "Desert wind loop head/tail energy is matched",
      f"{abs(db(wind_head_rms) - db(wind_tail_rms)):.2f} dB")
check(-19.2 <= float(wind["lufs"]) <= -18.2,
      "Desert wind source retains its documented quiet master",
      f"{wind['lufs']:.2f} LUFS")
check(-2.6 <= float(wind["true_peak"]) <= -2.1,
      "Desert wind source retains mastered true-peak headroom",
      f"{wind['true_peak']:.2f} dBTP")

# Gate audio is mono/HRTF-positioned and time-mapped to the exact exponential
# response constants used by the physical gate animation.
temple_source = (ROOT / "src" / "temple_real.js").read_text(encoding="utf-8")
check("gateTarget > gateProgress ? 3.8 : 2.7" in temple_source,
      "Gate animation exposes the expected open/close response constants")
check("const response = opening ? 3.8 : 2.7" in audio_source,
      "Gate audio uses the same open/close response constants")
check("panner.panningModel = 'HRTF'" in audio_source and "panner.distanceModel = 'inverse'" in audio_source,
      "Gate/thunder use HRTF inverse-distance spatial audio")
check("spatial: { refDistance: 18, maxDistance: 600, rolloffFactor: 0.25 }" in audio_source,
      "Gate machinery uses the authored local spatial falloff")

for value in metrics.values():
    value.pop("samples", None)

summary = {
    "checks": checks,
    "family_active_rms_spread_db": family_ranges,
    "post_bus_peak_dbfs": {name: round(db(value), 2) for name, value in post_bus_peaks.items()},
    "rain": {
        "boundary_delta_rms": seam_rms,
        "ordinary_delta_rms": ordinary_delta_rms,
        "ordinary_transitions_larger_percent": ordinary_larger_percent,
        "head_tail_rms_delta_db": abs(db(head_rms) - db(tail_rms)),
        "integrated_lufs": rain["lufs"],
        "true_peak_dbtp": rain["true_peak"],
    },
    "gravel_04": {
        "raw_sample_peak_dbfs": db(float(gravel_hot["peak"])),
        "runtime_trim": gravel_hot["trim"],
        "post_trim_sample_peak_dbfs": db(float(gravel_hot["adjusted_peak"])),
        "post_trim_active_rms_dbfs": db(float(gravel_hot["adjusted_active_rms"])),
        "sha256": gravel_hot["sha256"],
    },
    "stone_footsteps": {
        name: {
            "duration_seconds": metrics[name]["duration"],
            "sample_peak_dbfs": round(db(float(metrics[name]["peak"])), 2),
            "active_rms_dbfs": round(db(float(metrics[name]["active_rms"])), 2),
            **{key: round(value, 4) for key, value in stone_tail_metrics[name].items()},
            "sha256": metrics[name]["sha256"],
        }
        for name in GROUPS["stone"]
    },
    "desert_wind": {
        "duration_seconds": wind["duration"],
        "integrated_lufs": wind["lufs"],
        "true_peak_dbtp": wind["true_peak"],
        "boundary_delta_rms": wind_seam_rms,
        "ordinary_delta_rms": wind_ordinary_delta_rms,
        "ordinary_transitions_larger_percent": wind_ordinary_larger_percent,
        "head_tail_rms_delta_db": abs(db(wind_head_rms) - db(wind_tail_rms)),
        "sha256": wind["sha256"],
    },
    "desert_birds": {
        name: {
            "duration_seconds": metrics[name]["duration"],
            "sample_peak_dbfs": round(db(float(metrics[name]["peak"])), 2),
            "integrated_lufs": metrics[name]["lufs"],
            "sha256": metrics[name]["sha256"],
        }
        for name in GROUPS["desert_birds"]
    },
}

if failures:
    print(f"audio static audit: FAIL ({len(failures)} failures / {checks} checks)", file=sys.stderr)
    for failure in failures:
        print(f"- {failure}", file=sys.stderr)
    print(json.dumps(summary, indent=2), file=sys.stderr)
    raise SystemExit(1)

print(f"audio static audit: PASS ({checks} checks, CPU only)")
print(json.dumps(summary, indent=2))
