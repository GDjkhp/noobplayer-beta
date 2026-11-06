//! Audio analysis for the lobby relay (port of analysis.py). The DSP is the
//! standard textbook toolkit — Slaney mel filterbank, spectral-flux onset
//! envelope, autocorrelation tempo with a log-normal prior, Ellis (2007)
//! dynamic-programming beat tracking, Krumhansl-Schmuckler key profiles.
//!
//! Input is the raw PCM the relay already caches per track (s16le / 48 kHz /
//! stereo). All times are TRACK time in seconds. Nothing here knows about the
//! lobby, so it runs on the worker pool threads.
//!
//! The arithmetic mirrors numpy/scipy where it matters: float32 vs float64 per
//! array, numpy's pairwise summation, sequential axis-0 reductions, half-even
//! rounding and first-maximum argmax.

use std::f64::consts::PI;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;
use serde_json::{json, Map, Value};

use crate::util::{jf, py_round};

pub const SRC_RATE: usize = 48000;
pub const SR: usize = 22050; // analysis sample rate (147/320 of 48 kHz)
pub const HOP: usize = 512;
pub const N_FFT: usize = 2048;
pub const N_MELS: usize = 128;
pub const LOW_MELS: usize = 10; // lowest mel bands ~ kick/bass region
pub const CHUNK_FRAMES: usize = 1024; // STFT frames per chunk
pub const KEY_MAX_SECONDS: usize = 240; // key is estimated from (at most) this much, centred

const NOTES_SHARP: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTES_FLAT: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
const FLAT_MAJOR_TONICS: [usize; 5] = [5, 10, 3, 8, 1];
const MAJOR_STEPS: [usize; 7] = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS: [usize; 7] = [0, 2, 3, 5, 7, 8, 10];

const KK_MAJOR: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/// Prior over beats-per-bar: common meters are far more likely a priori.
const METER_PRIORS: [(usize, f64); 6] = [(2, 0.80), (3, 0.92), (4, 1.00), (5, 0.55), (6, 0.60), (7, 0.50)];

/// The numpy/scipy stack is always "installed" here.
#[allow(dead_code)]
pub const AVAILABLE: bool = true;

// ───────────────────────── result types ─────────────────────────

pub trait StageInfo {
    fn sec(&self) -> Option<f64>;
    fn steps(&self) -> Value;
}

pub struct StageOut {
    pub data: Value,
    pub steps: Vec<Value>,
    pub sec: f64,
}

impl StageInfo for StageOut {
    fn sec(&self) -> Option<f64> {
        Some(self.sec)
    }
    fn steps(&self) -> Value {
        Value::Array(self.steps.clone())
    }
}

/// What stage_beats leaves behind for the later stages.
pub struct BeatState {
    pub onset: Vec<f32>,
    pub onset_low: Vec<f32>,
    /// (12, n) row-major
    pub chroma: Vec<f32>,
    pub n_chroma: usize,
    pub tuning: f64,
    pub tempo_raw: f64,
    pub beat_times: Vec<f64>,
}

pub enum BeatsOut {
    Error(String),
    Ok { state: BeatState, data: Value, steps: Vec<Value>, sec: f64 },
}

impl StageInfo for BeatsOut {
    fn sec(&self) -> Option<f64> {
        match self {
            BeatsOut::Ok { sec, .. } => Some(*sec),
            _ => None,
        }
    }
    fn steps(&self) -> Value {
        match self {
            BeatsOut::Ok { steps, .. } => Value::Array(steps.clone()),
            _ => json!([]),
        }
    }
}

struct Timer {
    steps: Vec<Value>,
    t0: Instant,
}

impl Timer {
    fn new() -> Self {
        Timer { steps: vec![], t0: Instant::now() }
    }
    fn step<R>(&mut self, name: &str, f: impl FnOnce() -> R) -> R {
        let s = Instant::now();
        let r = f();
        self.steps.push(json!({"name": name, "sec": jf(py_round(s.elapsed().as_secs_f64(), 3))}));
        r
    }
    fn total(&self) -> f64 {
        py_round(self.t0.elapsed().as_secs_f64(), 3)
    }
}

// ───────────────────────── numpy-flavoured helpers ─────────────────────────

/// numpy's pairwise summation (float64).
fn pw64(a: &[f64]) -> f64 {
    let n = a.len();
    if n < 8 {
        let mut res = 0.0;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - (n % 8) {
            for j in 0..8 {
                r[j] += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pw64(&a[..n2]) + pw64(&a[n2..])
    }
}

/// numpy's pairwise summation (float32).
fn pw32(a: &[f32]) -> f32 {
    let n = a.len();
    if n < 8 {
        let mut res = 0.0f32;
        for &v in a {
            res += v;
        }
        res
    } else if n <= 128 {
        let mut r = [a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]];
        let mut i = 8;
        while i < n - (n % 8) {
            for j in 0..8 {
                r[j] += a[i + j];
            }
            i += 8;
        }
        let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        while i < n {
            res += a[i];
            i += 1;
        }
        res
    } else {
        let mut n2 = n / 2;
        n2 -= n2 % 8;
        pw32(&a[..n2]) + pw32(&a[n2..])
    }
}

fn mean64(a: &[f64]) -> f64 {
    pw64(a) / a.len() as f64
}

fn std64(a: &[f64]) -> f64 {
    let m = mean64(a);
    let sq: Vec<f64> = a.iter().map(|&v| (v - m) * (v - m)).collect();
    (pw64(&sq) / a.len() as f64).sqrt()
}

fn std32(a: &[f32]) -> f32 {
    let n = a.len() as f32;
    let m = pw32(a) / n;
    let sq: Vec<f32> = a.iter().map(|&v| (v - m) * (v - m)).collect();
    (pw32(&sq) / n).sqrt()
}

/// np.linspace(start, stop, num)
fn linspace(start: f64, stop: f64, num: usize) -> Vec<f64> {
    if num == 1 {
        return vec![start];
    }
    let div = (num - 1) as f64;
    let step = (stop - start) / div;
    let mut v: Vec<f64> = (0..num).map(|i| i as f64 * step + start).collect();
    v[num - 1] = stop;
    v
}

/// np.argmax (first maximum)
fn argmax64(a: &[f64]) -> usize {
    let mut bi = 0;
    for (i, &v) in a.iter().enumerate() {
        if v > a[bi] {
            bi = i;
        }
    }
    bi
}

/// np.median
fn median64(a: &[f64]) -> f64 {
    let mut v = a.to_vec();
    v.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// np.convolve(a, b, mode="same")
fn convolve_same(a: &[f64], b: &[f64]) -> Vec<f64> {
    let (l, s) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    let off = (s.len() - 1) - s.len() / 2;
    let mut out = vec![0.0; l.len()];
    for (o, slot) in out.iter_mut().enumerate() {
        let k = o + off;
        let lo = k.saturating_sub(s.len() - 1);
        let hi = k.min(l.len() - 1);
        let mut acc = 0.0;
        if lo <= hi {
            for i in lo..=hi {
                acc += l[i] * s[k - i];
            }
        }
        *slot = acc;
    }
    out
}

/// np.interp with integer grid xp = 0..n-1
fn interp_grid(x: f64, fp: &[f64], right: Option<f64>) -> f64 {
    let n = fp.len();
    if x < 0.0 {
        return fp[0];
    }
    if x > (n - 1) as f64 {
        return right.unwrap_or(fp[n - 1]);
    }
    if x == (n - 1) as f64 {
        return fp[n - 1];
    }
    let j = x.floor() as usize;
    let slope = fp[j + 1] - fp[j];
    slope * (x - j as f64) + fp[j]
}

/// scipy 'reflect' boundary index (d c b a | a b c d | d c b a)
fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    let mut i = i;
    if n == 1 {
        return 0;
    }
    let period = 2 * n;
    i = i.rem_euclid(period);
    if i >= n {
        i = period - 1 - i;
    }
    i as usize
}

fn maximum_filter1d(x: &[f64], size: usize) -> Vec<f64> {
    let n = x.len();
    let half = (size / 2) as isize;
    (0..n)
        .map(|i| {
            let mut m = f64::NEG_INFINITY;
            for d in -half..=(size as isize - 1 - half) {
                let v = x[reflect(i as isize + d, n)];
                if v > m {
                    m = v;
                }
            }
            m
        })
        .collect()
}

fn hz_to_mel(f: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    if f >= 1000.0 {
        1000.0 / f_sp + (f.max(1e-9) / 1000.0).ln() / (6.4f64.ln() / 27.0)
    } else {
        f / f_sp
    }
}

fn mel_to_hz(m: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    if m >= 1000.0 / f_sp {
        1000.0 * ((6.4f64.ln() / 27.0) * (m - 1000.0 / f_sp)).exp()
    } else {
        f_sp * m
    }
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        1.0
    } else {
        let px = PI * x;
        px.sin() / px
    }
}

