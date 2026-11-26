import { useEffect, useRef, useState } from 'react';

/**
 * 음성 입출력 훅 — 받아쓰기(브라우저 음성 인식) + 읽기(서버 /api/tts → 안 되면 기기 음성) + 끼어들기.
 * 면접 연습처럼 "한 사람이 길게 말하는" 화면에서 쓰려고 VoiceCall에서 떼어 낸 공통 부분.
 */
type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

const cache = new Map<string, Blob>();
const norm = (s: string) => s.replace(/[\s.,!?·~"'()]/g, '');
const looksLikeEcho = (heard: string, spoken: string) => {
  const h = norm(heard);
  const sp = norm(spoken);
  if (h.length < 2) return true;
  let hit = 0;
  for (let i = 0; i < h.length - 1; i++) if (sp.includes(h.slice(i, i + 2))) hit++;
  return hit / Math.max(1, h.length - 1) > 0.6;
};

export function sentences(text: string, max = 400): string[] {
  const parts = (text.replace(/\s+/g, ' ').match(/[^.!?。]+[.!?。]?/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (const p of parts) {
    if (len + p.length > max && out.length) break;
    out.push(p);
    len += p.length;
  }
  return out;
}

export function useVoiceIO(handlers: { onFinal: (text: string) => void; onInterim?: (text: string) => void; onBargeIn?: () => void }) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [engine, setEngine] = useState<'eleven' | 'device' | '?'>('?');
  const [error, setError] = useState<string | null>(null);
  const sr = useRef<SR | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const active = useRef(false);
  const token = useRef(0);
  const speakingText = useRef('');
  const lastSpoken = useRef({ text: '', at: 0 });
  const engineRef = useRef<'eleven' | 'device' | '?'>('?');
  const h = useRef(handlers);
  h.current = handlers;

  const safeStart = () => {
    try {
      sr.current?.start();
    } catch {
      /* 이미 듣는 중 */
    }
  };

  const stopSpeaking = () => {
    token.current++;
    audio.current?.pause();
    window.speechSynthesis?.cancel();
    speakingText.current = '';
    setSpeaking(false);
  };

  const playOne = async (text: string, tk: number, onFirstSound?: () => void) => {
    if (tk !== token.current) return;
    speakingText.current = text;
    lastSpoken.current = { text: `${lastSpoken.current.text} ${text}`.slice(-400), at: Date.now() };
    try {
      let blob = cache.get(text);
      if (!blob) {
        const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (r.status === 200) blob = await r.blob();
        if (blob && text.length <= 40) cache.set(text, blob);
      }
      if (tk !== token.current) return;
      if (blob) {
        engineRef.current = 'eleven';
        setEngine('eleven');
        const url = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const a = audio.current ?? (audio.current = new Audio());
          a.src = url;
          a.onplaying = () => onFirstSound?.();
          a.onended = a.onerror = a.onpause = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          void a.play().catch(() => resolve());
        });
        return;
      }
    } catch {
      /* 기기 음성으로 */
    }
    if (tk !== token.current) return;
    engineRef.current = 'device';
    setEngine('device');
    sr.current?.abort(); // 기기 음성은 에코 제거가 안 되므로 읽는 동안 듣지 않는다
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = 1.05;
      u.onstart = () => onFirstSound?.();
      u.onend = u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  };

  /** 문장들을 차례로 읽는다. 끼어들면 중간에 멈춘다. */
  const speak = async (texts: string[], onFirstSound?: () => void) => {
    stopSpeaking();
    const tk = token.current;
    setSpeaking(true);
    let first = true;
    for (const t of texts) {
      if (tk !== token.current) return;
      await playOne(t, tk, first ? onFirstSound : undefined);
      first = false;
    }
    if (tk === token.current) {
      speakingText.current = '';
      lastSpoken.current.at = Date.now();
      setSpeaking(false);
      if (active.current && engineRef.current === 'device') setTimeout(safeStart, 300);
    }
  };

  const start = async () => {
    setError(null);
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return setError('이 브라우저는 음성 인식을 지원하지 않아요. 크롬에서 열어 주세요.'), false;
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      st.getTracks().forEach((t) => t.stop());
    } catch {
      return setError('마이크 권한이 필요해요.'), false;
    }
    const rec = new Ctor();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0].transcript.trim();
        if (!t) continue;
        const isSpeaking = !!speakingText.current;
        if (isSpeaking && engineRef.current !== 'eleven' && looksLikeEcho(t, speakingText.current)) continue;
        if (!r.isFinal) {
          h.current.onInterim?.(t);
          if (isSpeaking && t.length >= 2) {
            stopSpeaking();
            h.current.onBargeIn?.();
          }
        } else {
          if (norm(t).length < 2) continue;
          if (Date.now() - lastSpoken.current.at < 3000 && looksLikeEcho(t, lastSpoken.current.text)) continue;
          h.current.onFinal(t);
        }
      }
    };
    rec.onerror = (e) => e.error !== 'no-speech' && e.error !== 'aborted' && setError(`음성 인식 오류: ${e.error}`);
    rec.onend = () => {
      if (active.current && !(engineRef.current === 'device' && speakingText.current)) safeStart();
    };
    sr.current = rec;
    active.current = true;
    safeStart();
    setListening(true);
    return true;
  };

  const stop = () => {
    active.current = false;
    sr.current?.abort();
    stopSpeaking();
    setListening(false);
  };

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return { start, stop, speak, stopSpeaking, listening, speaking, engine, error };
}
