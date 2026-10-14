"""
Music analysis for the lobby relay — NumPy + SciPy only (no librosa, no numba).

Why no librosa: its steady-state cost is small, but every fresh process pays
~10-20 s of numba JIT and ~400 MB of RAM, and a few of its numba kernels hard-
crash some Windows installs. Everything here is plain vectorised NumPy/SciPy
(the DSP maths is ported from librosa's well-known algorithms), so a worker
starts in a fraction of a second and uses ~100 MB.

Input is the raw PCM the relay already caches per track (s16le / 48 kHz /
stereo, see PcmCache in server.py). Nothing here knows about Quart or the
lobby, so it can run in a worker process.

What it produces (all times are TRACK time in seconds, i.e. the same clock as
the player's position, because the cache always starts at position 0):

  tempo     BPM (+ stability, half/double alternatives)
  beats     beat times from a dynamic-programming beat tracker (Ellis 2007)
  sections  tempo changes: per-section BPM, and a beat grid that follows them
  meter     beats per bar, per-section downbeat phase, time-signature label
  key       tonic / mode / scale notes via Krumhansl-Schmuckler profiles

Honest limitations:
  * Meter is estimated from beat-synchronous accents (onset strength, bass
    onset strength and harmonic change) with a periodicity + contrast score and
    a prior that favours common meters. It is a heuristic and can confuse 2/4
    with 4/4 or 3/4 with 6/4. `confidence` says how clear the winner was.
  * Tempo CHANGES are tracked (windowed autocorrelation + Viterbi, then per-
    section beat tracking), but meter and key stay global per track. Section
    detection is tuned on synthetic audio; real music with heavy syncopation
    or half-time feel can still be mis-segmented.
  * Key uses STFT chroma (not a CQT), so low bass notes are blurrier than in
    a CQT-based tracker.
  * Compound meters (6/8, 9/8, 12/8) are inferred from a triple-vs-duple
    subdivision test on the beat grid.
"""
import os
import time

import numpy as np

try:
    import scipy.fft
    import scipy.signal
    from scipy.ndimage import maximum_filter1d, median_filter
    AVAILABLE = True
    IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - depends on the environment
    AVAILABLE = False
    IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

SRC_RATE = 48000
SR = 22050                 # analysis sample rate (147/320 of 48 kHz)
HOP = 512
N_FFT = 2048
N_MELS = 128
LOW_MELS = 10              # lowest mel bands ~ kick/bass region
CHUNK_FRAMES = 1024        # STFT frames per chunk (~24 s) to bound memory
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


def lower_priority():
    """Make this process yield to the relay. os.nice() does not exist on
    Windows, where an un-niced worker competes with the 20 ms pacing loop and
    makes the audio stutter."""
    try:
        os.nice(10)
        return
    except Exception:
        pass
    try:
        import sys
        if sys.platform == "win32":
            import ctypes
            k = ctypes.windll.kernel32
            k.SetPriorityClass(k.GetCurrentProcess(), 0x00004000)   # BELOW_NORMAL_PRIORITY_CLASS
    except Exception:
        pass


def worker_init():
    """Initializer for the analysis process pool: be nice to the relay."""
    try:
        import faulthandler
        faulthandler.enable()          # a native crash prints a traceback instead of vanishing
    except Exception:
        pass
    lower_priority()
    try:
        warmup()
    except Exception:
        pass


def warmup():
    """Build the cached filterbanks / FFT plans so the first track is not slower
    than the rest (milliseconds — there is no JIT any more)."""
    if not AVAILABLE:
        return
    rng = np.random.default_rng(0)
    y = (rng.standard_normal(SR * 10) * 0.1).astype(np.float32)
    mel, chroma = _features(y, 0.0)
    _estimate_tuning(y)
    on = _onset_strength(mel)
    _beat_track(on)


def ping():
    return True


class Timer:
    """Collects named step durations: `with t("onset envelope"): ...`"""
    def __init__(self):
        self.steps = []
        self.t0 = time.perf_counter()

    def __call__(self, name):
        outer = self

        class _Ctx:
            def __enter__(self_):
                self_.s = time.perf_counter()

            def __exit__(self_, *a):
                outer.steps.append({"name": name, "sec": round(time.perf_counter() - self_.s, 3)})
                return False
        return _Ctx()

    def total(self):
        return round(time.perf_counter() - self.t0, 3)


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


# ───────────────────────── DSP primitives (ported from librosa) ─────────────────────────
_CACHE = {}


def _hann(n):
    k = ("hann", n)
    if k not in _CACHE:
        _CACHE[k] = scipy.signal.get_window("hann", n, fftbins=True).astype(np.float32)
    return _CACHE[k]