fn i0(x: f64) -> f64 {
    let q = x * x / 4.0;
    let mut term = 1.0;
    let mut sum = 1.0;
    let mut k = 1.0;
    loop {
        term *= q / (k * k);
        sum += term;
        if term < sum * 1e-18 {
            break;
        }
        k += 1.0;
    }
    sum
}

/// scipy.signal.get_window("hann", n, fftbins=True), as float32
fn hann_periodic(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let fac = i as f64 * (2.0 * PI / n as f64) + (-PI);
            (0.5 + 0.5 * fac.cos()) as f32
        })
        .collect()
}

/// np.hanning(m)
fn np_hanning(m: usize) -> Vec<f64> {
    if m == 1 {
        return vec![1.0];
    }
    (0..m)
        .map(|i| {
            let n = (1.0 - m as f64) + 2.0 * i as f64;
            0.5 + 0.5 * (PI * n / (m as f64 - 1.0)).cos()
        })
        .collect()
}

// ───────────────────────── PCM → mono 22.05 kHz ─────────────────────────

/// scipy.signal.firwin(6401, 1/320, window=('kaiser', 5.0)) scaled like resample_poly(…, 147, 320)
fn resample_taps() -> &'static Vec<Vec<f64>> {
    static TAPS: OnceLock<Vec<Vec<f64>>> = OnceLock::new();
    TAPS.get_or_init(|| {
        let up = 147usize;
        let numtaps = 6401usize;
        let cutoff = 1.0 / 320.0;
        let alpha = 0.5 * (numtaps as f64 - 1.0);
        let beta = 5.0;
        let mut h: Vec<f64> = (0..numtaps)
            .map(|i| {
                let m = i as f64 - alpha;
                let base = cutoff * sinc(cutoff * m);
                let w = i0(beta * (1.0 - ((i as f64 - alpha) / alpha).powi(2)).max(0.0).sqrt()) / i0(beta);
                base * w
            })
            .collect();
        let s = pw64(&h);
        for v in h.iter_mut() {
            *v /= s;
        }
        // match dtype of x (float32), then h *= up
        let h32: Vec<f32> = h.iter().map(|&v| v as f32 * up as f32).collect();
        (0..up)
            .map(|r| {
                let mut v = Vec::new();
                let mut idx = r;
                while idx < numtaps {
                    v.push(h32[idx] as f64);
                    idx += up;
                }
                v
            })
            .collect()
    })
}

/// scipy.signal.resample_poly(x, 147, 320) on one chunk
fn resample_poly_147_320(x: &[f32], out: &mut Vec<f32>) {
    let taps = resample_taps();
    let n = x.len();
    let n_out = (n * 147 + 319) / 320;
    out.reserve(n_out);
    for m in 0..n_out {
        let base = 320 * m + 3200;
        let r = base % 147;
        let q0 = base / 147;
        let t = &taps[r];
        let qmin = q0.saturating_sub(n - 1);
        let qmax = (t.len() - 1).min(q0);
        let mut acc = 0.0f64;
        if qmin <= qmax {
            for q in qmin..=qmax {
                acc += x[q0 - q] as f64 * t[q];
            }
        }
        out.push(acc as f32);
    }
}

/// s16le/48k/stereo bytes → float32 mono at SR. `read(a, b)` returns bytes [a, b).
pub fn pcm_to_mono(total_bytes: usize, read: &dyn Fn(usize, usize) -> Vec<u8>) -> Vec<f32> {
    let frames = (total_bytes / 2) / 2;
    let step = SRC_RATE * 30;
    let mut out: Vec<f32> = Vec::with_capacity((frames * 147 + 319) / 320 + 1);
    let mut s = 0;
    while s < frames {
        let e = (s + step).min(frames);
        let bytes = read(s * 4, e * 4);
        let cnt = bytes.len() / 4;
        let mono: Vec<f32> = (0..cnt)
            .map(|j| {
                let l = i16::from_le_bytes([bytes[4 * j], bytes[4 * j + 1]]) as f32;
                let r = i16::from_le_bytes([bytes[4 * j + 2], bytes[4 * j + 3]]) as f32;
                (l + r) * (0.5 / 32768.0)
            })
            .collect();
        resample_poly_147_320(&mono, &mut out);
        s += step;
    }
    out
}

fn centre(y: &[f32], seconds: usize) -> &[f32] {
    let cap = seconds * SR;
    if y.len() <= cap {
        return y;
    }
    let s = (y.len() - cap) / 2;
    &y[s..s + cap]
}

/// The slice of `y` stage_key actually reads.
pub fn key_excerpt(y: &[f32], refine: bool) -> Vec<f32> {
    centre(y, if refine { 60 } else { KEY_MAX_SECONDS }).to_vec()
}

// ───────────────────────── DSP primitives ─────────────────────────

fn pad_center(y: &[f32], n_fft: usize, hop: usize) -> (Vec<f32>, usize) {
    let pad = n_fft / 2;
    let n_total = 1 + y.len() / hop;
    let mut yp = vec![0.0f32; y.len() + 2 * pad + n_fft];
    yp[pad..pad + y.len()].copy_from_slice(y);
    (yp, n_total)
}

fn mel_fb() -> &'static Vec<(usize, Vec<f32>)> {
    static FB: OnceLock<Vec<(usize, Vec<f32>)>> = OnceLock::new();
    FB.get_or_init(|| {
        let n_bins = N_FFT / 2 + 1;
        let sr = SR as f64;
        let mels = linspace(hz_to_mel(0.0), hz_to_mel(sr / 2.0), N_MELS + 2);
        let hz: Vec<f64> = mels.iter().map(|&m| mel_to_hz(m)).collect();
        let fft_f = linspace(0.0, sr / 2.0, n_bins);
        let fdiff: Vec<f64> = hz.windows(2).map(|w| w[1] - w[0]).collect();
        (0..N_MELS)
            .map(|i| {
                let norm = 2.0 / (hz[i + 2] - hz[i]);
                let w: Vec<f32> = (0..n_bins)
                    .map(|k| {
                        let lower = -(hz[i] - fft_f[k]) / fdiff[i];
                        let upper = (hz[i + 2] - fft_f[k]) / fdiff[i + 1];
                        let v = 0.0f64.max(lower.min(upper));
                        (v * norm) as f32
                    })
                    .collect();
                let first = w.iter().position(|&v| v != 0.0).unwrap_or(0);
                let last = w.iter().rposition(|&v| v != 0.0).map(|p| p + 1).unwrap_or(first);
                (first, w[first..last].to_vec())
            })
            .collect()
    })
}

