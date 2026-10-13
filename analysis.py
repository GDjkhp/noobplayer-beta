"""
Music analysis (librosa) for the lobby relay.

Input is the raw PCM the relay already caches per track (s16le / 48 kHz /
stereo, see PcmCache in server.py). Everything here is pure numpy/librosa and
has no knowledge of Quart or the lobby, so it can run in a worker process.

What it produces (all times are TRACK time in seconds, i.e. the same clock as
the player's position, because the cache always starts at position 0):

  tempo   global BPM (+ stability, half/double alternatives)
  beats   beat times from librosa's dynamic-programming beat tracker
  meter   beats per bar, downbeat phase, time-signature label, confidence
  key     tonic / mode / scale notes via Krumhansl-Schmuckler profiles

Honest limitations (librosa has no downbeat tracker):
  * Meter is estimated from beat-synchronous accents (onset strength, bass
    onset strength and harmonic change) with a periodicity + contrast score and
    a prior that favours common meters. It is a heuristic and can confuse 2/4
    with 4/4 or 3/4 with 6/4. `confidence` says how clear the winner was.
  * One global meter / key / tempo per track; changes mid-track are not tracked.
  * Compound meters (6/8, 9/8, 12/8) are inferred from a triple-vs-duple
    subdivision test on the beat grid.
"""
import os
import time

import numpy as np

try:
    import librosa
    import scipy.signal
    from scipy.ndimage import maximum_filter1d
    AVAILABLE = True
    IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - depends on the environment
    librosa = None
    AVAILABLE = False
    IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

SRC_RATE = 48000
SR = 22050                 # analysis sample rate (147/320 of 48 kHz)
HOP = 512
N_FFT = 2048
N_MELS = 128
LOW_MELS = 10              # lowest mel bands ~ kick/bass region
CHUNK_FRAMES = 2048        # STFT frames per chunk (~47 s) to bound memory
KEY_MAX_SECONDS = 240      # key is estimated from (at most) this much, centred

NOTES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
# Conventional key names (what a musician would write for the tonic).
MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]
FLAT_MAJOR_TONICS = {5, 10, 3, 8, 1}          # F, Bb, Eb, Ab, Db spell with flats
MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10]          # natural minor

# Krumhansl-Kessler key profiles.
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Prior over beats-per-bar: common meters are far more likely a priori.
METER_PRIORS = {2: 0.80, 3: 0.92, 4: 1.00, 5: 0.55, 6: 0.60, 7: 0.50}


def worker_init():
    """Initializer for the analysis process pool: be nice to the relay."""
    try:
        os.nice(10)
    except Exception:
        pass


# ───────────────────────── PCM → mono 22.05 kHz ─────────────────────────
def pcm_to_mono(buf):
    """s16le/48k/stereo bytes-like → float32 mono at SR. Chunked so a long
    track never needs a full float copy at 48 kHz."""
    a = np.frombuffer(buf, dtype="<i2")
    frames = a.size // 2
    a = a[: frames * 2]
    step = SRC_RATE * 30
    out = []
    for s in range(0, frames, step):
        seg = a[s * 2:(s + step) * 2]
        mono = (seg[0::2].astype(np.float32) + seg[1::2].astype(np.float32)) * (0.5 / 32768.0)
        out.append(scipy.signal.resample_poly(mono, 147, 320).astype(np.float32))
    return np.concatenate(out) if out else np.zeros(0, np.float32)


# ───────────────────────── features ─────────────────────────
def _features(y, tuning):
    """Mel power + STFT chroma, computed in chunks with context so frame j is
    exactly librosa's global frame j (centre = j*HOP)."""
    n_total = 1 + len(y) // HOP
    mels, chromas = [], []
    for f0 in range(0, n_total, CHUNK_FRAMES):
        f1 = min(f0 + CHUNK_FRAMES, n_total)
        start = max(0, f0 * HOP - N_FFT)
        end = min(len(y), f1 * HOP + N_FFT)
        S = np.abs(librosa.stft(y[start:end], n_fft=N_FFT, hop_length=HOP)) ** 2
        off = (f0 * HOP - start) // HOP
        S = S[:, off: off + (f1 - f0)]
        mels.append(librosa.feature.melspectrogram(S=S, sr=SR, n_mels=N_MELS).astype(np.float32))
        chromas.append(librosa.feature.chroma_stft(S=S, sr=SR, tuning=tuning, n_chroma=12).astype(np.float32))
    return np.concatenate(mels, axis=1), np.concatenate(chromas, axis=1)


def _z(x):
    x = np.asarray(x, dtype=np.float64)
    s = x.std()
    return (x - x.mean()) / s if s > 1e-9 else np.zeros_like(x)


