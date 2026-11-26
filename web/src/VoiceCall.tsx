import { useEffect, useRef, useState } from 'react';

/**
 * 음성 대화(통화처럼) — 말하면 받아쓰고, 서버(WebSocket)의 업무 대화가 답하면 문장 단위로 읽는다.
 *
 * - 받아쓰기: 브라우저 음성 인식(크롬, 한국어 · 중간 결과 스트리밍)
 * - 읽기: 서버 /api/tts(ElevenLabs)가 되면 탭 안 오디오로 재생 → 마이크 에코 제거가 자기 목소리를 지워 끼어들기가 된다.
 *   안 되면 기기 음성으로 대체(이때는 에코가 다시 들어올 수 있어 "지금 읽는 문장과 비슷한 말"은 무시)
 * - 끼어들기: 읽는 중에 사용자가 말하면 재생을 멈추고 서버 턴을 취소
 * - 측정: 말 끝(최종 인식) → 첫 소리 시간, 끼어들기 횟수를 화면에 보여 준다
 */
export interface VoiceReply {
  reply: string;
  route: string;
  rows?: unknown[];
  action?: unknown;
  steps?: { tool: string; summary: string }[];
  suggestions?: string[];
}

type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const norm = (s: string) => s.replace(/[\s.,!?·~"'()]/g, '');
/** 인식된 말이 지금 읽고 있는 문장의 메아리인지(기기 음성 대체 모드에서만 의미 있음) */
const looksLikeEcho = (heard: string, speaking: string) => {
  const h = norm(heard);
  const sp = norm(speaking);
  if (h.length < 2) return true;
  let hit = 0;
  for (let i = 0; i < h.length - 1; i++) if (sp.includes(h.slice(i, i + 2))) hit++;
  return hit / Math.max(1, h.length - 1) > 0.6;
};

/** 화면용 답 → 읽을 문장들(표 · 목록은 화면으로) */
function toSpeech(r: VoiceReply): string[] {
  const text = r.reply
    .split('\n')
    .filter((l) => l.trim() && !/^[·\-•|]/.test(l.trim()) && !/^\[.*\]/.test(l.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sents = (text.match(/[^.!?。]+[.!?。]?/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (const s of sents) {
    if (len + s.length > 220 && out.length) break;
    out.push(s);
    len += s.length;
  }
  if (r.rows?.length) out.push('목록은 화면에 띄워 드렸어요.');
  if (r.action) out.push('확정 카드를 만들었어요. 화면에서 확인하고 눌러 주세요.');
  if (!out.length) out.push('답을 화면에 띄워 드렸어요.');
  return out;
}

export function VoiceCall({
  filingId,
  auto,
  onUser,
  onReply,
}: {
  filingId: number;
  auto: boolean;
  onUser: (text: string) => void;
  onReply: (r: VoiceReply, ms: number) => void;
}) {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const [heard, setHeard] = useState('');
  const [lat, setLat] = useState<number[]>([]);
  const [barge, setBarge] = useState(0);
  const [engine, setEngine] = useState<'eleven' | 'device' | '?'>('?');
  const [err, setErr] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const sr = useRef<SR | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<{ id: string; t0: number; firstSound: boolean } | null>(null);
  const speakingText = useRef('');
  const playToken = useRef(0);
  const active = useRef(false);
  const engineRef = useRef<'eleven' | 'device' | '?'>('?');

  const stopPlayback = () => {
    playToken.current++;
    audio.current?.pause();
    window.speechSynthesis?.cancel();
    speakingText.current = '';
  };

  const markFirstSound = () => {
    const p = pending.current;
    if (p && !p.firstSound) {
      p.firstSound = true;
      setLat((l) => [...l.slice(-19), performance.now() - p.t0]);
    }
  };

  /** 한 문장 재생: 서버 TTS가 되면 탭 안 오디오, 아니면 기기 음성 */
  const playOne = async (text: string, token: number): Promise<void> => {
    if (token !== playToken.current) return;
    speakingText.current = text;
    try {
      const res = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (token !== playToken.current) return;
      if (res.status === 200) {
        setEngine('eleven');
        engineRef.current = 'eleven';
        const url = URL.createObjectURL(await res.blob());
        if (token !== playToken.current) return URL.revokeObjectURL(url);
        await new Promise<void>((resolve) => {
          const a = audio.current ?? (audio.current = new Audio());
          a.src = url;
          a.onplaying = () => markFirstSound();
          a.onended = a.onerror = a.onpause = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          void a.play().catch(() => resolve());
        });
        return;
      }
    } catch {
      /* 서버 TTS 실패 → 기기 음성 */
    }
    if (token !== playToken.current) return;
    setEngine('device');
    engineRef.current = 'device';
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = 1.1;
      u.onstart = () => markFirstSound();
      u.onend = u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  };

  const speak = async (sentences: string[]) => {
    stopPlayback();
    const token = playToken.current;
    setState('speaking');
    for (const s of sentences) {
      if (token !== playToken.current) return;
      await playOne(s, token);
    }
    if (token === playToken.current) {
      speakingText.current = '';
      setState(active.current ? 'listening' : 'idle');
    }
  };

  const sendUtterance = (text: string) => {
    const id = `${Date.now()}`;
    if (pending.current && !pending.current.firstSound) ws.current?.send(JSON.stringify({ t: 'cancel', id: pending.current.id }));
    pending.current = { id, t0: performance.now(), firstSound: false };
    onUser(text);
    setState('thinking');
    ws.current?.send(JSON.stringify({ t: 'utt', id, filingId, text, mode: auto ? 'auto' : 'quick' }));
  };

  const start = async () => {
    setErr(null);
    const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => SR; SpeechRecognition?: new () => SR }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;
    if (!Ctor) return setErr('이 브라우저는 음성 인식을 지원하지 않아요. 크롬에서 열어 주세요.');
    try {
      // 마이크 권한 + 에코 제거 켜기(탭 안에서 나는 소리를 마이크에서 지운다)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      return setErr('마이크 권한이 필요해요.');
    }
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { t: string; id: string; text?: string; ms?: number } & VoiceReply;
      if (!pending.current || m.id !== pending.current.id) return; // 끼어들어 버린 이전 턴의 답
      if (m.t === 'ack' && m.text) void speak([m.text]);
      if (m.t === 'reply') {
        onReply(m, m.ms ?? 0);
        void speak(toSpeech(m));
      }
    };
    sock.onclose = () => active.current && setErr('연결이 끊겼어요. 다시 시작해 주세요.');
    ws.current = sock;

    const rec = new Ctor();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0].transcript.trim();
        if (!t) continue;
        const speaking = !!speakingText.current;
        // 기기 음성 모드에서는 자기 목소리가 다시 들어오므로 메아리처럼 보이면 무시
        if (speaking && engineRef.current !== 'eleven' && looksLikeEcho(t, speakingText.current)) continue;
        if (!res.isFinal) {
          setHeard(t);
          if (speaking && t.length >= 2) {
            // 끼어들기: 재생 중단 + 서버 턴 취소
            stopPlayback();
            if (pending.current && !pending.current.firstSound) ws.current?.send(JSON.stringify({ t: 'cancel', id: pending.current.id }));
            setBarge((b) => b + 1);
            setState('listening');
          }
        } else {
          setHeard('');
          stopPlayback();
          sendUtterance(t);
        }
      }
    };
    rec.onerror = (e) => e.error !== 'no-speech' && e.error !== 'aborted' && setErr(`음성 인식 오류: ${e.error}`);
    rec.onend = () => active.current && rec.start(); // 통화처럼 계속 듣기
    sr.current = rec;
    active.current = true;
    rec.start();
    setOn(true);
    setState('listening');
  };

  const stop = () => {
    active.current = false;
    sr.current?.abort();
    stopPlayback();
    ws.current?.close();
    setOn(false);
    setState('idle');
    setHeard('');
  };

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const label = { idle: '', listening: '듣는 중', thinking: '답을 찾는 중', speaking: '읽는 중 · 말하면 멈춰요' }[state];
  return (
    <div className="wb-voice">
      <button className={`wb-btn ${on ? 'wb-btn-danger' : ''}`} onClick={() => (on ? stop() : void start())} title="통화처럼 말로 묻고 답을 들어요">
        {on ? '■ 음성 대화 끝내기' : '🎙 음성 대화'}
      </button>
      {on && (
        <span className="wb-sub wb-voice-state">
          <span className={`wb-dot wb-dot-${state}`} /> {label}
          {heard && <em> · "{heard}"</em>}
        </span>
      )}
      {(lat.length > 0 || barge > 0) && (
        <div className="wb-sub wb-voice-metrics">
          말 끝 → 첫 소리 중간값 <b>{(median(lat) / 1000).toFixed(2)}초</b>({lat.length}회) · 끼어들기 {barge}회 · 음성 {engine === 'eleven' ? 'ElevenLabs' : engine === 'device' ? '기기' : '-'}
        </div>
      )}
      {err && <div className="wb-warn">{err}</div>}
    </div>
  );
}