def _stft_frames(ypad, n_fft, hop, f0, f1):
    """Complex STFT frames f0..f1 of a (centre-)padded signal -> (bins, frames)."""
    seg = ypad[f0 * hop:(f1 - 1) * hop + n_fft]
    win = np.lib.stride_tricks.sliding_window_view(seg, n_fft)[::hop][: f1 - f0]
    X = scipy.fft.rfft(win * _hann(n_fft), axis=1)
    return X.T


def _pad_center(y, n_fft, hop):
    pad = n_fft // 2
    n_total = 1 + len(y) // hop
    yp = np.pad(y, (pad, pad + n_fft), mode="constant")
    return yp, n_total


def _hz_to_mel(f):
    f = np.asarray(f, dtype=np.float64)
    f_sp = 200.0 / 3
    mel = f / f_sp
    log_t = f >= 1000.0
    return np.where(log_t, 1000.0 / f_sp + np.log(np.maximum(f, 1e-9) / 1000.0) / (np.log(6.4) / 27.0), mel)


def _mel_to_hz(m):
    m = np.asarray(m, dtype=np.float64)
    f_sp = 200.0 / 3
    f = f_sp * m
    log_t = m >= 1000.0 / f_sp
    return np.where(log_t, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 1000.0 / f_sp)), f)