/// (12, bins) weights folding FFT bins onto pitch classes (C = row 0), row-major.
fn chroma_fb(n_fft: usize, tuning: f64, octave_weight: bool, fmin: Option<f64>, fmax: Option<f64>) -> Vec<f32> {
    let n = 12usize;
    let bins = n_fft / 2 + 1;
    let freqs = linspace(0.0, SR as f64 / 2.0, bins);
    let a440 = 440.0 * 2.0f64.powf(tuning / n as f64);
    let mut frq: Vec<f64> = Vec::with_capacity(bins);
    let tail: Vec<f64> = freqs[1..].iter().map(|&f| n as f64 * (f.max(1e-9) / (a440 / 16.0)).log2()).collect();
    frq.push(tail[0] - 1.5 * n as f64);
    frq.extend(tail);
    let mut width: Vec<f64> = frq.windows(2).map(|w| w[1] - w[0]).collect();
    width.push(1.0);
    for v in width.iter_mut() {
        if *v < 1.0 {
            *v = 1.0;
        }
    }
    // w[c][k]
    let mut w = vec![vec![0.0f64; bins]; n];
    for c in 0..n {
        for k in 0..bins {
            let d = frq[k] - c as f64;
            let d = (d + n as f64 / 2.0 + 10.0 * n as f64).rem_euclid(n as f64) - n as f64 / 2.0;
            w[c][k] = (-0.5 * (2.0 * d / width[k]).powi(2)).exp();
        }
    }
    for k in 0..bins {
        let mut s = 0.0;
        for c in 0..n {
            s += w[c][k] * w[c][k];
        }
        let nrm = s.sqrt().max(1e-12);
        for c in 0..n {
            w[c][k] /= nrm;
        }
    }
    if octave_weight {
        for k in 0..bins {
            let f = (-0.5 * ((frq[k] / n as f64 - 5.0) / 2.0).powi(2)).exp();
            for c in 0..n {
                w[c][k] *= f;
            }
        }
    }
    // np.roll(w, -3, axis=0): new[r] = old[(r+3) % 12]
    let mut out = vec![0.0f32; n * bins];
    for r in 0..n {
        let src = &w[(r + 3) % n];
        for k in 0..bins {
            let mut v = src[k];
            if fmin.is_some() || fmax.is_some() {
                let mut keep = true;
                if let Some(lo) = fmin {
                    keep &= freqs[k] >= lo;
                }
                if let Some(hi) = fmax {
                    keep &= freqs[k] <= hi;
                }
                if !keep {
                    v = 0.0;
                }
            }
            out[r * bins + k] = v as f32;
        }
    }
    out
}

/// Spectrogram power / magnitude helper: STFT frames f0..f1 of a padded signal,
/// each returned as `bins` complex values.
struct Stft {
    n_fft: usize,
    hop: usize,
    win: Vec<f32>,
    plan: Arc<dyn realfft::RealToComplex<f32>>,
    inbuf: Vec<f32>,
    spec: Vec<Complex<f32>>,
}

impl Stft {
    fn new(n_fft: usize, hop: usize) -> Self {
        let mut p = RealFftPlanner::<f32>::new();
        let plan = p.plan_fft_forward(n_fft);
        Stft { n_fft, hop, win: hann_periodic(n_fft), inbuf: plan.make_input_vec(), spec: plan.make_output_vec(), plan }
    }
    fn frame(&mut self, ypad: &[f32], t: usize) -> &[Complex<f32>] {
        let s = t * self.hop;
        for i in 0..self.n_fft {
            self.inbuf[i] = ypad[s + i] * self.win[i];
        }
        self.plan.process(&mut self.inbuf, &mut self.spec).expect("fft");
        &self.spec
    }
}

/// 10*log10(max(S, 1e-10)) − …, floored at max − top_db (S band-major, float32)
fn power_to_db(s: &[f32]) -> Vec<f32> {
    let floor = 1e-10f32;
    let mut db: Vec<f32> = s.iter().map(|&v| 10.0f32 * ((v.max(floor)) as f64).log10() as f32).collect();
    let smax = s.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let top = 10.0 * (((smax as f64).max(1e-10)).log10());
    for v in db.iter_mut() {
        *v = (*v as f64 - top) as f32;
    }
    let dmax = db.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let thr = dmax - 80.0f32;
    for v in db.iter_mut() {
        if *v < thr {
            *v = thr;
        }
    }
    db
}

/// Mel power (n_mels, frames) + STFT chroma (12, frames), computed in chunks.
fn features(y: &[f32], tuning: f64) -> (Vec<f32>, Vec<f32>, usize) {
    let (yp, n_total) = pad_center(y, N_FFT, HOP);
    let fb = mel_fb();
    let bins = N_FFT / 2 + 1;
    let cfb = chroma_fb(N_FFT, tuning, true, None, None);
    let mut mel = vec![0.0f32; N_MELS * n_total];
    let mut chroma = vec![0.0f32; 12 * n_total];
    let mut stft = Stft::new(N_FFT, HOP);
    let mut p = vec![0.0f32; bins];
    let mut f0 = 0;
    while f0 < n_total {
        let f1 = (f0 + CHUNK_FRAMES).min(n_total);
        for t in f0..f1 {
            {
                let x = stft.frame(&yp, t);
                for k in 0..bins {
                    p[k] = x[k].re * x[k].re + x[k].im * x[k].im;
                }
            }
            for (b, (start, w)) in fb.iter().enumerate() {
                let mut acc = 0.0f64;
                for (j, &wv) in w.iter().enumerate() {
                    acc += wv as f64 * p[start + j] as f64;
                }
                mel[b * n_total + t] = acc as f32;
            }
            let mut c = [0.0f32; 12];
            for r in 0..12 {
                let row = &cfb[r * bins..(r + 1) * bins];
                let mut acc = 0.0f64;
                for k in 0..bins {
                    acc += row[k] as f64 * p[k] as f64;
                }
                c[r] = acc as f32;
            }
            let mut mx = f32::NEG_INFINITY;
            for r in 0..12 {
                if c[r] > mx {
                    mx = c[r];
                }
            }
            let den = mx.max(1e-12);
            for r in 0..12 {
                chroma[r * n_total + t] = c[r] / den;
            }
        }
        f0 = f1;
    }
    (mel, chroma, n_total)
}

/// Spectral-flux onset envelope (mean positive dB increase across bands). `mel` is band-major.
fn onset_strength(mel: &[f32], bands: usize, n: usize) -> Vec<f32> {
    let s = power_to_db(&mel[..bands * n]);
    let mut out = vec![0.0f32; n];
    if n > 1 {
        let mut acc = vec![0.0f32; n - 1];
        for b in 0..bands {
            let row = &s[b * n..(b + 1) * n];
            for t in 1..n {
                let d = (row[t] - row[t - 1]).max(0.0);
                acc[t - 1] += d;
            }
        }
        for t in 1..n {
            out[t] = acc[t - 1] / bands as f32;
        }
    }
    out
}

fn pitch_tuning(freqs: &[f64]) -> f64 {
    let edges = linspace(-0.5, 0.5, 101);
    let mut hist = vec![0usize; 100];
    for &f in freqs {
        let x = 12.0 * (f / 440.0).log2();
        let mut r = x.rem_euclid(1.0);
        if r >= 0.5 {
            r -= 1.0;
        }
        if r < edges[0] || r > edges[100] {
            continue;
        }
        let mut b = edges.partition_point(|&e| e <= r);
        b = if b == 0 { 0 } else { b - 1 };
        if b >= 100 {
            b = 99;
        }
        hist[b] += 1;
    }
    let mut bi = 0;
    for (i, &h) in hist.iter().enumerate() {
        if h > hist[bi] {
            bi = i;
        }
    }
    edges[bi]
}

/// Tuning offset in fractions of a semitone (-0.5..0.5) from spectral peaks.
fn estimate_tuning(y: &[f32]) -> f64 {
    let n_fft = 4096;
    let hop = 2048;
    let (yp, n_total) = pad_center(y, n_fft, hop);
    let bins = n_fft / 2 + 1;
    let mut stft = Stft::new(n_fft, hop);
    let freqs = linspace(0.0, SR as f64 / 2.0, bins);
    let mut pitches: Vec<f64> = Vec::new();
    let mut s = vec![0.0f32; bins];
    for t in 0..n_total {
        {
            let x = stft.frame(&yp, t);
            for k in 0..bins {
                s[k] = x[k].re.hypot(x[k].im);
            }
        }
        let mx = s.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let thr = 0.1f32 * mx;
        for k in 1..bins - 1 {
            let (a, b, c) = (s[k - 1], s[k], s[k + 1]);
            let f_mid = freqs[k];
            if b > a && b >= c && b > thr && f_mid >= 150.0 && f_mid < 4000.0 {
                let denom = (a - 2.0f32 * b) + c;
                let shift: f32 = if denom < -1e-12f32 {
                    let d = if denom == 0.0 { 1.0 } else { denom };
                    (0.5f32 * (a - c)) / d
                } else {
                    0.0
                };
                let shift = shift.clamp(-0.5, 0.5);
                pitches.push((k as f64 + shift as f64) * (SR as f64 / n_fft as f64));
            }
        }
    }
    if pitches.is_empty() {
        return 0.0;
    }
    pitch_tuning(&pitches)
}

