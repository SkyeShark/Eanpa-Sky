# EANPA scene audio

The live assets in this directory combine retained CC0 recordings, locally
generated Stable Audio material, and four separately licensed xeno-canto bird
recordings. The generated and xeno-canto assets are not CC0; their exact terms
and provenance are documented below. Attribution is retained for every source,
including CC0 material that does not legally require it.

## Generated flashlight clicks

`flashlight_click_on.ogg` and `flashlight_click_off.ogg` were generated locally
with the installed `stable_audio_3_medium_base.safetensors` checkpoint in
ComfyUI 0.28.0. They are generated assets, not CC0 recordings, and are not
included under `cc0_sources/`. The local checkpoint did not expose embedded
license metadata; confirm the checkpoint's distribution terms before shipping
these two files outside this project.

The reproducible workflow used `t5gemma_b_b_ul2.safetensors` as a
`stable_audio` text encoder, a 2.0-second latent, 50 steps, CFG 7, LCM sampler,
simple scheduler, and denoise 1.0. The shared negative prompt was:

> music, melody, beat, rhythm, instruments, speech, voice, ambience, room tone,
> wind, hum, electrical buzz, electronic beep, UI chime, science-fiction tone,
> multiple clicks, double click, echo, reverb, long decay, loud impact,
> distortion, clipping

The authored generations were:

- On, seed `7162612`: “A single isolated soft handheld flashlight push-button
  switch turning on: one small close-miked tactile plastic-and-metal click with
  a light crisp downward press, subtly brighter pitch, rounded quiet transient,
  tiny damped mechanical body, dry centered Foley, silence before and after.
  Length: 2 seconds”
- Off, seed `7162613`: “A single isolated soft handheld flashlight push-button
  switch turning off: one small close-miked tactile plastic-and-metal release
  click, subtly lower and duller than the on click, rounded quiet transient,
  tiny damped spring body, dry centered Foley, silence before and after. Length:
  2 seconds”

Both raw 44.1 kHz stereo generations contained several events. The final on
asset isolates 0.034–0.112 s; the off asset isolates 1.096–1.270 s. Each was
center-mixed to mono, de-click faded, resampled to 48 kHz, modestly normalized,
and encoded as Ogg/Vorbis q5. Decoded peaks are -3.57 dBFS (on) and -3.73 dBFS
(off). Runtime uses a 0.12 pre-bus gain, putting either click near -25 dBFS
after the effects/master buses.

## Synthesized explosive close thunder

`thunder_explosive_01.wav` through `thunder_explosive_03.wav` are
procedural synthesis created for this project — no source recordings
and no external license terms. Runtime plays them only for strikes
within 150 m; distant strikes keep the CC0 recordings and their
speed-of-sound start delay.

## Real CC0 stone footsteps

`footstep_stone_01.ogg` through `footstep_stone_04.ogg` are dedicated
ziggurat, stair, and Inanna-dais contacts derived from Fantozzi's real
boot-on-stone recordings. The retained inputs are included under
`cc0_sources/fantozzi/` and are CC0. Runtime order preserves the recorded gait
variations exactly: StoneL1, StoneR1, StoneL2, StoneR2.

| Runtime asset | Complete retained source | Source SHA-256 | Gain |
| --- | --- | --- | --- |
| `footstep_stone_01.ogg` | `Fantozzi-StoneL1.ogg` | `2d85768f04a85b6068f3548b33d6e0b0424c5e62b0941042d593affd3a9555d4` | -5.4 dB |
| `footstep_stone_02.ogg` | `Fantozzi-StoneR1.ogg` | `d6949efd0255d50efe4853cc077b18e3ee96b155707ccf4199fd530aaac82d58` | -3.9 dB |
| `footstep_stone_03.ogg` | `Fantozzi-StoneL2.ogg` | `1cdd36f02590d2b968b1dd311334e71db8514d7c276e62ad474d01c26b37d4de` | -5.9 dB |
| `footstep_stone_04.ogg` | `Fantozzi-StoneR2.ogg` | `075c27afbf29b7771cb01a7bf51530b835e82c56698ca5551318fa0c6b7adb9f` | -6.1 dB |

