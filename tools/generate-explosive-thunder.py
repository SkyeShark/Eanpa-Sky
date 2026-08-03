"""Generate the close-strike explosive thunder claps.

The licensed CC0 thunder recordings are rolling/distant by nature; no gain or
filtering makes them read as a strike landing 35-60 m away. These three WAVs
are synthesized from scratch (procedural noise shaping, no source recordings),
so they carry no external license terms.

Layers per clap:
  1. crack  - broadband 900-11k transient, 3 ms attack, ~45 ms decay, with
              two to four re-snaps (return strokes)
  2. tear   - 250-3.5k ripping band, amplitude-rippled, ~300 ms
  3. boom   - 25-140 Hz mass plus a 60->32 Hz sweep, the chest punch
  4. rumble - 40-300 Hz tail into which the licensed rolling body blends
Sum is tanh-saturated (aggression), normalized, end-faded.

Output: assets/audio/thunder_explosive_01..03.wav (48 kHz, 16-bit stereo,
the audio suite's authored runtime format; peak -1.9 dBFS).
Deterministic per seed; rerunning reproduces byte-identical files.
"""
import wave
from pathlib import Path

import numpy as np

SR = 48000
DUR = 4.0
N = int(SR * DUR)
OUT_DIR = Path(__file__).resolve().parent.parent / 'assets' / 'audio'


def band_noise(rng, lo, hi, tilt=0.0):
    """White noise spectrally limited to [lo, hi] Hz with soft edges."""
    x = rng.standard_normal(N)
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(N, 1 / SR)
    lo_edge = 1 / (1 + np.exp(-(freqs - lo) / max(lo * 0.18, 6.0)))
    hi_edge = 1 / (1 + np.exp((freqs - hi) / max(hi * 0.12, 30.0)))
    shape = lo_edge * hi_edge
    if tilt:
        shape = shape * np.power(np.maximum(freqs, 1.0) / 1000.0, tilt)
    return np.fft.irfft(spectrum * shape, N)


def norm(x):
    peak = np.max(np.abs(x))
    return x / peak if peak > 0 else x


def envelope(attack_s, tau_s, start_s=0.0, amp=1.0):
    t = np.arange(N) / SR - start_s
    rise = np.clip(t / max(attack_s, 1e-4), 0, 1)
    fall = np.exp(-np.maximum(t, 0) / tau_s)
    out = amp * rise * fall
    out[t < 0] = 0
    return out


def synth(seed):
    rng = np.random.default_rng(seed)
    t = np.arange(N) / SR

    # Pink-tilted crack: flat white noise reads as digital/cartoon. Real
    # near-field thunder has its energy tilted down-spectrum even in the snap.
    crack = norm(band_noise(rng, 700, 10000, tilt=-0.12)) * envelope(0.002, 0.05)
    for _ in range(int(rng.integers(2, 5))):
        at = float(rng.uniform(0.008, 0.075))
        crack += (norm(band_noise(rng, 1100, 8000, tilt=-0.1))
                  * envelope(0.002, 0.035, start_s=at, amp=float(rng.uniform(0.4, 0.8))))

    # The tearing-sky rip: overlapping noise grains whose band centre falls
    # 5 kHz -> 700 Hz across ~140 ms. This descent is the signature of a
    # strike heard from tens of metres and the main anti-cartoon ingredient.
    rip = np.zeros(N)
    centers = (5000, 3400, 2300, 1550, 1050, 700)
    for slice_index, center in enumerate(centers):
        at = 0.004 + slice_index * 0.024
        rip += (norm(band_noise(rng, center * 0.62, center * 1.6))
                * envelope(0.004, 0.05, start_s=at,
                           amp=1.0 - slice_index * 0.09))

    ripple = 1 + 0.7 * np.sin(2 * np.pi * float(rng.uniform(45, 70)) * t
                              + float(rng.uniform(0, 6.28)))
    gate = np.clip(norm(band_noise(rng, 2, 20)) * 1.8 + 0.4, 0, 1)
    tear = norm(band_noise(rng, 250, 3500)) * envelope(0.004, 0.32) * ripple * gate

    sweep_hz = 60 * np.exp(-t / 0.8) + 32
    sweep = np.sin(2 * np.pi * np.cumsum(sweep_hz) / SR)
    deep_hz = 45 * np.exp(-t / 1.1) + 26
    deep = np.sin(2 * np.pi * np.cumsum(deep_hz) / SR + 1.1)
    boom = (norm(band_noise(rng, 22, 140)) * 1.0
            + sweep * 0.55 + deep * 0.45) * envelope(0.010, 1.25)

    rumble = norm(band_noise(rng, 40, 300)) * envelope(0.05, 1.8, start_s=0.25)

    mix = (crack * 0.95 + rip * 0.80 + tear * 0.58
           + boom * 1.45 + rumble * 0.30)
    mix = np.tanh(mix * 2.2)
    mix -= np.mean(mix)
    mix = norm(mix) * 0.80
    fade = int(SR * 0.3)
    mix[-fade:] *= np.linspace(1, 0, fade)
    return mix


def write_wav(path, samples):
    # Stereo with subtle width: right channel delayed ~0.9 ms at 98% gain.
    # Mono-compatible, but the clap stops sitting in a single point.
    shift = int(SR * 0.0009)
    right = np.concatenate([samples[:shift] * 0, samples[:-shift]]) * 0.98
    stereo = np.stack([samples, right], axis=1)
    pcm = np.clip(stereo * 32767, -32768, 32767).astype('<i2')
    with wave.open(str(path), 'wb') as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


if __name__ == '__main__':
    for i, seed in enumerate((911, 1213, 2718), start=1):
        out = OUT_DIR / f'thunder_explosive_{i:02d}.wav'
        write_wav(out, synth(seed))
        print(f'{out.name}: {out.stat().st_size} bytes')