// ───────────────────────── beat tracking (Ellis 2007 DP) ─────────────────────────

/// Global beat period (float frames) from the onset autocorrelation.
fn estimate_period(onset: &[f32], start_bpm: f64) -> f64 {
    let fps = SR as f64 / HOP as f64;
    let default = fps * 60.0 / start_bpm;
    let win = 384.min(onset.len());
    if win < 64 {
        return default;
    }
    let step = 1.max(win / 4);
    let hann = np_hanning(win);
    let nfft = 1usize << ((2 * win) as f64).log2().ceil() as u32;
    let mut planner = RealFftPlanner::<f64>::new();
    let fwd = planner.plan_fft_forward(nfft);
    let inv = planner.plan_fft_inverse(nfft);
    let mut acc = vec![0.0f64; win];
    let mut cnt = 0usize;
    let mut a = 0;
    let end = 1.max(onset.len() as isize - win as isize + 1) as usize;
    while a < end {
        let mut x = fwd.make_input_vec();
        for i in 0..win {
            x[i] = onset[a + i] as f64 * hann[i];
        }
        let mut sp = fwd.make_output_vec();
        fwd.process(&mut x, &mut sp).expect("fft");
        for c in sp.iter_mut() {
            *c = *c * c.conj();
        }
        let mut ac = inv.make_output_vec();
        inv.process(&mut sp, &mut ac).expect("ifft");
        let ac: Vec<f64> = ac[..win].iter().map(|v| v / nfft as f64).collect();
        let m = ac.iter().fold(0.0f64, |m, &v| m.max(v.abs()));
        if m > 1e-12 {
            for i in 0..win {
                acc[i] += ac[i] / m;
            }
            cnt += 1;
        }
        a += step;
    }
    if cnt == 0 {
        return default;
    }
    for v in acc.iter_mut() {
        *v /= cnt as f64;
    }
    let mut score = vec![f64::NEG_INFINITY; win - 1];
    for (idx, lag) in (1..win).enumerate() {
        let bpm = 60.0 * fps / lag as f64;
        if bpm >= 30.0 && bpm <= 300.0 {
            let prior = -0.5 * ((bpm.log2() - start_bpm.log2()) / 1.0).powi(2);
            score[idx] = (1e6 * acc[lag].max(0.0)).ln_1p() + prior;
        }
    }
    let i = argmax64(&score);
    let mut lag = (i + 1) as f64;
    if i > 0 && i < score.len() - 1 && score[i - 1].is_finite() && score[i + 1].is_finite() {
        let (a_, b_, c_) = (score[i - 1], score[i], score[i + 1]);
        let d = a_ - 2.0 * b_ + c_;
        if d < -1e-9 {
            lag += (0.5 * (a_ - c_) / d).clamp(-0.5, 0.5);
        }
    }
    lag
}

fn env_from_f32(onset: &[f32]) -> Vec<f64> {
    let sd = std32(onset) as f64;
    if sd > 1e-9 {
        let s = sd as f32;
        onset.iter().map(|&v| (v / s) as f64).collect()
    } else {
        onset.iter().map(|&v| v as f64).collect()
    }
}

fn env_from_f64(onset: &[f64]) -> Vec<f64> {
    let sd = std64(onset);
    if sd > 1e-9 {
        onset.iter().map(|&v| v / sd).collect()
    } else {
        onset.to_vec()
    }
}

/// Beat frames from a prepared onset envelope for a given period (frames).
fn beat_dp(env: &[f64], period: f64, tightness: f64, trim: bool) -> Vec<usize> {
    let n = env.len();
    if n < 8 || period < 2.0 {
        return vec![];
    }
    let p = period.round_ties_even() as i64;
    let win: Vec<f64> = (-p..=p).map(|i| (-0.5 * ((i as f64 * 32.0) / period).powi(2)).exp()).collect();
    let local = convolve_same(env, &win);

    let lo_l = 1.max((period / 2.0).round_ties_even() as i64) as usize;
    let hi_l = (2.0 * period).round_ties_even() as usize;
    let pen: Vec<f64> = (lo_l..=hi_l).map(|l| tightness * (l as f64 / period).ln().powi(2)).collect();
    let mut cum = vec![0.0f64; n];
    let mut back = vec![-1i64; n];
    let mut first = true;
    let lmax = local.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let thresh = 0.01 * lmax;
    for i in 0..n {
        let a = i as i64 - hi_l as i64;
        let b = i as i64 - lo_l as i64;
        if b < 0 {
            cum[i] = local[i];
            continue;
        }
        let lo = a.max(0) as usize;
        let b = b as usize;
        let mut bj = lo;
        let mut bv = f64::NEG_INFINITY;
        for j in lo..=b {
            let v = cum[j] - pen[(i - j) - lo_l];
            if v > bv {
                bv = v;
                bj = j;
            }
        }
        if first && local[i] < thresh {
            cum[i] = local[i];
            continue;
        }
        cum[i] = local[i] + bv;
        back[i] = bj as i64;
        first = false;
    }

    // last beat: the last local max of the cumulative score that is not weak
    let mut mx = vec![false; n];
    for i in 1..n.saturating_sub(1) {
        mx[i] = cum[i] > cum[i - 1] && cum[i] >= cum[i + 1];
    }
    mx[n - 1] = n > 1 && cum[n - 1] > cum[n - 2];
    if !mx.iter().any(|&b| b) {
        return vec![];
    }
    let mvals: Vec<f64> = (0..n).filter(|&i| mx[i]).map(|i| cum[i]).collect();
    let med = median64(&mvals);
    let cand: Vec<usize> = (0..n).filter(|&i| mx[i] && cum[i] * 2.0 > med).collect();
    if cand.is_empty() {
        return vec![];
    }
    let mut beats: Vec<usize> = vec![*cand.last().unwrap()];
    while back[*beats.last().unwrap()] >= 0 {
        let b = back[*beats.last().unwrap()] as usize;
        beats.push(b);
    }
    beats.reverse();

    if trim && beats.len() > 2 {
        let lb: Vec<f64> = beats.iter().map(|&b| local[b]).collect();
        let sm = convolve_same(&lb, &np_hanning(5));
        let sq: Vec<f64> = sm.iter().map(|v| v * v).collect();
        let th = 0.5 * mean64(&sq).sqrt();
        let mut s = 0;
        while s < beats.len() && sm[s] <= th {
            s += 1;
        }
        let mut e = beats.len();
        while e > s && sm[e - 1] <= th {
            e -= 1;
        }
        beats = beats[s..e].to_vec();
    }
    beats
}

// ───────────────────────── meter ─────────────────────────

fn z(x: &[f64]) -> Vec<f64> {
    let s = std64(x);
    if s > 1e-9 {
        let m = mean64(x);
        x.iter().map(|&v| (v - m) / s).collect()
    } else {
        vec![0.0; x.len()]
    }
}

/// Median of a float32 row slice, as np.median would (float32 mean of the two middles).
fn median32(seg: &mut [f32]) -> f32 {
    seg.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = seg.len();
    if n % 2 == 1 {
        seg[n / 2]
    } else {
        (seg[n / 2 - 1] + seg[n / 2]) / 2.0f32
    }
}

fn beat_accent(onset: &[f64], onset_low: &[f64], chroma: &[f32], n_chroma: usize, beat_frames: &[usize]) -> Vec<f64> {
    let n = beat_frames.len();
    let mo = maximum_filter1d(onset, 5);
    let ml = maximum_filter1d(onset_low, 5);
    let on: Vec<f64> = beat_frames.iter().map(|&f| mo[f]).collect();
    let lo: Vec<f64> = beat_frames.iter().map(|&f| ml[f]).collect();

    let mut change = vec![0.0f64; n];
    // sync median of chroma over each beat segment
    let mut cb = vec![vec![0.0f64; n]; 12];
    for i in 0..n {
        let s = beat_frames[i];
        let e = if i + 1 < n { beat_frames[i + 1] } else { n_chroma };
        let e = e.max(s + 1).min(n_chroma);
        for r in 0..12 {
            let mut seg: Vec<f32> = chroma[r * n_chroma + s..r * n_chroma + e].to_vec();
            cb[r][i] = median32(&mut seg) as f64;
        }
    }
    for i in 0..n {
        let mut ss = 0.0;
        for r in 0..12 {
            ss += cb[r][i] * cb[r][i];
        }
        let nrm = ss.sqrt().max(1e-12);
        for r in 0..12 {
            cb[r][i] /= nrm;
        }
    }
    let k = n;
    if k >= 2 {
        let mut sims = vec![0.0f64; k - 1];
        for i in 0..k - 1 {
            let mut acc = 0.0;
            for r in 0..12 {
                acc += cb[r][i] * cb[r][i + 1];
            }
            sims[i] = acc;
        }
        for i in 1..k {
            change[i] = 1.0 - sims[i - 1];
        }
        let fill = mean64(&change[1..k]);
        change[0] = fill;
    }
    let a = z(&on);
    let b = z(&lo);
    let c = z(&change);
    let sum: Vec<f64> = (0..n).map(|i| a[i] + b[i] + 0.7 * c[i]).collect();
    z(&sum)
}