The reproducible export keeps
each complete 0.32-0.37 second contact and its natural transient, center-mixes
to mono for positional playback, resamples to 48 kHz, applies first-order
30 Hz high-pass and 15 kHz low-pass filters, adds a 2.5 ms input fade and 6 ms
output fade, removes metadata, and encodes Ogg/Vorbis q5. Gains only
conservatively match active RMS. There is no event trimming, layering,
time-stretching, pitch shifting, compression, normalization, reverb, or added
tail.

## SeedThree desert ambience

The desert ambience was imported read-only from the user's local
`SeedThree` project. SeedThree's MIT license covers its code and documentation;
it does not replace the separate licenses attached to the bird recordings.

### Desert wind

`ambience_desert_wind.wav` derives from SeedThree's locally generated Stable
Audio 3 wind. The retained raw generation is
`generated_sources/seedthree_desert_wind/wind_desert_raw_00001.mp3` and has
SHA-256
`85038d052ef46f6f73b341b321965b3ea447dfbf92f3f6c79d8b303778d7e6fc`.
Its exact workflow was:

- `stable_audio_3_medium_base.safetensors` checkpoint
- `t5gemma_b_b_ul2.safetensors` `stable_audio` text encoder
- seed `1924920684`; 22.0-second latent; 50 steps; CFG 7; LCM sampler;
  simple scheduler; denoise 1.0; empty negative prompt
- Prompt: “Dry desert wind blowing steadily across open sand and rocky
  terrain, soft continuous airy hiss with distant hollow gusts, sparse arid
  outdoor wind ambience, no music, no birds, no voices. Length: 22 seconds”

SeedThree flattened and overlap-looped that source into its 17.05-second,
32 kHz mono PCM WAV. The exact SeedThree loop is retained as
`generated_sources/seedthree_desert_wind/wind_desert_seedthree.wav` with
SHA-256
`c52505d825462791436cc5b0f5422c8215503fe115d32049190d32438b56acf0`.
That source had a -0.0565026 DC bias. Eanpa's runtime WAV differs only by a
constant +0.0565026 DC recenter and metadata removal; no spectral filter,
resampling, compression, or lossy encoding was added, and the loop boundary
delta is unchanged. The local checkpoint exposed no embedded license metadata,
so confirm its distribution terms before shipping this generated wind outside
the project.

### Desert birds

The four runtime MP3s are byte-identical copies of SeedThree's trimmed,
normalized 32 kHz mono derivatives. Their original xeno-canto downloads are
retained under `licensed_sources/xeno_canto_desert/`.