def _mel_fb(n_mels=N_MELS, n_fft=N_FFT, sr=SR):
    k = ("mel", n_mels, n_fft, sr)
    if k not in _CACHE:
        mels = np.linspace(_hz_to_mel(0.0), _hz_to_mel(sr / 2.0), n_mels + 2)
        hz = _mel_to_hz(mels)
        fft_f = np.linspace(0.0, sr / 2.0, n_fft // 2 + 1)
        fdiff = np.diff(hz)
        ramps = hz[:, None] - fft_f[None, :]
        lower = -ramps[:-2] / fdiff[:-1, None]
        upper = ramps[2:] / fdiff[1:, None]
        w = np.maximum(0.0, np.minimum(lower, upper))
        w *= (2.0 / (hz[2:n_mels + 2] - hz[:n_mels]))[:, None]          # Slaney area norm
        _CACHE[k] = w.astype(np.float32)
    return _CACHE[k]


def _chroma_fb(n_fft, tuning, octave_weight=True, fmin=None, fmax=None, sr=SR):
    """(12, bins) weights folding FFT bins onto pitch classes (C = row 0)."""
    key = ("chroma", n_fft, round(float(tuning), 3), octave_weight, fmin, fmax, sr)
    if key in _CACHE:
        return _CACHE[key]
    n = 12
    freqs = np.linspace(0.0, sr / 2.0, n_fft // 2 + 1)
    a440 = 440.0 * 2.0 ** (float(tuning) / n)
    frq = n * np.log2(np.maximum(freqs[1:], 1e-9) / (a440 / 16.0))
    frq = np.concatenate([[frq[0] - 1.5 * n], frq])                      # DC bin sits 1.5 octaves below bin 1
    width = np.maximum(np.concatenate([np.diff(frq), [1.0]]), 1.0)
    D = frq[None, :] - np.arange(n)[:, None]
    D = np.mod(D + n / 2.0 + 10.0 * n, n) - n / 2.0
    w = np.exp(-0.5 * (2.0 * D / width[None, :]) ** 2)
    w /= np.maximum(np.sqrt((w ** 2).sum(axis=0, keepdims=True)), 1e-12)
    if octave_weight:
        w *= np.exp(-0.5 * ((frq / n - 5.0) / 2.0) ** 2)[None, :]
    w = np.roll(w, -3, axis=0)                                           # A -> C is row 0
    if fmin is not None or fmax is not None:
        keep = np.ones(len(freqs), dtype=bool)
        if fmin is not None:
            keep &= freqs >= fmin
        if fmax is not None:
            keep &= freqs <= fmax
        w = w * keep[None, :]
    _CACHE[key] = w.astype(np.float32)
    return _CACHE[key]


def _power_to_db(S, top_db=80.0):
    db = 10.0 * np.log10(np.maximum(S, 1e-10))
    db -= 10.0 * np.log10(max(float(S.max()), 1e-10))
    return np.maximum(db, db.max() - top_db)


def _features(y, tuning):
    """Mel power (n_mels, frames) + STFT chroma (12, frames), computed in chunks
    so memory stays bounded however long the track is."""
    yp, n_total = _pad_center(y.astype(np.float32, copy=False), N_FFT, HOP)
    fb, cfb = _mel_fb(), _chroma_fb(N_FFT, tuning)
    mels, chromas = [], []
    for f0 in range(0, n_total, CHUNK_FRAMES):
        f1 = min(f0 + CHUNK_FRAMES, n_total)
        X = _stft_frames(yp, N_FFT, HOP, f0, f1)
        P = (X.real ** 2 + X.imag ** 2).astype(np.float32)
        mels.append(fb @ P)
        c = cfb @ P
        c /= np.maximum(c.max(axis=0, keepdims=True), 1e-12)             # max-norm per frame
        chromas.append(c)
    return np.concatenate(mels, axis=1), np.concatenate(chromas, axis=1)


def _onset_strength(mel_power, lag=1):
    """Spectral-flux onset envelope (mean positive dB increase across bands)."""
    S = _power_to_db(mel_power)
    d = np.maximum(0.0, S[:, lag:] - S[:, :-lag])
    return np.pad(d.mean(axis=0), (lag, 0)).astype(np.float32)


def _pitch_tuning(freqs, resolution=0.01):
    r = np.mod(12.0 * np.log2(freqs / 440.0), 1.0)
    r = np.where(r >= 0.5, r - 1.0, r)
    hist, edges = np.histogram(r, bins=np.linspace(-0.5, 0.5, int(np.ceil(1.0 / resolution)) + 1))
    return float(edges[int(np.argmax(hist))])


def _estimate_tuning(y):
    """Tuning offset in fractions of a semitone (-0.5..0.5) from spectral peaks."""
    n_fft, hop = 4096, 2048
    yp, n_total = _pad_center(y.astype(np.float32, copy=False), n_fft, hop)
    S = np.abs(_stft_frames(yp, n_fft, hop, 0, n_total))
    freqs = np.linspace(0.0, SR / 2.0, n_fft // 2 + 1)
    a, b, c = S[:-2], S[1:-1], S[2:]
    thr = 0.1 * S.max(axis=0, keepdims=True)
    f_mid = freqs[1:-1, None]
    mask = (b > a) & (b >= c) & (b > thr) & (f_mid >= 150.0) & (f_mid < 4000.0)
    if not mask.any():
        return 0.0
    denom = a - 2.0 * b + c
    shift = np.where(denom < -1e-12, 0.5 * (a - c) / np.where(denom == 0, 1.0, denom), 0.0)
    pitch = (np.arange(1, S.shape[0] - 1)[:, None] + np.clip(shift, -0.5, 0.5)) * (SR / n_fft)
    return _pitch_tuning(pitch[mask])


# ───────────────────────── beat tracking (Ellis 2007 DP) ─────────────────────────
def _estimate_period(onset, start_bpm=120.0):
    """Global beat period (float frames) from the onset autocorrelation:
    windowed autocorrelation averaged over the track, weighted by a log-normal
    prior around `start_bpm` (one octave wide) — the same scoring librosa's
    tempo() uses, with a parabolic sub-lag refinement of the peak."""
    fps = SR / HOP
    default = fps * 60.0 / start_bpm
    win = min(384, len(onset))
    if win < 64:
        return default
    step = max(1, win // 4)
    hann = np.hanning(win)
    nfft = 1 << int(np.ceil(np.log2(2 * win)))
    acc = np.zeros(win)
    cnt = 0
    for a in range(0, max(1, len(onset) - win + 1), step):
        x = onset[a:a + win].astype(np.float64) * hann
        sp = np.fft.rfft(x, nfft)
        ac = np.fft.irfft(sp * np.conj(sp))[:win]
        m = np.abs(ac).max()
        if m > 1e-12:
            acc += ac / m
            cnt += 1
    if cnt == 0:
        return default
    acc /= cnt
    lags = np.arange(1, win)
    bpm = 60.0 * fps / lags
    ok = (bpm >= 30.0) & (bpm <= 300.0)
    prior = -0.5 * ((np.log2(bpm) - np.log2(start_bpm)) / 1.0) ** 2
    score = np.where(ok, np.log1p(1e6 * np.maximum(acc[1:], 0.0)) + prior, -np.inf)
    i = int(np.argmax(score))
    lag = float(lags[i])
    if 0 < i < len(score) - 1 and np.isfinite(score[i - 1]) and np.isfinite(score[i + 1]):
        a_, b_, c_ = score[i - 1], score[i], score[i + 1]
        d = a_ - 2 * b_ + c_
        if d < -1e-9:
            lag += float(np.clip(0.5 * (a_ - c_) / d, -0.5, 0.5))
    return lag


def _beat_dp(onset, period, tightness=100.0, trim=True):
    """Beat frames from an onset envelope for a given period (frames)."""
    n = len(onset)
    if n < 8 or period < 2:
        return np.zeros(0, dtype=int), np.zeros(n)
    sd = float(onset.std())
    env = onset / sd if sd > 1e-9 else onset.astype(np.float64)
    env = env.astype(np.float64)
    p = int(round(period))
    win = np.exp(-0.5 * (np.arange(-p, p + 1) * 32.0 / period) ** 2)
    local = np.convolve(env, win, mode="same")

    lags = np.arange(max(1, int(round(period / 2.0))), int(round(2.0 * period)) + 1)
    pen = tightness * (np.log(lags / period)) ** 2
    lo_l, hi_l = int(lags[0]), int(lags[-1])
    cum = np.zeros(n)
    back = np.full(n, -1, dtype=np.int64)
    first = True
    thresh = 0.01 * float(local.max())
    for i in range(n):
        a, b = i - hi_l, i - lo_l            # candidate predecessors a..b (inclusive)
        if b < 0:
            cum[i] = local[i]
            continue
        lo = max(a, 0)
        cand = cum[lo:b + 1] - pen[(i - np.arange(lo, b + 1)) - lo_l]
        j = int(np.argmax(cand))
        if first and local[i] < thresh:
            cum[i] = local[i]
            continue
        cum[i] = local[i] + cand[j]
        back[i] = lo + j
        first = False

    # last beat: the last local max of the cumulative score that is not weak
    mx = np.zeros(n, dtype=bool)
    mx[1:-1] = (cum[1:-1] > cum[:-2]) & (cum[1:-1] >= cum[2:])
    mx[-1] = n > 1 and cum[-1] > cum[-2]
    if not mx.any():
        return np.zeros(0, dtype=int), local
    med = float(np.median(cum[mx]))
    cand = np.nonzero(mx & (cum * 2.0 > med))[0]
    if len(cand) == 0:
        return np.zeros(0, dtype=int), local
    beats = [int(cand[-1])]
    while back[beats[-1]] >= 0:
        beats.append(int(back[beats[-1]]))
    beats = np.array(beats[::-1], dtype=int)

    if trim and len(beats) > 2:
        sm = np.convolve(local[beats], np.hanning(5), mode="same")
        th = 0.5 * float(np.sqrt((sm ** 2).mean()))
        s = 0
        while s < len(beats) and sm[s] <= th:
            s += 1
        e = len(beats)
        while e > s and sm[e - 1] <= th:
            e -= 1
        beats = beats[s:e]
    return beats, local


def _beat_track(onset, start_bpm=120.0, bpm=None, tightness=100.0, trim=True):
    """-> (period_frames, beat_frames). Pass `bpm` to skip tempo estimation."""
    fps = SR / HOP
    period = fps * 60.0 / bpm if bpm else _estimate_period(onset, start_bpm)
    return period, _beat_dp(onset, period, tightness, trim)[0]


# ───────────────────────── meter ─────────────────────────
def _z(x):
    x = np.asarray(x, dtype=np.float64)
    s = x.std()
    return (x - x.mean()) / s if s > 1e-9 else np.zeros_like(x)


def _sync_median(chroma, frames):
    """Median of chroma over each beat segment (last one runs to the end)."""
    n = chroma.shape[1]
    out = np.empty((chroma.shape[0], len(frames)), dtype=np.float64)
    for i, s in enumerate(frames):
        e = int(frames[i + 1]) if i + 1 < len(frames) else n
        seg = chroma[:, int(s):max(e, int(s) + 1)]
        out[:, i] = np.median(seg, axis=1)
    return out


def _beat_accent(onset, onset_low, chroma, beat_frames):
    """One accent value per beat: how 'strong' that beat is, combining the
    broadband onset, the bass onset and the harmonic (chord) change there."""
    n = len(beat_frames)
    on = maximum_filter1d(onset, size=5)[beat_frames]
    lo = maximum_filter1d(onset_low, size=5)[beat_frames]

    change = np.zeros(n)
    try:
        cb = _sync_median(chroma, beat_frames)
        cb = cb / np.maximum(np.sqrt((cb ** 2).sum(axis=0, keepdims=True)), 1e-12)
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


def _centre(y, seconds):
    cap = int(seconds * SR)
    if len(y) <= cap:
        return y
    s = (len(y) - cap) // 2
    return y[s:s + cap]


def _key_from_profile(profile, tuning):
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
        "tonic": names[tonic], "mode": mode, "name": f"{names[tonic]} {mode}",
        "scale": scale, "relative": f"{rel_names[rel_tonic]} {rel_mode}",
        "correlation": round(r1, 3), "confidence": round(confidence, 3),
        "tuningCents": round(tuning * 100.0, 1),
        "alternatives": [
            {"name": f"{(MAJOR_NAMES if m_ == 'major' else MINOR_NAMES)[t_]} {m_}", "r": round(r, 3)}
            for r, t_, m_ in cands[1:4]
        ],
    }


def _chroma_profile(seg, tuning, T, harmonic=False):
    """Energy-weighted chroma profile of `seg`. STFT chroma with a long window
    (bass notes need the frequency resolution). With harmonic=True a median-
    filter HPSS first strips drum energy (percussive = vertical ridges)."""
    n_fft, hop = 4096, 2048
    seg = seg.astype(np.float32, copy=False)
    yp, n_total = _pad_center(seg, n_fft, hop)
    cfb = _chroma_fb(n_fft, tuning, octave_weight=False, fmin=60.0, fmax=2400.0)
    kmax = int(np.searchsorted(np.linspace(0.0, SR / 2.0, n_fft // 2 + 1), 2400.0)) + 1
    with T("STFT chroma"):
        P = np.empty((kmax, n_total), dtype=np.float32)
        for f0 in range(0, n_total, 512):
            f1 = min(f0 + 512, n_total)
            X = _stft_frames(yp, n_fft, hop, f0, f1)[:kmax]
            P[:, f0:f1] = X.real ** 2 + X.imag ** 2
    if harmonic:
        with T("harmonic separation (median-filter HPSS)"):
            mag = np.sqrt(P)
            H = median_filter(mag, size=(1, 9), mode="reflect")        # smooth over time -> sustained tones
            Pc = median_filter(mag, size=(17, 1), mode="reflect")      # smooth over frequency -> clicks / drums
            P = P * (H >= 2.0 * Pc)
    with T("chroma fold + weighting"):
        chroma = cfb[:, :kmax] @ P
        w = np.sqrt(P.sum(axis=0)) + 1e-9                          # frame loudness
        frame = chroma / np.maximum(chroma.sum(axis=0, keepdims=True), 1e-12)
        return (frame * w[None, :]).sum(axis=1) / w.sum()


def stage_key(y, tuning=0.0, refine=False):
    """Key detection. Two passes so the answer shows up fast:
      quick  - STFT chroma straight from the mix
      refine - median-filter harmonic/percussive separation on a 60 s excerpt
               first, which removes drum energy from the chroma"""
    T = Timer()
    seg = _centre(y, 60 if refine else KEY_MAX_SECONDS)
    profile = _chroma_profile(seg, tuning, T, harmonic=bool(refine))
    with T("key profile match"):
        key = _key_from_profile(profile, tuning)
    if key:
        key["refined"] = bool(refine)
    return {"data": key, "steps": T.steps, "sec": T.total()}


# ───────────────────────── beats / tempo ─────────────────────────
ONSET_LATENCY_FRAMES = 1.0     # a flux peak lands ~n_fft/4 BEFORE the attack's own frame; calibrated on click/kick audio


def _frames_to_time(frames):
    return (np.asarray(frames, dtype=np.float64) + ONSET_LATENCY_FRAMES) * HOP / SR


def stage_beats(y):
    """PRIORITY stage: beat grid + tempo. Playback waits for this one only.
    Returns the result plus a small `state` (onset envelopes, chroma) that the
    later stages reuse, so nothing is recomputed."""
    if y.size < SR * 8:
        return {"error": "track is too short to analyse"}
    if float(np.max(np.abs(y))) < 1e-4:
        return {"error": "track is silent"}
    T = Timer()
    y = np.ascontiguousarray(y, dtype=np.float32)
    with T("tuning estimate"):
        try:
            tuning = _estimate_tuning(_centre(y, 30))
        except Exception:
            tuning = 0.0
    with T("STFT + mel + chroma"):
        mel, chroma = _features(y, tuning)
    with T("onset envelope"):
        onset = _onset_strength(mel)
        onset_low = _onset_strength(mel[:LOW_MELS])
    with T("beat tracker (DP)"):
        period, frames = _beat_track(onset, start_bpm=120.0, tightness=100.0, trim=True)
        tempo_raw = SR / HOP * 60.0 / period
        frames = np.asarray(frames, dtype=int)
        frames = frames[frames < min(len(onset), chroma.shape[1])]
    with T("beat refine + tempo"):
        beat_times = _frames_to_time(_refine_frames(onset, frames))
        data = {"durationSec": round(y.size / SR, 2), "beats": [], "tempo": None}
        if len(beat_times) >= 4:
            bpm, stability = _bpm_from_beats(beat_times, tempo_raw)
            strength = float(onset[frames].mean() / (onset.mean() + 1e-9))
            data["tempo"] = {
                "bpm": round(bpm, 2), "bpmRaw": round(tempo_raw, 2),
                "stability": round(stability, 3),       # 1 = metronomic
                "beatStrength": round(strength, 2),     # >1: beats sit on onset peaks
                "alt": [round(bpm / 2.0, 1), round(bpm * 2.0, 1)],
                "variable": False,
            }
            data["beats"] = [round(float(t), 3) for t in beat_times]
    state = {"onset": onset.astype(np.float32), "onset_low": onset_low.astype(np.float32),
             "chroma": chroma.astype(np.float32), "tuning": tuning, "tempo_raw": tempo_raw,
             "beat_times": [float(t) for t in beat_times]}
    return {"data": data, "state": state, "steps": T.steps, "sec": T.total()}


def _refine_frames(onset, frames):
    """Sub-frame beat positions (parabolic interpolation of the onset peak) so
    clicks aren't quantised to the 23 ms hop."""
    offs = np.zeros(len(frames))
    for k, f in enumerate(frames):
        if 0 < f < len(onset) - 1:
            a, b, c = onset[f - 1], onset[f], onset[f + 1]
            d = a - 2 * b + c
            if d < -1e-9:
                offs[k] = float(np.clip(0.5 * (a - c) / d, -0.5, 0.5))
    return np.asarray(frames, dtype=np.float64) + offs


def _bpm_from_beats(beat_times, fallback):
    """Steady beat grids: slope over the whole grid is far finer than any single
    interval; irregular ones fall back to the median interval."""
    if len(beat_times) < 4:
        return fallback, 1.0
    iv = np.diff(beat_times)
    med = float(np.median(iv))
    cv = float(np.std(iv) / med) if med > 0 else 0.0
    mean_iv = float((beat_times[-1] - beat_times[0]) / (len(beat_times) - 1))
    use = mean_iv if (cv < 0.05 and abs(mean_iv - med) / med < 0.01) else med
    bpm = 60.0 / use
    if len(beat_times) < 8 or abs(bpm - fallback) / fallback > 0.06:
        bpm = fallback
    return float(bpm), max(0.0, 1.0 - cv * 4.0)


# ───────────────────────── tempo changes ─────────────────────────
SEC_WIN_S = 8.0            # autocorrelation window
SEC_STEP_S = 1.0           # window hop
SEC_MIN_S = 10.0           # sections shorter than this are absorbed by a neighbour
SEC_MIN_DELTA = 0.04       # adjacent sections closer than 4 % in BPM are one section
SEC_SWITCH_COST = 8.0      # Viterbi penalty (nats) for changing tempo
SEC_KAPPA = 10.0           # sharpness of the per-window tempo evidence
SEC_PAD_S = 4.0            # beat tracking context beyond each section edge
SEC_TEMPOS = np.exp(np.linspace(np.log(70.0), np.log(200.0), 150))


def _window_tempo_scores(onset, fps, centre_bpm):
    """(windows, tempos) matrix of tempo evidence from autocorrelation of the
    onset envelope in sliding windows, with a prior that keeps the octave
    consistent with the global tempo. Returns (centres_in_frames, scores)."""
    w = int(SEC_WIN_S * fps)
    step = max(1, int(SEC_STEP_S * fps))
    n = len(onset)
    lags = 60.0 * fps / SEC_TEMPOS
    prior = np.exp(-0.5 * (np.log2(SEC_TEMPOS / centre_bpm) / 0.45) ** 2)
    centres, rows = [], []
    nfft = 1 << int(np.ceil(np.log2(2 * w)))
    xs = np.arange(w)
    for a in range(0, max(1, n - w + 1), step):
        x = onset[a:a + w].astype(np.float64)
        x = x - x.mean()
        e = float(np.dot(x, x))
        if e < 1e-9:
            rows.append(np.zeros(len(SEC_TEMPOS)))
        else:
            spec = np.fft.rfft(x, nfft)
            ac = np.fft.irfft(spec * np.conj(spec))[:w] / e
            ac = ac * (w / (w - xs))                    # unbiased
            v = np.interp(lags, xs, ac) + 0.5 * np.interp(2 * lags, xs, ac, right=0.0)
            rows.append(np.maximum(v, 0.0))
        centres.append(a + w // 2)
    sc = np.asarray(rows)
    sc = sc / (sc.max(axis=1, keepdims=True) + 1e-9) * prior[None, :]
    sc = sc / (sc.max(axis=1, keepdims=True) + 1e-9)
    return np.asarray(centres), sc


def _viterbi_tempo(sc):
    """Best tempo path with a flat switching penalty -> piecewise constant."""
    t, k = sc.shape
    ll = SEC_KAPPA * sc
    delta = ll[0].copy()
    back = np.zeros((t, k), dtype=np.int32)
    for i in range(1, t):
        best = int(np.argmax(delta))
        stay = delta
        switch = delta[best] - SEC_SWITCH_COST
        take_switch = switch > stay
        back[i] = np.where(take_switch, best, np.arange(k))
        delta = np.where(take_switch, switch, stay) + ll[i]
    path = np.zeros(t, dtype=np.int32)
    path[-1] = int(np.argmax(delta))
    for i in range(t - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return path


def _beats_in(onset, a, b, bpm):
    """Beat frames within [a, b) tracked at ~bpm (absolute frames)."""
    a, b = max(0, int(a)), min(len(onset), int(b))
    if b - a < 40:
        return np.zeros(0, dtype=int)
    _, fr = _beat_track(onset[a:b], bpm=float(bpm), tightness=100.0, trim=False)
    return np.asarray(fr, dtype=int) + a


def stage_sections(state, duration):
    """Detect tempo changes. Returns sections [{start,end,bpm,startBeat,beats}]
    and, when there is more than one, a re-tracked beat list whose grid follows
    each section's own tempo."""
    T = Timer()
    onset = state["onset"].astype(np.float64)
    fps = SR / HOP
    base_beats = state["beat_times"]
    gbpm = 60.0 / float(np.median(np.diff(base_beats))) if len(base_beats) >= 4 else state["tempo_raw"]

    def single():
        return {"data": {"sections": [{"start": 0.0, "end": round(duration, 2), "bpm": round(gbpm, 2),
                                       "startBeat": 0, "beats": len(base_beats)}],
                         "changed": False},
                "steps": T.steps, "sec": T.total()}

    if duration < 3 * SEC_MIN_S or len(onset) < int(SEC_WIN_S * fps) * 2 or len(base_beats) < 16:
        return single()

    with T("windowed tempo (autocorrelation)"):
        centres, sc = _window_tempo_scores(onset, fps, gbpm)
    if len(centres) < 6:
        return single()
    with T("tempo path (Viterbi)"):
        path = _viterbi_tempo(sc)

    # runs of constant tempo -> [start_frame, end_frame, bpm]
    runs = []
    half = int(SEC_STEP_S * fps) // 2
    for i, p in enumerate(path):
        lo = 0 if i == 0 else centres[i] - half
        hi = len(onset) if i == len(path) - 1 else centres[i] + half
        if runs and runs[-1][2] == SEC_TEMPOS[p]:
            runs[-1][1] = hi
        else:
            runs.append([lo, hi, float(SEC_TEMPOS[p])])

    def merge_close(rs):
        out = [rs[0][:]]
        for r in rs[1:]:
            last = out[-1]
            if abs(r[2] - last[2]) / last[2] < SEC_MIN_DELTA:
                wl, wr = last[1] - last[0], r[1] - r[0]
                last[2] = (last[2] * wl + r[2] * wr) / (wl + wr)
                last[1] = r[1]
            else:
                out.append(r[:])
        return out

    runs = merge_close(runs)
    # absorb too-short runs into the longer neighbour
    min_f = SEC_MIN_S * fps
    while len(runs) > 1:
        lens = [r[1] - r[0] for r in runs]
        i = int(np.argmin(lens))
        if lens[i] >= min_f:
            break
        j = i - 1 if i == len(runs) - 1 or (i > 0 and lens[i - 1] >= lens[i + 1]) else i + 1
        a, b = sorted((i, j))
        runs[a] = [runs[a][0], runs[b][1], runs[a][2] if lens[a] >= lens[b] else runs[b][2]]
        del runs[b]
        runs = merge_close(runs)
    if len(runs) < 2:
        return single()

    with T("per-section beat tracking"):
        pad = int(SEC_PAD_S * fps)
        secs = []
        for a, b, bpm0 in runs:
            fr = _beats_in(onset, a - pad, b + pad, bpm0)
            core = fr[(fr >= a) & (fr < b)]
            tt = _frames_to_time(_refine_frames(onset, core))
            bpm, _ = _bpm_from_beats(tt, bpm0)
            secs.append({"a": a, "b": b, "bpm": bpm, "frames": fr})

    with T("boundary refinement"):
        # Both trackers happily follow the audio past their own section, so
        # beat support cannot place the cut. The Viterbi edge is unbiased (the
        # window is symmetric); only nudge it (+-1.5 s) so the beat that
        # straddles the junction has an interval between the two tempos.
        cuts = [0]
        for i in range(len(secs) - 1):
            L, R = secs[i], secs[i + 1]
            edge = L["b"]
            pl, pr = 60.0 * fps / L["bpm"], 60.0 * fps / R["bpm"]
            target = 0.5 * (pl + pr)
            best_c, best_cost = edge, 1e18
            for c in np.arange(edge - int(1.5 * fps), edge + int(1.5 * fps) + 1, max(1, int(0.05 * fps))):
                lb = L["frames"][L["frames"] < c]
                rb = R["frames"][R["frames"] >= c]
                if len(lb) == 0 or len(rb) == 0:
                    continue
                cost = abs((rb[0] - lb[-1]) - target) / target + 0.02 * abs(c - edge) / fps
                if cost < best_cost:
                    best_cost, best_c = cost, int(c)
            cuts.append(max(best_c, cuts[-1] + 1))
        cuts.append(len(onset))

    final, out_secs = [], []
    with T("assemble beats + section tempos"):
        for i, s in enumerate(secs):
            lo, hi = cuts[i], cuts[i + 1]
            fr = s["frames"]
            fr = fr[(fr >= lo) & (fr < hi)]
            tt = _frames_to_time(_refine_frames(onset, fr))
            core = tt[2:-2] if len(tt) >= 10 else tt        # edge beats straddle the junction
            bpm, stab = _bpm_from_beats(core, s["bpm"])
            out_secs.append({"start": round(float(lo * HOP / SR), 2), "end": round(float(hi * HOP / SR), 2),
                             "bpm": round(bpm, 2), "startBeat": len(final), "beats": len(tt),
                             "stability": round(stab, 3)})
            final.extend(round(float(t), 3) for t in tt)
    out_secs[0]["start"] = 0.0
    out_secs[-1]["end"] = round(duration, 2)

    # drop sections that ended up with (almost) no beats, then re-merge twins
    keep = [s for s in out_secs if s["beats"] >= 4]
    if len(keep) < 2 or len(final) < 8:
        return single()
    dom = max(keep, key=lambda s: s["end"] - s["start"])
    return {"data": {"sections": out_secs, "changed": True, "beats": final,
                     "tempo": {"bpm": dom["bpm"], "variable": True,
                               "min": min(s["bpm"] for s in keep), "max": max(s["bpm"] for s in keep)}},
            "steps": T.steps, "sec": T.total()}


# ───────────────────────── meter stage ─────────────────────────
def stage_meter(state, beat_times, sections=None):
    T = Timer()
    frames = np.round(np.asarray(beat_times) * SR / HOP).astype(int)
    n = min(len(state["onset"]), state["chroma"].shape[1])
    frames = frames[(frames >= 0) & (frames < n)]
    if len(frames) < 16:
        return {"data": None, "steps": T.steps, "sec": T.total()}
    onset, onset_low, chroma = state["onset"].astype(np.float64), state["onset_low"].astype(np.float64), state["chroma"]
    with T("beat accents"):
        accent = _beat_accent(onset, onset_low, chroma, frames)
    with T("meter scoring"):
        m, phase, conf, scores = _estimate_meter(accent)
    with T("subdivision test"):
        sub, ratio = _subdivision(onset, frames)
    label = f"{m * 3}/8" if sub == "triple" and m in (2, 3, 4) else f"{m}/4"

    # Bar lines per tempo section: each section re-finds where its bars start.
    phases = [{"beat": 0, "phase": int(phase)}]
    if sections and len(sections) > 1:
        phases = []
        for s in sections:
            a, b = int(s["startBeat"]), int(s["startBeat"]) + int(s["beats"])
            seg = accent[a:b] if b <= len(accent) else accent[a:]
            if len(seg) >= 2 * m:
                means = [seg[p::m].mean() for p in range(m)]
                phases.append({"beat": a, "phase": int(np.argmax(means))})
            else:
                prev = phases[-1] if phases else {"beat": 0, "phase": int(phase)}
                phases.append({"beat": a, "phase": int((prev["phase"] + (a - prev["beat"])) % m)})
    return {"data": {
        "beatsPerBar": int(m), "label": label, "downbeatPhase": int(phase), "phases": phases,
        "confidence": round(conf, 3), "subdivision": sub, "tripleRatio": round(ratio, 2), "scores": scores,
    }, "steps": T.steps, "sec": T.total()}


# ───────────────────────── entry points ─────────────────────────
def analyze_pcm(buf):
    return analyze_mono(pcm_to_mono(buf))


def analyze_mono(y):
    """All stages back to back (tests / CLI). The server runs them as separate
    pool jobs instead so results can be pushed as soon as each one finishes."""
    if not AVAILABLE:
        return {"status": "unavailable", "reason": f"numpy/scipy are not installed ({IMPORT_ERROR})"}
    t0 = time.perf_counter()
    y = np.ascontiguousarray(y, dtype=np.float32)
    b = stage_beats(y)
    if "error" in b:
        return {"status": "error", "reason": b["error"]}
    out = {"status": "ready", **b["data"], "meter": None, "key": None, "sections": None}
    timings = {"beats": b["steps"]}
    beats = b["data"]["beats"]
    sec = stage_sections(b["state"], b["data"]["durationSec"]) if beats else None
    if sec:
        timings["sections"] = sec["steps"]
        out["sections"] = sec["data"]["sections"]
        if sec["data"]["changed"]:
            beats = sec["data"]["beats"]
            out["beats"] = beats
            out["tempo"].update(sec["data"]["tempo"])
    m = stage_meter(b["state"], beats, out["sections"])
    timings["meter"] = m["steps"]
    out["meter"] = m["data"]
    for refine in (False, True):
        k = stage_key(y, b["state"]["tuning"], refine)
        timings["key-refine" if refine else "key"] = k["steps"]
        out["key"] = k["data"] or out["key"]
    out["timings"] = timings
    out["analysisSec"] = round(time.perf_counter() - t0, 2)
    return out