fn corrcoef(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len();
    let mx = mean64(x);
    let my = mean64(y);
    let (mut c00, mut c01, mut c11) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let a = x[i] - mx;
        let b = y[i] - my;
        c00 += a * a;
        c01 += a * b;
        c11 += b * b;
    }
    let f = 1.0 / (n as f64 - 1.0);
    let (c00, c01, c11) = (c00 * f, c01 * f, c11 * f);
    let (s0, s1) = (c00.sqrt(), c11.sqrt());
    ((c01 / s0) / s1).clamp(-1.0, 1.0)
}

/// -> (beats_per_bar, phase, confidence, scores)
fn estimate_meter(accent: &[f64]) -> (usize, usize, f64, Map<String, Value>) {
    let n = accent.len();
    let mut scores: Vec<(usize, f64)> = vec![];
    let mut phases: Vec<(usize, usize)> = vec![];
    for &(m, prior) in METER_PRIORS.iter() {
        if n < m * 4 {
            continue;
        }
        let mut acs: Vec<f64> = vec![];
        for lag in [m, 2 * m] {
            if n - lag >= 6 {
                let a = &accent[..n - lag];
                let b = &accent[lag..];
                if std64(a) > 1e-9 && std64(b) > 1e-9 {
                    acs.push(corrcoef(a, b));
                }
            }
        }
        let periodicity = if acs.is_empty() { 0.0 } else { mean64(&acs) };
        let means: Vec<f64> = (0..m)
            .map(|p| {
                let v: Vec<f64> = accent.iter().skip(p).step_by(m).cloned().collect();
                mean64(&v)
            })
            .collect();
        let p = argmax64(&means);
        let contrast = means[p] - (pw64(&means) - means[p]) / (m as f64 - 1.0);
        scores.push((m, (periodicity.max(0.0) + 0.5 * contrast.max(0.0)) * prior));
        phases.push((m, p));
    }
    if scores.is_empty() {
        return (4, 0, 0.0, Map::new());
    }
    let mut ranked = scores.clone();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let (best_m, best) = ranked[0];
    let second = if ranked.len() > 1 { ranked[1].1 } else { 0.0 };
    let conf = if best <= 0.05 { 0.0 } else { ((best - second) / best).clamp(0.0, 1.0) };
    let mut sc = Map::new();
    for (m, s) in &scores {
        sc.insert(m.to_string(), jf(py_round(*s, 4)));
    }
    let phase = phases.iter().find(|(m, _)| *m == best_m).map(|(_, p)| *p).unwrap_or(0);
    (best_m, phase, conf, sc)
}

/// "triple" if the beat is divided in three (6/8-style), else "duple".
fn subdivision(onset: &[f64], beat_frames: &[usize]) -> (&'static str, f64) {
    if beat_frames.len() < 8 {
        return ("duple", 0.0);
    }
    let env = maximum_filter1d(onset, 3);
    let gaps: Vec<f64> = beat_frames.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
    let base: Vec<f64> = beat_frames[..beat_frames.len() - 1].iter().map(|&b| b as f64).collect();
    let at = |frac: f64| -> f64 {
        let v: Vec<f64> = (0..base.len()).map(|i| interp_grid(base[i] + frac * gaps[i], &env, None)).collect();
        mean64(&v)
    };
    let duple = at(0.5);
    let triple = 0.5 * (at(1.0 / 3.0) + at(2.0 / 3.0));
    let ratio = triple / (duple + 1e-9);
    if triple.max(duple) < 0.15 * at(0.0) {
        return ("duple", ratio);
    }
    (if ratio > 1.35 { "triple" } else { "duple" }, ratio)
}

// ───────────────────────── key ─────────────────────────

fn spell(pc: usize, flats: bool) -> &'static str {
    (if flats { NOTES_FLAT } else { NOTES_SHARP })[pc % 12]
}

fn key_from_profile(profile: &[f32], tuning: f64) -> Option<Value> {
    if (std32(profile) as f64) < 1e-9 {
        return None;
    }
    let prof: Vec<f64> = profile.iter().map(|&v| v as f64).collect();
    let mut cands: Vec<(f64, usize, &'static str)> = vec![];
    for tonic in 0..12 {
        let roll = |k: &[f64; 12]| -> Vec<f64> { (0..12).map(|i| k[(i + 12 - tonic) % 12]).collect() };
        cands.push((corrcoef(&roll(&KK_MAJOR), &prof), tonic, "major"));
        cands.push((corrcoef(&roll(&KK_MINOR), &prof), tonic, "minor"));
    }
    cands.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.cmp(&a.1))
            .then(b.2.cmp(a.2))
    });
    let (r1, tonic, mode) = cands[0];
    let (rel_tonic, rel_mode) = if mode == "minor" { ((tonic + 3) % 12, "major") } else { ((tonic + 9) % 12, "minor") };
    let r2 = cands[1..].iter().find(|(_, t, m)| !(*t == rel_tonic && *m == rel_mode)).map(|c| c.0).unwrap_or(0.0);
    let confidence = ((r1 - r2) / 0.15).clamp(0.0, 1.0);

    let major_tonic = if mode == "major" { tonic } else { (tonic + 3) % 12 };
    let flats = FLAT_MAJOR_TONICS.contains(&major_tonic);
    let steps = if mode == "major" { &MAJOR_STEPS } else { &MINOR_STEPS };
    let scale: Vec<&str> = steps.iter().map(|s| spell(tonic + s, flats)).collect();
    let names = if mode == "major" { &MAJOR_NAMES } else { &MINOR_NAMES };
    let rel_names = if rel_mode == "minor" { &MINOR_NAMES } else { &MAJOR_NAMES };
    let alts: Vec<Value> = cands[1..4]
        .iter()
        .map(|(r, t, m)| {
            let nm = if *m == "major" { MAJOR_NAMES[*t] } else { MINOR_NAMES[*t] };
            json!({"name": format!("{nm} {m}"), "r": jf(py_round(*r, 3))})
        })
        .collect();
    Some(json!({
        "tonic": names[tonic], "mode": mode, "name": format!("{} {}", names[tonic], mode),
        "scale": scale, "relative": format!("{} {}", rel_names[rel_tonic], rel_mode),
        "correlation": jf(py_round(r1, 3)), "confidence": jf(py_round(confidence, 3)),
        "tuningCents": jf(py_round(tuning * 100.0, 1)),
        "alternatives": alts,
    }))
}

/// scipy.ndimage.median_filter along one axis of a row-major (rows × cols) f32 matrix, mode="reflect".
fn median_filter_axis(m: &[f32], rows: usize, cols: usize, size: usize, axis_rows: bool) -> Vec<f32> {
    let mut out = vec![0.0f32; m.len()];
    let half = (size / 2) as isize;
    let mut win = vec![0.0f32; size];
    for r in 0..rows {
        for c in 0..cols {
            for (wi, d) in (-half..=(size as isize - 1 - half)).enumerate() {
                win[wi] = if axis_rows {
                    m[reflect(r as isize + d, rows) * cols + c]
                } else {
                    m[r * cols + reflect(c as isize + d, cols)]
                };
            }
            win.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            out[r * cols + c] = win[size / 2];
        }
    }
    out
}