| Runtime asset | Recording and recordist | Recording license |
| --- | --- | --- |
| `bird_cactus_wren_01.mp3` | [XC543301](https://xeno-canto.org/543301), Cactus Wren, Isain Contreras Rodríguez | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `bird_cactus_wren_02.mp3` | [XC920390](https://xeno-canto.org/920390), Cactus Wren, Leonardo Guzman Hernandez | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `bird_roadrunner_01.mp3` | [XC163986](https://xeno-canto.org/163986), Greater Roadrunner, Paul Marvin | [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/) |
| `bird_roadrunner_02.mp3` | [XC254875](https://xeno-canto.org/254875), Greater Roadrunner, Richard E. Webster | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |

The NonCommercial and ShareAlike restrictions apply to these recordings and
their derivatives. They must not be treated as CC0; commercial distribution
requires separate permission from the recordists. Catalogue IDs and recordists
come from the files' embedded xeno-canto metadata. The media-license fields
were cross-checked through GBIF's xeno-canto occurrence mirror:
[XC543301](https://www.gbif.org/occurrence/2848584123),
[XC920390](https://www.gbif.org/occurrence/4907344188),
[XC163986](https://www.gbif.org/occurrence/2243592559), and
[XC254875](https://www.gbif.org/occurrence/2243665944).

## Sources

| Use | Source | License |
| --- | --- | --- |
| Sand, sandstone, and ziggurat stone footsteps | [Fantozzi's Footsteps (Grass/Sand & Stone)](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | CC0 |
| Gravel footsteps | [42 Snow and Gravel Footsteps](https://opengameart.org/content/42-snow-and-gravel-footsteps) by Corsica_S / qubodup | CC0 |
| Desert wind | Local Stable Audio 3 generation imported from SeedThree | Generated; checkpoint terms require confirmation |
| Desert bird calls | XC543301, XC920390, XC163986, and XC254875 on [xeno-canto](https://xeno-canto.org/) | CC BY-NC-SA 3.0/4.0 per recording |
| Landing | [Jump Landing Sound](https://opengameart.org/content/jump-landing-sound) by MentalSanityOff / qubodup | CC0 |
| Rain bed | [Rain (loopable)](https://opengameart.org/content/rain-loopable) by Ylmir | CC0 |
| Sliding gate and cog layers | [Platformer Sounds](https://opengameart.org/content/platformer-sounds-terminal-interaction-door-shots-bang-and-footsteps) by yd | CC0 |
| Gate latch/close layers | [Kenney RPG Audio](https://www.kenney.nl/assets/rpg-audio) | CC0 |
| Gate body layer | [Iron Door](https://opengameart.org/content/iron-door) by themightyglider | CC0 |
| Close/distant thunder A | [Thunder big](https://freesound.org/people/s-light/sounds/414050/) by s-light | CC0 |
| Close/distant thunder B | [Thunder](https://freesound.org/people/Fission9/sounds/465314/) by Fission9 | CC0 |
| Explosive close-strike thunder | Procedural synthesis created for this project (no source recordings) | No external terms |

The exact downloaded inputs used for the current exports are retained under
cc0_sources/, including the public HQ Freesound preview encodes whose source
pages state CC0. Do not replace a source without adding its license page here.
The non-CC0 bird originals live separately under
`licensed_sources/xeno_canto_desert/`; generated wind inputs and SeedThree's
audio notes live under `generated_sources/seedthree_desert_wind/`.

## Processing

- Four real contacts per retained CC0 surface are high/low-pass filtered and
  conservatively level-matched. Sand, sandstone, and dedicated ziggurat stone
  preserve the Fantozzi left/right variations;
  gravel uses four separate Corsica_S contacts. The retained fourth gravel
  source is intrinsically about 12 dB hotter than its siblings and its current
  derivative decodes at +7.91 dBFS, so runtime applies a non-destructive 0.22
  trim to that file. The processed CC0 asset remains byte-for-byte retained.
- Soft/medium/heavy landings use one real contact with different bandwidth,
  pitch, and level. Runtime fall velocity chooses the tier and uses a maximum
  pre-bus gain of 0.52.
- Gate open/close combine the CC0 sliding barrier, cog, latch, and iron-door
  contacts. The source remains mono for correct HRTF placement at the authored
  moving leaf. Runtime maps buffer time to actual gate progress and uses a
  0.72 pre-bus gain.
- The rain source is rotated around a quiet interior point. Its final 1.5 s
  equal-power overlap joins the source tail to its head, while both ends of
  the exported 43.5 s loop meet at the same original interior timestamp.
  Decoded validation at 48 kHz measured a boundary delta of 0.02929 versus
  0.03006 RMS for ordinary adjacent samples; 31.25% of ordinary transitions
  are larger. The master is -20.4 LUFS, 1.6 LU LRA, and -5.4 dBTP.
- Three close and three low-passed distant thunder events are cut only at
  quiet boundaries and de-click faded. Runtime keeps their world position and
  speed-of-sound delay tied to the actual lightning strike.
- The desert wind is a continuous gapless WAV loop. It fades to a 0.06
  pre-weather-bus gain after audio unlock; the weather and master buses reduce
  its effective source amplitude to about 0.029, keeping it a subtle bed.
- SeedThree scheduled desert birds every 8–24 seconds. Eanpa waits 70–150
  seconds for the first call and then leaves a randomized 140–320-second quiet
  gap after each call—about fourteen times SeedThree's average interval. An
  exact clip cannot repeat immediately. Calls originate 48–105 metres away,
  use a 0.08–0.14 pre-bus gain, HRTF inverse-distance falloff, light distance
  filtering, and are deferred through another long gap during material rain.

Runtime behavior lives in src/audio_system.js. The AudioContext still opens
only after a trusted gesture; rain follows live precipitation, footsteps
follow grounded stride phase and authored surface information, and the
gate/thunder use spatial Web Audio panners. `temple.walkSurfaceTypeAt()`
routes the ziggurat, its stairs, and the Inanna dais to the real CC0 stone
family. Ordinary terrain defaults to gravel, with sand restricted to the
terrain ecology wash mask. Desert wind starts continuously once its own buffer
decodes; bird calls use the sparse long-gap scheduler described above.
Flashlight clicks are non-spatial player feedback; the latest toggle is queued
while its priority asset decodes so the first gesture is not lost.