# ───────────────────────── meter ─────────────────────────
def _beat_accent(onset, onset_low, chroma, beat_frames):
    """One accent value per beat: how 'strong' that beat is, combining the
    broadband onset, the bass onset and the harmonic (chord) change there."""
    n = len(beat_frames)
    on = maximum_filter1d(onset, size=5)[beat_frames]
    lo = maximum_filter1d(onset_low, size=5)[beat_frames]

    change = np.zeros(n)
    try:
        cb = librosa.util.sync(chroma, beat_frames, aggregate=np.median, pad=False)
        cb = librosa.util.normalize(cb, norm=2, axis=0)
        k = cb.shape[1]
        if k >= 2:
            sim = np.sum(cb[:, :-1] * cb[:, 1:], axis=0)    # seg i vs seg i+1 → change at beat i+1
            change[1:k] = 1.0 - sim
            fill = change[1:k].mean()
            change[0] = fill
            change[k:] = fill
    except Exception:
        pass
    return _z(_z(on) + _z(lo) + 0.7 * _z(change))


def _estimate_meter(accent):
    n = len(accent)
    scores, phases = {}, {}
    for m, prior in METER_PRIORS.items():
        if n < m * 4:
            continue
        acs = []
        for lag in (m, 2 * m):
            if n - lag >= 6:
                a, b = accent[:-lag], accent[lag:]
                if a.std() > 1e-9 and b.std() > 1e-9:
                    acs.append(float(np.corrcoef(a, b)[0, 1]))
        periodicity = float(np.mean(acs)) if acs else 0.0
        means = np.array([accent[p::m].mean() for p in range(m)])
        p = int(np.argmax(means))
        contrast = float(means[p] - (means.sum() - means[p]) / (m - 1))
        scores[m] = (max(periodicity, 0.0) + 0.5 * max(contrast, 0.0)) * prior
        phases[m] = p
    if not scores:
        return 4, 0, 0.0, {}
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best_m, best = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    conf = 0.0 if best <= 0.05 else float(np.clip((best - second) / best, 0.0, 1.0))
    return best_m, phases[best_m], conf, {str(m): round(float(s), 4) for m, s in scores.items()}


def _subdivision(onset, beat_frames):
    """'triple' if the beat is divided in three (6/8-style), else 'duple'."""
    if len(beat_frames) < 8:
        return "duple", 0.0
    env = maximum_filter1d(onset, size=3)
    xs = np.arange(len(env))
    gaps = np.diff(beat_frames).astype(np.float64)
    base = beat_frames[:-1].astype(np.float64)

    def at(frac):
        return float(np.interp(base + frac * gaps, xs, env).mean())

    duple = at(0.5)
    triple = 0.5 * (at(1 / 3) + at(2 / 3))
    ratio = triple / (duple + 1e-9)
    if max(triple, duple) < 0.15 * at(0.0):        # no real subdivision energy: nothing to call triple
        return "duple", float(ratio)
    return ("triple" if ratio > 1.35 else "duple"), float(ratio)


# ───────────────────────── key ─────────────────────────
def _spell(pc, flats):
    return (NOTES_FLAT if flats else NOTES_SHARP)[pc % 12]


def _estimate_key(y, tuning):
    seg = y
    cap = KEY_MAX_SECONDS * SR
    if len(seg) > cap:
        s = (len(seg) - cap) // 2
        seg = seg[s:s + cap]
    yh = librosa.effects.harmonic(seg, margin=2.0)
    hop = 2048                                  # must be a multiple of 2**(n_octaves-1)
    chroma = librosa.feature.chroma_cqt(y=yh, sr=SR, hop_length=hop, tuning=tuning, n_chroma=12)
    rms = librosa.feature.rms(y=yh, frame_length=4096, hop_length=hop)[0]
    t = min(chroma.shape[1], len(rms))
    w = rms[:t] + 1e-9
    profile = (chroma[:, :t] * w).sum(axis=1) / w.sum()
    if profile.std() < 1e-9:
        return None

    cands = []
    for tonic in range(12):
        cands.append((float(np.corrcoef(np.roll(KK_MAJOR, tonic), profile)[0, 1]), tonic, "major"))
        cands.append((float(np.corrcoef(np.roll(KK_MINOR, tonic), profile)[0, 1]), tonic, "minor"))
    cands.sort(reverse=True)
    r1, tonic, mode = cands[0]

    rel_tonic = (tonic + 3) % 12 if mode == "minor" else (tonic + 9) % 12
    rel_mode = "major" if mode == "minor" else "minor"
    # Runner-up that is NOT the relative key (relative keys share every note,
    # so they are always close and say nothing about how sure we are).
    r2 = next((r for r, t_, m_ in cands[1:] if not (t_ == rel_tonic and m_ == rel_mode)), 0.0)
    confidence = float(np.clip((r1 - r2) / 0.15, 0.0, 1.0))

    major_tonic = tonic if mode == "major" else (tonic + 3) % 12
    flats = major_tonic in FLAT_MAJOR_TONICS
    steps = MAJOR_STEPS if mode == "major" else MINOR_STEPS
    scale = [_spell(tonic + s, flats) for s in steps]
    names = MAJOR_NAMES if mode == "major" else MINOR_NAMES
    rel_names = MINOR_NAMES if rel_mode == "minor" else MAJOR_NAMES

    return {
        "tonic": names[tonic],
        "mode": mode,
        "name": f"{names[tonic]} {mode}",
        "scale": scale,
        "relative": f"{rel_names[rel_tonic]} {rel_mode}",
        "correlation": round(r1, 3),
        "confidence": round(confidence, 3),
        "tuningCents": round(tuning * 100.0, 1),
        "alternatives": [
            {"name": f"{(MAJOR_NAMES if m_ == 'major' else MINOR_NAMES)[t_]} {m_}", "r": round(r, 3)}
            for r, t_, m_ in cands[1:4]
        ],
    }