/// Energy-weighted chroma profile of `seg` (STFT chroma with a long window).
fn chroma_profile(seg: &[f32], tuning: f64, t: &mut Timer, harmonic: bool) -> Vec<f32> {
    let n_fft = 4096;
    let hop = 2048;
    let (yp, n_total) = pad_center(seg, n_fft, hop);
    let bins = n_fft / 2 + 1;
    let cfb = chroma_fb(n_fft, tuning, false, Some(60.0), Some(2400.0));
    let kfreq = linspace(0.0, SR as f64 / 2.0, bins);
    let kmax = kfreq.partition_point(|&f| f < 2400.0) + 1;
    let mut p = t.step("STFT chroma", || {
        let mut p = vec![0.0f32; kmax * n_total];
        let mut stft = Stft::new(n_fft, hop);
        for f in 0..n_total {
            let x = stft.frame(&yp, f);
            for k in 0..kmax {
                p[k * n_total + f] = x[k].re * x[k].re + x[k].im * x[k].im;
            }
        }
        p
    });
    if harmonic {
        p = t.step("harmonic separation (median-filter HPSS)", || {
            let mag: Vec<f32> = p.iter().map(|v| v.sqrt()).collect();
            let h = median_filter_axis(&mag, kmax, n_total, 9, false);
            let pc = median_filter_axis(&mag, kmax, n_total, 17, true);
            p.iter().enumerate().map(|(i, &v)| if h[i] >= 2.0f32 * pc[i] { v } else { 0.0 }).collect()
        });
    }
    t.step("chroma fold + weighting", || {
        let mut chroma = vec![0.0f32; 12 * n_total];
        for f in 0..n_total {
            for r in 0..12 {
                let mut acc = 0.0f64;
                for k in 0..kmax {
                    acc += cfb[r * bins + k] as f64 * p[k * n_total + f] as f64;
                }
                chroma[r * n_total + f] = acc as f32;
            }
        }
        // w = sqrt(P.sum(axis=0)) + 1e-9   (sequential float32 sum over rows)
        let mut w = vec![0.0f32; n_total];
        for k in 0..kmax {
            for f in 0..n_total {
                w[f] += p[k * n_total + f];
            }
        }
        for v in w.iter_mut() {
            *v = v.sqrt() + 1e-9f32;
        }
        let mut frame = vec![0.0f32; 12 * n_total];
        for f in 0..n_total {
            let mut s = 0.0f32;
            for r in 0..12 {
                s += chroma[r * n_total + f];
            }
            let den = s.max(1e-12f32);
            for r in 0..12 {
                frame[r * n_total + f] = chroma[r * n_total + f] / den;
            }
        }
        let wsum = pw32(&w);
        (0..12)
            .map(|r| {
                let row: Vec<f32> = (0..n_total).map(|f| frame[r * n_total + f] * w[f]).collect();
                pw32(&row) / wsum
            })
            .collect()
    })
}

/// Key detection. Two passes: quick (STFT chroma straight from the mix) and
/// refine (median-filter HPSS on a 60 s excerpt first).
pub fn stage_key(y: &[f32], tuning: f64, refine: bool) -> StageOut {
    let mut t = Timer::new();
    let seg = centre(y, if refine { 60 } else { KEY_MAX_SECONDS });
    let profile = chroma_profile(seg, tuning, &mut t, refine);
    let key = t.step("key profile match", || key_from_profile(&profile, tuning));
    let data = match key {
        Some(Value::Object(mut m)) => {
            m.insert("refined".into(), json!(refine));
            Value::Object(m)
        }
        _ => Value::Null,
    };
    StageOut { data, steps: t.steps.clone(), sec: t.total() }
}

// ───────────────────────── beats / tempo ─────────────────────────

const ONSET_LATENCY_FRAMES: f64 = 1.0;

fn frames_to_time(frames: &[f64]) -> Vec<f64> {
    frames.iter().map(|&f| (f + ONSET_LATENCY_FRAMES) * HOP as f64 / SR as f64).collect()
}

macro_rules! refine_impl {
    ($name:ident, $t:ty) => {
        /// Sub-frame beat positions (parabolic interpolation of the onset peak).
        fn $name(onset: &[$t], frames: &[usize]) -> Vec<f64> {
            frames
                .iter()
                .map(|&f| {
                    let mut off = 0.0f64;
                    if f > 0 && f + 1 < onset.len() {
                        let (a, b, c) = (onset[f - 1], onset[f], onset[f + 1]);
                        let d = (a - 2.0 as $t * b) + c;
                        if d < -1e-9 as $t {
                            let v = (0.5 as $t * (a - c)) / d;
                            off = v.clamp(-0.5 as $t, 0.5 as $t) as f64;
                        }
                    }
                    f as f64 + off
                })
                .collect()
        }
    };
}
refine_impl!(refine_frames_f32, f32);
refine_impl!(refine_frames_f64, f64);

/// Steady beat grids: slope over the whole grid is far finer than any single
/// interval; irregular ones fall back to the median interval.
fn bpm_from_beats(beat_times: &[f64], fallback: f64) -> (f64, f64) {
    if beat_times.len() < 4 {
        return (fallback, 1.0);
    }
    let iv: Vec<f64> = beat_times.windows(2).map(|w| w[1] - w[0]).collect();
    let med = median64(&iv);
    let cv = if med > 0.0 { std64(&iv) / med } else { 0.0 };
    let mean_iv = (beat_times[beat_times.len() - 1] - beat_times[0]) / (beat_times.len() - 1) as f64;
    let use_ = if cv < 0.05 && (mean_iv - med).abs() / med < 0.01 { mean_iv } else { med };
    let mut bpm = 60.0 / use_;
    if beat_times.len() < 8 || (bpm - fallback).abs() / fallback > 0.06 {
        bpm = fallback;
    }
    (bpm, (1.0 - cv * 4.0).max(0.0))
}

/// PRIORITY stage: beat grid + tempo. Playback waits for this one only.
pub fn stage_beats(y: &[f32]) -> BeatsOut {
    if y.len() < SR * 8 {
        return BeatsOut::Error("track is too short to analyse".into());
    }
    if y.iter().fold(0.0f32, |m, &v| m.max(v.abs())) < 1e-4 {
        return BeatsOut::Error("track is silent".into());
    }
    let mut t = Timer::new();
    let tuning = t.step("tuning estimate", || estimate_tuning(centre(y, 30)));
    let (mel, chroma, n) = t.step("STFT + mel + chroma", || features(y, tuning));
    let (onset, onset_low) = t.step("onset envelope", || (onset_strength(&mel, N_MELS, n), onset_strength(&mel, LOW_MELS, n)));
    drop(mel);
    let fps = SR as f64 / HOP as f64;
    let (tempo_raw, frames) = t.step("beat tracker (DP)", || {
        let period = estimate_period(&onset, 120.0);
        let env = env_from_f32(&onset);
        let fr = beat_dp(&env, period, 100.0, true);
        let _ = fps;
        let tempo_raw = SR as f64 / HOP as f64 * 60.0 / period;
        let fr: Vec<usize> = fr.into_iter().filter(|&f| f < onset.len().min(n)).collect();
        (tempo_raw, fr)
    });
    let (beat_times, data) = t.step("beat refine + tempo", || {
        let beat_times = frames_to_time(&refine_frames_f32(&onset, &frames));
        let mut data = json!({"durationSec": jf(py_round(y.len() as f64 / SR as f64, 2)), "beats": [], "tempo": null});
        if beat_times.len() >= 4 {
            let (bpm, stability) = bpm_from_beats(&beat_times, tempo_raw);
            let sel: Vec<f32> = frames.iter().map(|&f| onset[f]).collect();
            let m1 = pw32(&sel) / sel.len() as f32;
            let m2 = pw32(&onset) / onset.len() as f32;
            let strength = (m1 / (m2 + 1e-9f32)) as f64;
            data["tempo"] = json!({
                "bpm": jf(py_round(bpm, 2)), "bpmRaw": jf(py_round(tempo_raw, 2)),
                "stability": jf(py_round(stability, 3)),
                "beatStrength": jf(py_round(strength, 2)),
                "alt": [jf(py_round(bpm / 2.0, 1)), jf(py_round(bpm * 2.0, 1))],
                "variable": false,
            });
            data["beats"] = Value::Array(beat_times.iter().map(|&b| jf(py_round(b, 3))).collect());
        }
        (beat_times, data)
    });
    let state = BeatState { onset, onset_low, chroma, n_chroma: n, tuning, tempo_raw, beat_times };
    BeatsOut::Ok { state, data, steps: t.steps.clone(), sec: t.total() }
}

