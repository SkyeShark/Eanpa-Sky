#!/usr/bin/env python3
"""Rebuild the four positional stone footsteps from retained CC0 recordings.

The complete Fantozzi L1/R1/L2/R2 contacts are preserved. Processing is
deliberately limited to a centered mono downmix, light first-order bandwidth
cleanup, short boundary fades, fixed gain, 48 kHz resampling, and Vorbis
encoding. There is no trimming, layering, time/pitch change, compression, or
reverb.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import shutil
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "assets" / "audio" / "cc0_sources" / "fantozzi"
DEFAULT_OUTPUT_ROOT = ROOT / "assets" / "audio"

# Runtime order is intentionally the recorded gait order: L1, R1, L2, R2.
CONTACTS = (
    ("Fantozzi-StoneL1.ogg", "footstep_stone_01.ogg", -5.4, 0.366902,
     "2d85768f04a85b6068f3548b33d6e0b0424c5e62b0941042d593affd3a9555d4"),
    ("Fantozzi-StoneR1.ogg", "footstep_stone_02.ogg", -3.9, 0.350667,
     "d6949efd0255d50efe4853cc077b18e3ee96b155707ccf4199fd530aaac82d58"),
    ("Fantozzi-StoneL2.ogg", "footstep_stone_03.ogg", -5.9, 0.325633,
     "1cdd36f02590d2b968b1dd311334e71db8514d7c276e62ad474d01c26b37d4de"),
    ("Fantozzi-StoneR2.ogg", "footstep_stone_04.ogg", -6.1, 0.313705,
     "075c27afbf29b7771cb01a7bf51530b835e82c56698ca5551318fa0c6b7adb9f"),
)


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=pathlib.Path,
        default=DEFAULT_OUTPUT_ROOT,
        help="output directory (defaults to assets/audio)",
    )
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise SystemExit("ffmpeg is required")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for index, (source_name, output_name, gain_db, fade_out_start, expected_hash) in enumerate(
        CONTACTS, start=1
    ):
        source = SOURCE_ROOT / source_name
        if not source.is_file():
            raise SystemExit(f"missing retained source: {source}")
        actual_hash = sha256(source)
        if actual_hash != expected_hash:
            raise SystemExit(
                f"source hash mismatch for {source_name}: {actual_hash} != {expected_hash}"
            )

        # First-order filters remove only infrasonic/DC and ultrasonic residue.
        # Full source duration and natural transient timing remain unchanged.
        filters = ",".join((
            "pan=mono|c0=0.5*c0+0.5*c1",
            "highpass=f=30:p=1",
            "lowpass=f=15000:p=1",
            "afade=t=in:st=0:d=0.0025",
            f"afade=t=out:st={fade_out_start}:d=0.006",
            f"volume={gain_db}dB",
        ))
        output = args.output_dir / output_name
        subprocess.run([
            ffmpeg,
            "-y", "-v", "error",
            "-i", str(source),
            "-map_metadata", "-1", "-vn", "-af", filters,
            "-ar", "48000", "-ac", "1",
            "-c:a", "libvorbis", "-q:a", "5", "-flags:a", "+bitexact",
            "-fflags", "+bitexact", "-serial_offset", str(100 + index),
            str(output),
        ], check=True)
        print(f"{output_name}  {sha256(output)}")


if __name__ == "__main__":
    main()