# ───────────────────────── entry points ─────────────────────────
def analyze_pcm(buf):
    return analyze_mono(pcm_to_mono(buf))


def analyze_mono(y):
    """Full analysis of mono float32 audio at SR. Returns a JSON-able dict."""
    if not AVAILABLE:
        return {"status": "unavailable", "reason": f"librosa is not installed ({IMPORT_ERROR})"}
    t0 = time.perf_counter()
    y = np.ascontiguousarray(y, dtype=np.float32)
    if y.size < SR * 8:
        return {"status": "error", "reason": "track is too short to analyse"}
    if float(np.max(np.abs(y))) < 1e-4:
        return {"status": "error", "reason": "track is silent"}
    duration = y.size / SR

    # Tuning offset (fraction of a semitone) from a centred excerpt.
    try:
        cap = 90 * SR
        ex = y if len(y) <= cap else y[(len(y) - cap) // 2:(len(y) + cap) // 2]
        tuning = float(librosa.estimate_tuning(y=ex, sr=SR))
    except Exception:
        tuning = 0.0

    mel, chroma = _features(y, tuning)
    mel_db = librosa.power_to_db(mel, ref=np.max)
    onset = librosa.onset.onset_strength(S=mel_db, sr=SR, hop_length=HOP)
    onset_low = librosa.onset.onset_strength(S=mel_db[:LOW_MELS], sr=SR, hop_length=HOP)

    tempo_raw, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset, sr=SR, hop_length=HOP, start_bpm=120.0, tightness=100, trim=True)
    tempo_raw = float(np.atleast_1d(tempo_raw)[0])
    beat_frames = np.asarray(beat_frames, dtype=int)
    beat_frames = beat_frames[beat_frames < min(len(onset), chroma.shape[1])]
    # Sub-frame refinement (parabolic peak interpolation) so click times aren't
    # quantised to the 23 ms hop.
    offs = np.zeros(len(beat_frames))
    for k, f in enumerate(beat_frames):
        if 0 < f < len(onset) - 1:
            a, b, c = onset[f - 1], onset[f], onset[f + 1]
            d = a - 2 * b + c
            if d < -1e-9:
                offs[k] = float(np.clip(0.5 * (a - c) / d, -0.5, 0.5))
    beat_times = librosa.frames_to_time(beat_frames + offs, sr=SR, hop_length=HOP)

    out = {"status": "ready", "durationSec": round(duration, 2), "beats": [], "tempo": None,
           "meter": None, "key": None}

    if len(beat_times) >= 4:
        intervals = np.diff(beat_times)
        med = float(np.median(intervals))
        # The DP tracker holds a near-constant period, so the median interval
        # is a finer tempo estimate than the (binned) tempogram value.
        cv = float(np.std(intervals) / med) if med > 0 else 0.0
        # Steady tracks: the slope over the whole beat grid is far finer than any
        # single interval; otherwise fall back to the median.
        mean_iv = float((beat_times[-1] - beat_times[0]) / (len(beat_times) - 1))
        use = mean_iv if cv < 0.05 else med
        bpm = 60.0 / use if len(beat_times) >= 8 and abs(60.0 / use - tempo_raw) / tempo_raw < 0.05 else tempo_raw
        strength = float(onset[beat_frames].mean() / (onset.mean() + 1e-9))
        out["tempo"] = {
            "bpm": round(float(bpm), 2),
            "bpmRaw": round(tempo_raw, 2),
            "stability": round(max(0.0, 1.0 - cv * 4.0), 3),    # 1 = metronomic
            "beatStrength": round(strength, 2),                 # >1: beats sit on onset peaks
            "alt": [round(bpm / 2.0, 1), round(bpm * 2.0, 1)],
        }
        out["beats"] = [round(float(t), 3) for t in beat_times]

        if len(beat_frames) >= 16:
            accent = _beat_accent(onset, onset_low, chroma, beat_frames)
            m, phase, conf, scores = _estimate_meter(accent)
            sub, ratio = _subdivision(onset, beat_frames)
            if sub == "triple" and m in (2, 3, 4):
                label = f"{m * 3}/8"
            else:
                label = f"{m}/4"
            out["meter"] = {
                "beatsPerBar": int(m), "label": label, "downbeatPhase": int(phase),
                "confidence": round(conf, 3), "subdivision": sub, "tripleRatio": round(ratio, 2),
                "scores": scores,
            }

    try:
        out["key"] = _estimate_key(y, tuning)
    except Exception as e:
        out["keyError"] = f"{type(e).__name__}: {e}"

    out["analysisSec"] = round(time.perf_counter() - t0, 2)
    return out