// ───────────────────────── tempo changes ─────────────────────────

const SEC_WIN_S: f64 = 8.0;
const SEC_STEP_S: f64 = 1.0;
const SEC_MIN_S: f64 = 10.0;
const SEC_MIN_DELTA: f64 = 0.04;
const SEC_SWITCH_COST: f64 = 8.0;
const SEC_KAPPA: f64 = 10.0;
const SEC_PAD_S: f64 = 4.0;

fn sec_tempos() -> Vec<f64> {
    linspace(70.0f64.ln(), 200.0f64.ln(), 150).into_iter().map(|v| v.exp()).collect()
}

/// (windows, tempos) matrix of tempo evidence from autocorrelation in sliding windows.
fn window_tempo_scores(onset: &[f64], fps: f64, centre_bpm: f64, tempos: &[f64]) -> (Vec<usize>, Vec<Vec<f64>>) {
    let w = (SEC_WIN_S * fps) as usize;
    let step = 1.max((SEC_STEP_S * fps) as usize);
    let n = onset.len();
    let lags: Vec<f64> = tempos.iter().map(|&t| 60.0 * fps / t).collect();
    let prior: Vec<f64> = tempos.iter().map(|&t| (-0.5 * ((t / centre_bpm).log2() / 0.45).powi(2)).exp()).collect();
    let nfft = 1usize << ((2 * w) as f64).log2().ceil() as u32;
    let mut planner = RealFftPlanner::<f64>::new();
    let fwd = planner.plan_fft_forward(nfft);
    let inv = planner.plan_fft_inverse(nfft);
    let mut centres = vec![];
    let mut rows: Vec<Vec<f64>> = vec![];
    let end = 1.max(n as isize - w as isize + 1) as usize;
    let mut a = 0;
    while a < end {
        let mut x: Vec<f64> = onset[a..(a + w).min(n)].to_vec();
        let m = mean64(&x);
        for v in x.iter_mut() {
            *v -= m;
        }
        let e: f64 = x.iter().map(|v| v * v).sum();
        if e < 1e-9 {
            rows.push(vec![0.0; tempos.len()]);
        } else {
            let mut inp = fwd.make_input_vec();
            inp[..x.len()].copy_from_slice(&x);
            let mut sp = fwd.make_output_vec();
            fwd.process(&mut inp, &mut sp).expect("fft");
            for c in sp.iter_mut() {
                *c = *c * c.conj();
            }
            let mut ac = inv.make_output_vec();
            inv.process(&mut sp, &mut ac).expect("ifft");
            let ac: Vec<f64> = (0..w).map(|i| (ac[i] / nfft as f64) / e * (w as f64 / (w - i) as f64)).collect();
            let row: Vec<f64> = lags
                .iter()
                .map(|&l| {
                    let v = interp_grid(l, &ac, None) + 0.5 * interp_grid(2.0 * l, &ac, Some(0.0));
                    v.max(0.0)
                })
                .collect();
            rows.push(row);
        }
        centres.push(a + w / 2);
        a += step;
    }
    for row in rows.iter_mut() {
        let mx = row.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        for (j, v) in row.iter_mut().enumerate() {
            *v = *v / (mx + 1e-9) * prior[j];
        }
        let mx2 = row.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        for v in row.iter_mut() {
            *v /= mx2 + 1e-9;
        }
    }
    (centres, rows)
}

/// Best tempo path with a flat switching penalty -> piecewise constant.
fn viterbi_tempo(sc: &[Vec<f64>]) -> Vec<usize> {
    let t = sc.len();
    let k = sc[0].len();
    let ll: Vec<Vec<f64>> = sc.iter().map(|r| r.iter().map(|v| SEC_KAPPA * v).collect()).collect();
    let mut delta = ll[0].clone();
    let mut back = vec![vec![0usize; k]; t];
    for i in 1..t {
        let best = argmax64(&delta);
        let switch = delta[best] - SEC_SWITCH_COST;
        let mut nd = vec![0.0; k];
        for j in 0..k {
            let stay = delta[j];
            if switch > stay {
                back[i][j] = best;
                nd[j] = switch + ll[i][j];
            } else {
                back[i][j] = j;
                nd[j] = stay + ll[i][j];
            }
        }
        delta = nd;
    }
    let mut path = vec![0usize; t];
    path[t - 1] = argmax64(&delta);
    for i in (1..t).rev() {
        path[i - 1] = back[i][path[i]];
    }
    path
}

/// Beat frames within [a, b) tracked at ~bpm (absolute frames).
fn beats_in(onset: &[f64], a: i64, b: i64, bpm: f64) -> Vec<usize> {
    let a = a.max(0) as usize;
    let b = (b.max(0) as usize).min(onset.len());
    if (b as i64) - (a as i64) < 40 {
        return vec![];
    }
    let fps = SR as f64 / HOP as f64;
    let period = fps * 60.0 / bpm;
    let env = env_from_f64(&onset[a..b]);
    beat_dp(&env, period, 100.0, false).into_iter().map(|f| f + a).collect()
}

#[derive(Clone)]
struct Run {
    lo: i64,
    hi: i64,
    bpm: f64,
}

fn merge_close(rs: &[Run]) -> Vec<Run> {
    let mut out = vec![rs[0].clone()];
    for r in &rs[1..] {
        let last = out.last_mut().unwrap();
        if (r.bpm - last.bpm).abs() / last.bpm < SEC_MIN_DELTA {
            let wl = (last.hi - last.lo) as f64;
            let wr = (r.hi - r.lo) as f64;
            last.bpm = (last.bpm * wl + r.bpm * wr) / (wl + wr);
            last.hi = r.hi;
        } else {
            out.push(r.clone());
        }
    }
    out
}

struct Sec {
    b: i64,
    bpm: f64,
    frames: Vec<usize>,
}

/// Detect tempo changes. Returns sections and, when there is more than one, a
/// re-tracked beat list whose grid follows each section's own tempo.
pub fn stage_sections(state: &BeatState, duration: f64) -> StageOut {
    let mut t = Timer::new();
    let onset: Vec<f64> = state.onset.iter().map(|&v| v as f64).collect();
    let fps = SR as f64 / HOP as f64;
    let base_beats = &state.beat_times;
    let gbpm = if base_beats.len() >= 4 {
        let iv: Vec<f64> = base_beats.windows(2).map(|w| w[1] - w[0]).collect();
        60.0 / median64(&iv)
    } else {
        state.tempo_raw
    };

    let single = |t: &Timer| -> StageOut {
        StageOut {
            data: json!({"sections": [{"start": 0.0, "end": jf(py_round(duration, 2)), "bpm": jf(py_round(gbpm, 2)),
                                        "startBeat": 0, "beats": base_beats.len()}],
                         "changed": false}),
            steps: t.steps.clone(),
            sec: t.total(),
        }
    };

    if duration < 3.0 * SEC_MIN_S || onset.len() < (SEC_WIN_S * fps) as usize * 2 || base_beats.len() < 16 {
        return single(&t);
    }

    let tempos = sec_tempos();
    let (centres, sc) = t.step("windowed tempo (autocorrelation)", || window_tempo_scores(&onset, fps, gbpm, &tempos));
    if centres.len() < 6 {
        return single(&t);
    }
    let path = t.step("tempo path (Viterbi)", || viterbi_tempo(&sc));

    // runs of constant tempo
    let mut runs: Vec<Run> = vec![];
    let half = ((SEC_STEP_S * fps) as i64) / 2;
    for (i, &p) in path.iter().enumerate() {
        let lo = if i == 0 { 0 } else { centres[i] as i64 - half };
        let hi = if i == path.len() - 1 { onset.len() as i64 } else { centres[i] as i64 + half };
        if let Some(l) = runs.last_mut() {
            if l.bpm == tempos[p] {
                l.hi = hi;
                continue;
            }
        }
        runs.push(Run { lo, hi, bpm: tempos[p] });
    }
    runs = merge_close(&runs);
    // absorb too-short runs into the longer neighbour
    let min_f = SEC_MIN_S * fps;
    while runs.len() > 1 {
        let lens: Vec<i64> = runs.iter().map(|r| r.hi - r.lo).collect();
        let mut i = 0;
        for (k, &l) in lens.iter().enumerate() {
            if l < lens[i] {
                i = k;
            }
        }
        if lens[i] as f64 >= min_f {
            break;
        }
        let j = if i == runs.len() - 1 || (i > 0 && lens[i - 1] >= lens[i + 1]) { i - 1 } else { i + 1 };
        let (a, b) = if i < j { (i, j) } else { (j, i) };
        let bpm = if lens[a] >= lens[b] { runs[a].bpm } else { runs[b].bpm };
        runs[a] = Run { lo: runs[a].lo, hi: runs[b].hi, bpm };
        runs.remove(b);
        runs = merge_close(&runs);
    }
    if runs.len() < 2 {
        return single(&t);
    }

    let secs: Vec<Sec> = t.step("per-section beat tracking", || {
        let pad = (SEC_PAD_S * fps) as i64;
        runs.iter()
            .map(|r| {
                let fr = beats_in(&onset, r.lo - pad, r.hi + pad, r.bpm);
                let core: Vec<usize> = fr.iter().cloned().filter(|&f| (f as i64) >= r.lo && (f as i64) < r.hi).collect();
                let tt = frames_to_time(&refine_frames_f64(&onset, &core));
                let (bpm, _) = bpm_from_beats(&tt, r.bpm);
                Sec { b: r.hi, bpm, frames: fr }
            })
            .collect()
    });

    let cuts: Vec<i64> = t.step("boundary refinement", || {
        let mut cuts = vec![0i64];
        let reach = (1.5 * fps) as i64;
        let stepc = 1.max((0.05 * fps) as i64);
        for i in 0..secs.len() - 1 {
            let (l, r) = (&secs[i], &secs[i + 1]);
            let edge = l.b;
            let pl = 60.0 * fps / l.bpm;
            let pr = 60.0 * fps / r.bpm;
            let target = 0.5 * (pl + pr);
            let mut best_c = edge;
            let mut best_cost = 1e18;
            let mut c = edge - reach;
            while c < edge + reach + 1 {
                let lb = l.frames.iter().filter(|&&f| (f as i64) < c).last();
                let rb = r.frames.iter().find(|&&f| (f as i64) >= c);
                if let (Some(&lb), Some(&rb)) = (lb, rb) {
                    let cost = ((rb as f64 - lb as f64) - target).abs() / target + 0.02 * ((c - edge).abs() as f64) / fps;
                    if cost < best_cost {
                        best_cost = cost;
                        best_c = c;
                    }
                }
                c += stepc;
            }
            let prev = *cuts.last().unwrap();
            cuts.push(best_c.max(prev + 1));
        }
        cuts.push(onset.len() as i64);
        cuts
    });

    let mut final_beats: Vec<f64> = vec![];
    let mut out_secs: Vec<Map<String, Value>> = vec![];
    t.step("assemble beats + section tempos", || {
        for (i, s) in secs.iter().enumerate() {
            let (lo, hi) = (cuts[i], cuts[i + 1]);
            let fr: Vec<usize> = s.frames.iter().cloned().filter(|&f| (f as i64) >= lo && (f as i64) < hi).collect();
            let tt = frames_to_time(&refine_frames_f64(&onset, &fr));
            let core: &[f64] = if tt.len() >= 10 { &tt[2..tt.len() - 2] } else { &tt };
            let (bpm, stab) = bpm_from_beats(core, s.bpm);
            let mut m = Map::new();
            m.insert("start".into(), jf(py_round((lo * HOP as i64) as f64 / SR as f64, 2)));
            m.insert("end".into(), jf(py_round((hi * HOP as i64) as f64 / SR as f64, 2)));
            m.insert("bpm".into(), jf(py_round(bpm, 2)));
            m.insert("startBeat".into(), json!(final_beats.len()));
            m.insert("beats".into(), json!(tt.len()));
            m.insert("stability".into(), jf(py_round(stab, 3)));
            out_secs.push(m);
            final_beats.extend(tt.iter().map(|&v| py_round(v, 3)));
        }
    });
    out_secs[0].insert("start".into(), jf(0.0));
    let last = out_secs.len() - 1;
    out_secs[last].insert("end".into(), jf(py_round(duration, 2)));

    let keep: Vec<&Map<String, Value>> = out_secs.iter().filter(|s| s["beats"].as_i64().unwrap_or(0) >= 4).collect();
    if keep.len() < 2 || final_beats.len() < 8 {
        return single(&t);
    }
    let span = |s: &Map<String, Value>| s["end"].as_f64().unwrap_or(0.0) - s["start"].as_f64().unwrap_or(0.0);
    let mut dom = keep[0];
    for s in &keep {
        if span(s) > span(dom) {
            dom = s;
        }
    }
    let bpms: Vec<f64> = keep.iter().map(|s| s["bpm"].as_f64().unwrap_or(0.0)).collect();
    let data = json!({
        "sections": out_secs.iter().cloned().map(Value::Object).collect::<Vec<_>>(),
        "changed": true,
        "beats": final_beats.iter().map(|&b| jf(b)).collect::<Vec<_>>(),
        "tempo": {"bpm": dom["bpm"].clone(), "variable": true,
                  "min": jf(bpms.iter().cloned().fold(f64::INFINITY, f64::min)),
                  "max": jf(bpms.iter().cloned().fold(f64::NEG_INFINITY, f64::max))},
    });
    StageOut { data, steps: t.steps.clone(), sec: t.total() }
}

// ───────────────────────── meter stage ─────────────────────────

pub fn stage_meter(state: &BeatState, beat_times: &[f64], sections: Option<&[Value]>) -> StageOut {
    let mut t = Timer::new();
    let n = state.onset.len().min(state.n_chroma);
    let frames: Vec<usize> = beat_times
        .iter()
        .map(|&b| (b * SR as f64 / HOP as f64).round_ties_even() as i64)
        .filter(|&f| f >= 0 && (f as usize) < n)
        .map(|f| f as usize)
        .collect();
    if frames.len() < 16 {
        return StageOut { data: Value::Null, steps: t.steps.clone(), sec: t.total() };
    }
    let onset: Vec<f64> = state.onset.iter().map(|&v| v as f64).collect();
    let onset_low: Vec<f64> = state.onset_low.iter().map(|&v| v as f64).collect();
    let accent = t.step("beat accents", || beat_accent(&onset, &onset_low, &state.chroma, state.n_chroma, &frames));
    let (m, phase, conf, scores) = t.step("meter scoring", || estimate_meter(&accent));
    let (sub, ratio) = t.step("subdivision test", || subdivision(&onset, &frames));
    let label = if sub == "triple" && (m == 2 || m == 3 || m == 4) { format!("{}/8", m * 3) } else { format!("{m}/4") };

    let starts: Vec<i64> = match sections {
        Some(s) if s.len() > 1 => s.iter().map(|x| x["startBeat"].as_i64().unwrap_or(0)).collect(),
        _ => vec![0],
    };
    let phases: Vec<Value> = starts.iter().map(|&a| json!({"beat": a, "phase": 0})).collect();
    let data = json!({
        "beatsPerBar": m, "label": label, "downbeatPhase": 0, "detectedPhase": phase, "phases": phases,
        "confidence": jf(py_round(conf, 3)), "subdivision": sub, "tripleRatio": jf(py_round(ratio, 2)),
        "scores": Value::Object(scores),
    });
    StageOut { data, steps: t.steps.clone(), sec: t.total() }
}

/// Build the cached filterbanks / FFT plans so the first track is not slower than the rest.
pub fn warmup() {
    let mut s: u64 = 0x2545F4914F6CDD1D;
    let y: Vec<f32> = (0..SR * 10)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            ((s >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0) as f32 * 0.1
        })
        .collect();
    let (mel, _chroma, n) = features(&y, 0.0);
    let _ = estimate_tuning(&y);
    let on = onset_strength(&mel, N_MELS, n);
    let p = estimate_period(&on, 120.0);
    let _ = beat_dp(&env_from_f32(&on), p, 100.0, true);
    let _ = resample_taps();
}
