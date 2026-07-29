import { useRef, useState, useEffect } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import {
  Bell, BellOff, Play, ShieldAlert, CheckCircle2,
  ChevronLeft, ChevronRight, Pause, X,
} from "lucide-react";
import "./DynamicIsland.css";

type NotifType  = "permission" | "done";
type Phase      = "idle" | "active" | "hovered";
type TimerState = "off" | "working" | "resting";

interface Notif {
  id: string; type: NotifType; agent: string; title: string; detail: string;
}

const NOTIFS: Notif[] = [
  { id:"1", type:"permission", agent:"claude-code", title:"Permission needed",  detail:"claude-code wants to read ~/.ssh/id_rsa" },
  { id:"2", type:"done",       agent:"cursor",      title:"Task complete",      detail:"Refactored auth module · 14 files · 2m 34s" },
  { id:"3", type:"permission", agent:"codex",       title:"Permission needed",  detail:"codex wants to execute a shell command" },
  { id:"4", type:"done",       agent:"copilot",     title:"Build passed",       detail:"TypeScript compiled · 0 errors · 3.2s" },
  { id:"5", type:"permission", agent:"gemini-cli",  title:"Permission needed",  detail:"gemini-cli wants to write to package.json" },
  { id:"6", type:"done",       agent:"aider",       title:"Task complete",      detail:"Added pagination to UserList · 3 files · 1m 12s" },
  { id:"7", type:"permission", agent:"windsurf",    title:"Permission needed",  detail:"windsurf wants to run npm install" },
  { id:"8", type:"done",       agent:"claude-code", title:"Tests passing",      detail:"All 47 tests passed · coverage 94% · 8.4s" },
];

const W_IDLE           = 56;
const W_ACTIVE         = 224;
const W_ACTIVE_MUTED   = 148;
const W_HOVER          = 320;
const H_ACTIVE         = 28;
const H_LIST           = 200;
const H_DETAIL         = 172;
const H_TIMER          = 96;
const H_ITEM           = 22;
const OVERSHOOT        = 16;
const CYCLE_MS         = 2400;
const BREAK_INTERVAL   = 60;
const REST_DURATION    = 15;
const PEEK_MS          = 3000;
const PEEK_INTERVAL_MS = 8000;

const AGENT_ICONS: Record<string, { src: string; filter?: string }> = {
  "claude-code": { src: "/agents/claude-code.svg" },
  "cursor":      { src: "/agents/cursor.svg",    filter: "brightness(0) invert(1)" },
  "codex":       { src: "/agents/codex.svg",     filter: "brightness(0) invert(1)" },
  "copilot":     { src: "/agents/copilot.svg",   filter: "brightness(0) invert(1)" },
  "gemini-cli":  { src: "/agents/gemini-cli.svg" },
  "aider":       { src: "/agents/aider.svg",     filter: "brightness(0) invert(1)" },
  "windsurf":    { src: "/agents/windsurf.svg",  filter: "brightness(0) invert(1)" },
};

function fmtTime(s: number) {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function TimerArc({ progress, color }: { progress: number; color: string }) {
  const r = 9; const circ = 2 * Math.PI * r;
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx={12} cy={12} r={r} strokeWidth={2.5}
        style={{ stroke: "var(--tempest-border-default)" }} />
      <circle cx={12} cy={12} r={r} strokeWidth={2.5} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - Math.min(progress, 1))}
        transform="rotate(-90 12 12)"
        style={{ stroke: color }} />
    </svg>
  );
}

export function DynamicIsland() {
  const root           = useRef<HTMLDivElement>(null);
  const pill           = useRef<HTMLDivElement>(null);
  const compactLayer   = useRef<HTMLDivElement>(null);
  const expandedLayer  = useRef<HTMLDivElement>(null);
  const ticker         = useRef<HTMLSpanElement>(null);
  const bellNormalRef  = useRef<HTMLDivElement>(null);
  const bellMutedRef   = useRef<HTMLSpanElement>(null);
  const normalRightRef = useRef<HTMLDivElement>(null);
  const silentRef      = useRef<HTMLSpanElement>(null);

  const phaseRef        = useRef<Phase>("idle");
  const mutedRef        = useRef(false);
  const isListViewRef   = useRef(true);
  const timerStateRef   = useRef<TimerState>("off");
  const timerPausedRef  = useRef(false);
  const notifCompactRef = useRef<HTMLDivElement>(null);
  const timerCompactRef = useRef<HTMLDivElement>(null);
  const muteTimelineRef = useRef<gsap.core.Timeline | null>(null);

  const [phase,        setPhase]        = useState<Phase>("idle");
  const [notif,        setNotif]        = useState<Notif>(NOTIFS[0]);
  const [tickerText,   setTickerText]   = useState("New");
  const [isListView,   setIsListView]   = useState(true);
  const [hoveredRow,   setHoveredRow]   = useState<string | null>(null);
  const [timerState,   setTimerState]   = useState<TimerState>("off");
  const [timerElapsed, setTimerElapsed] = useState(0);
  const [restElapsed,  setRestElapsed]  = useState(0);
  const [timerPaused,  setTimerPaused]  = useState(false);
  const [timerNotif,   setTimerNotif]   = useState<Notif | null>(null);
  const [muted,        setMuted]        = useState(false);
  const [timerShowList,setTimerShowList]= useState(false);

  function syncPhase(p: Phase)      { phaseRef.current = p; setPhase(p); }
  function syncListView(v: boolean) { isListViewRef.current = v; setIsListView(v); }

  const { contextSafe } = useGSAP(() => {
    gsap.set(pill.current,           { width: W_IDLE, height: H_ACTIVE, xPercent: -50 });
    gsap.set(compactLayer.current,   { autoAlpha: 0 });
    gsap.set(expandedLayer.current,  { autoAlpha: 0 });
    gsap.set(ticker.current,         { y: 0, autoAlpha: 1 });
    gsap.set(bellMutedRef.current,   { opacity: 0, clipPath: "inset(0 100% 0 0 round 999px)" });
    gsap.set(silentRef.current,      { opacity: 0, y: 8 });
    gsap.set(notifCompactRef.current, { opacity: 1 });
    gsap.set(timerCompactRef.current, { opacity: 0 });
  }, { scope: root });

  const toActive = contextSafe(() => {
    if (phaseRef.current !== "idle") return;
    setTickerText("New"); setNotif(NOTIFS[0]); syncListView(true);
    gsap.set(ticker.current, { y: 0, autoAlpha: 1 });
    syncPhase("active");
    gsap.timeline()
      .to(pill.current, { width: W_ACTIVE + OVERSHOOT, height: H_ACTIVE, duration: 0.38, ease: "power3.out" })
      .to(pill.current, { width: W_ACTIVE, duration: 0.9, ease: "elastic.out(1, 0.4)" })
      .to(compactLayer.current, { autoAlpha: 1, duration: 0.22, ease: "power2.out" }, "-=0.7");
  });

  const toIdle = contextSafe(() => {
    syncPhase("idle");
    gsap.timeline()
      .to([compactLayer.current, expandedLayer.current], { autoAlpha: 0, duration: 0.15 })
      .to(pill.current, { width: W_IDLE, height: H_ACTIVE, borderRadius: 32, duration: 0.35, ease: "power3.inOut" });
  });

  const doHover = contextSafe(() => {
    if (phaseRef.current !== "active") return;
    if (mutedRef.current && timerStateRef.current === "off") return;
    if (muteTimelineRef.current) {
      muteTimelineRef.current.kill();
      muteTimelineRef.current = null;
      mutedRef.current = false;
      setMuted(false);
      gsap.set(notifCompactRef.current,  { opacity: 0 });
      gsap.set(timerCompactRef.current,  { opacity: 1 });
      gsap.set(pill.current,             { width: W_ACTIVE });
      gsap.set(bellNormalRef.current,    { x: 0, opacity: 1 });
      gsap.set(bellMutedRef.current,     { opacity: 0, clipPath: "inset(0 100% 0 0 round 999px)" });
      gsap.set(normalRightRef.current,   { y: 0, opacity: 1 });
      gsap.set(silentRef.current,        { y: 8, opacity: 0 });
    }
    gsap.killTweensOf(pill.current);
    syncPhase("hovered");
    const targetH = timerStateRef.current !== "off"
      ? H_TIMER
      : isListViewRef.current ? H_LIST : H_DETAIL;
    gsap.timeline()
      .to(compactLayer.current, { autoAlpha: 0, duration: 0.12 })
      .to(pill.current, { width: W_HOVER, height: targetH, borderRadius: 18, duration: 0.42, ease: "power3.out" }, "-=0.05")
      .to(expandedLayer.current, { autoAlpha: 1, duration: 0.22, ease: "power2.out" }, "-=0.18");
  });

  const doUnhover = contextSafe(() => {
    if (phaseRef.current !== "hovered") return;
    syncListView(true);
    setTimerShowList(false);
    gsap.killTweensOf(pill.current);
    syncPhase("active");
    gsap.timeline()
      .to(expandedLayer.current, { autoAlpha: 0, duration: 0.12 })
      .to(pill.current, { width: W_ACTIVE, height: H_ACTIVE, borderRadius: 32, duration: 0.38, ease: "power3.inOut" }, "-=0.05")
      .to(compactLayer.current, { autoAlpha: 1, duration: 0.2 }, "-=0.15");
  });

  const toDetail = contextSafe((n: Notif) => {
    if (phaseRef.current !== "hovered") return;
    setNotif(n); syncListView(false);
    gsap.to(pill.current, { height: H_DETAIL, duration: 0.25, ease: "power2.out" });
  });

  const toListView = contextSafe(() => {
    if (phaseRef.current !== "hovered") return;
    syncListView(true);
    gsap.to(pill.current, { height: H_LIST, duration: 0.25, ease: "power2.out" });
  });

  const tickerTo = contextSafe((text: string, n?: Notif) => {
    gsap.timeline()
      .to(ticker.current, { y: -8, autoAlpha: 0, duration: 0.2, ease: "power2.in" })
      .call(() => { setTickerText(text); if (n) setNotif(n); })
      .set(ticker.current, { y: 8 })
      .to(ticker.current, { y: 0, autoAlpha: 1, duration: 0.25, ease: "power2.out" });
  });

  const toMuted = contextSafe(() => {
    if (mutedRef.current) return;
    mutedRef.current = true;
    setMuted(true);
    gsap.killTweensOf([bellNormalRef.current, bellMutedRef.current, normalRightRef.current, silentRef.current]);
    if (timerStateRef.current !== "off") {
      if (muteTimelineRef.current) muteTimelineRef.current.kill();
      gsap.set(bellNormalRef.current,  { x: 0, opacity: 1 });
      gsap.set(bellMutedRef.current,   { opacity: 0, clipPath: "inset(0 100% 0 0 round 999px)" });
      gsap.set(normalRightRef.current, { y: 0, opacity: 1 });
      gsap.set(silentRef.current,      { y: 8, opacity: 0 });
      muteTimelineRef.current = gsap.timeline()
        .to(timerCompactRef.current,   { opacity: 0, duration: 0.12 })
        .to(notifCompactRef.current,   { opacity: 1, duration: 0.12 }, "<")
        .to(bellNormalRef.current,     { x: -3, duration: 0.07, ease: "power2.out" })
        .to(bellNormalRef.current,     { x:  3, duration: 0.07 })
        .to(bellNormalRef.current,     { x: -2, duration: 0.07 })
        .to(bellNormalRef.current,     { x:  0, duration: 0.07 })
        .to(bellNormalRef.current,     { opacity: 0, duration: 0.18 }, "+=0")
        .to(pill.current,              { width: W_ACTIVE_MUTED, duration: 0.35, ease: "power3.inOut" }, "<")
        .to(bellMutedRef.current,      { opacity: 1, clipPath: "inset(0 0% 0 0 round 999px)", duration: 0.28, ease: "power2.out" }, "<")
        .to(normalRightRef.current,    { y: -8, opacity: 0, duration: 0.2, ease: "power2.in" }, "<")
        .set(silentRef.current,        { y: 8, opacity: 0 })
        .to(silentRef.current,         { y: 0, opacity: 1, duration: 0.25, ease: "power2.out" }, "-=0.05")
        .to(notifCompactRef.current,   { opacity: 0, duration: 0.2, delay: 2.5 })
        .to(timerCompactRef.current,   { opacity: 1, duration: 0.2 }, "<")
        .to(pill.current,              { width: W_ACTIVE, duration: 0.25, ease: "power3.inOut" }, "<")
        .set(bellNormalRef.current,    { x: 0, opacity: 1 })
        .set(bellMutedRef.current,     { opacity: 0, clipPath: "inset(0 100% 0 0 round 999px)" })
        .set(normalRightRef.current,   { y: 0, opacity: 1 })
        .set(silentRef.current,        { y: 8, opacity: 0 })
        .call(() => { mutedRef.current = false; setMuted(false); muteTimelineRef.current = null; });
      return;
    }
    if (phaseRef.current === "hovered") {
      gsap.set(expandedLayer.current, { autoAlpha: 0 });
      gsap.set(compactLayer.current,  { autoAlpha: 1 });
      gsap.set(pill.current,          { borderRadius: 32, height: H_ACTIVE });
    }
    syncPhase("active");
    gsap.timeline()
      .to(bellNormalRef.current,  { x: -3, duration: 0.07, ease: "power2.out" })
      .to(bellNormalRef.current,  { x:  3, duration: 0.07 })
      .to(bellNormalRef.current,  { x: -2, duration: 0.07 })
      .to(bellNormalRef.current,  { x:  0, duration: 0.07 })
      .to(bellNormalRef.current,  { opacity: 0, duration: 0.18 }, "+=0")
      .to(pill.current,           { width: W_ACTIVE_MUTED, duration: 0.35, ease: "power3.inOut" }, "<")
      .to(bellMutedRef.current,   { opacity: 1, clipPath: "inset(0 0% 0 0 round 999px)", duration: 0.28, ease: "power2.out" }, "<")
      .to(normalRightRef.current, { y: -8, opacity: 0, duration: 0.2, ease: "power2.in" }, "<")
      .set(silentRef.current,     { y: 8, opacity: 0 })
      .to(silentRef.current,      { y: 0, opacity: 1, duration: 0.25, ease: "power2.out" }, "-=0.05");
  });

  const toUnmuted = contextSafe(() => {
    if (!mutedRef.current) return;
    mutedRef.current = false;
    setMuted(false);
    if (timerStateRef.current !== "off") {
      if (muteTimelineRef.current) { muteTimelineRef.current.kill(); muteTimelineRef.current = null; }
      gsap.set(notifCompactRef.current,  { opacity: 0 });
      gsap.set(timerCompactRef.current,  { opacity: 1 });
      gsap.set(pill.current,             { width: W_ACTIVE });
      gsap.set(bellNormalRef.current,    { x: 0, opacity: 1 });
      gsap.set(bellMutedRef.current,     { opacity: 0, clipPath: "inset(0 100% 0 0 round 999px)" });
      gsap.set(normalRightRef.current,   { y: 0, opacity: 1 });
      gsap.set(silentRef.current,        { y: 8, opacity: 0 });
      return;
    }
    gsap.killTweensOf([bellNormalRef.current, bellMutedRef.current, normalRightRef.current, silentRef.current]);
    gsap.timeline()
      .to(silentRef.current,       { y: -8, opacity: 0, duration: 0.2, ease: "power2.in" })
      .set(normalRightRef.current, { y: 8, opacity: 0 })
      .to(normalRightRef.current,  { y: 0, opacity: 1, duration: 0.25, ease: "power2.out" }, "-=0.05")
      .to(bellMutedRef.current,    { opacity: 0, clipPath: "inset(0 100% 0 0 round 999px)", duration: 0.25, ease: "power2.in" }, "<")
      .to(pill.current,            { width: W_ACTIVE, duration: 0.35, ease: "power3.inOut" }, "<")
      .to(bellNormalRef.current,   { x: 0, opacity: 1, duration: 0.2 }, "-=0.1");
  });

  const startTimer = contextSafe(() => {
    if (timerStateRef.current !== "off") return;
    const wasPhase = phaseRef.current;
    timerStateRef.current = "working";
    setTimerState("working");
    gsap.set(notifCompactRef.current, { opacity: 0 });
    gsap.set(timerCompactRef.current, { opacity: 1 });
    setTimerElapsed(0); setRestElapsed(0);
    setTimerPaused(false); timerPausedRef.current = false;
    setTimerNotif(null); setTimerShowList(false); syncListView(true);
    mutedRef.current = false;
    syncPhase("active");

    if (wasPhase === "idle") {
      gsap.timeline()
        .to(pill.current, { width: W_ACTIVE + OVERSHOOT, height: H_ACTIVE, duration: 0.38, ease: "power3.out" })
        .to(pill.current, { width: W_ACTIVE, duration: 0.9, ease: "elastic.out(1, 0.4)" })
        .to(compactLayer.current, { autoAlpha: 1, duration: 0.22, ease: "power2.out" }, "-=0.7");
    } else if (wasPhase === "hovered") {
      gsap.timeline()
        .to(expandedLayer.current, { autoAlpha: 0, duration: 0.12 })
        .to(pill.current, { width: W_ACTIVE, height: H_ACTIVE, borderRadius: 32, duration: 0.38, ease: "power3.inOut" }, "-=0.05")
        .to(compactLayer.current, { autoAlpha: 1, duration: 0.2 }, "-=0.15");
    }
  });

  const stopTimer = contextSafe(() => {
    if (muteTimelineRef.current) { muteTimelineRef.current.kill(); muteTimelineRef.current = null; }
    gsap.set(notifCompactRef.current, { opacity: 1 });
    gsap.set(timerCompactRef.current, { opacity: 0 });
    timerStateRef.current = "off";
    setTimerState("off");
    setTimerElapsed(0); setRestElapsed(0);
    setTimerPaused(false); timerPausedRef.current = false;
    setTimerNotif(null); setTimerShowList(false);
    syncPhase("idle");
    gsap.to(pill.current, { backgroundColor: cssVar("--tempest-island-bg-open"), duration: 0.3 });
    gsap.timeline()
      .to([compactLayer.current, expandedLayer.current], { autoAlpha: 0, duration: 0.15 })
      .to(pill.current, { width: W_IDLE, height: H_ACTIVE, borderRadius: 32, duration: 0.35, ease: "power3.inOut" });
  });

  const openTimerList = contextSafe(() => {
    setTimerShowList(true);
    syncListView(true);
    setTimerNotif(null);
    gsap.to(pill.current, { height: H_LIST, duration: 0.25, ease: "power2.out" });
  });

  const closeTimerList = contextSafe(() => {
    setTimerShowList(false);
    syncListView(true);
    gsap.to(pill.current, { height: H_TIMER, duration: 0.25, ease: "power2.out" });
  });

  const isIdle = phase === "idle";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isIdle || timerState !== "off") return;
    const latest = NOTIFS[NOTIFS.length - 1];
    const ts: ReturnType<typeof setTimeout>[] = [];
    ts.push(setTimeout(() => {
      if (phaseRef.current === "active" && !mutedRef.current) {
        tickerTo(latest.title, latest);
        ts.push(setTimeout(() => {
          if (phaseRef.current === "active" && !mutedRef.current) tickerTo("New");
        }, CYCLE_MS));
      }
    }, CYCLE_MS));
    return () => ts.forEach(clearTimeout);
  }, [isIdle, timerState]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "y") {
        e.preventDefault();
        if (timerStateRef.current !== "off") stopTimer(); else startTimer();
      }
      if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        if (timerStateRef.current !== "off") {
          if (phaseRef.current === "active") doHover();
          else if (phaseRef.current === "hovered") openTimerList();
        } else if (phaseRef.current === "idle") {
          toActive();
        } else {
          toIdle();
        }
      }
      if (e.ctrlKey && e.key === "m") {
        e.preventDefault();
        const p = phaseRef.current;
        if (p === "active" || p === "hovered") {
          if (mutedRef.current) toUnmuted(); else toMuted();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phase !== "hovered") return;
    const handler = (e: MouseEvent) => {
      if (!pill.current || !e.composedPath().includes(pill.current)) {
        doUnhover();
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [phase]);

  useEffect(() => {
    if (timerState !== "working" || timerPaused) return;
    const id = setInterval(() => setTimerElapsed(s => Math.min(s + 1, BREAK_INTERVAL)), 1000);
    return () => clearInterval(id);
  }, [timerState, timerPaused]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (timerElapsed < BREAK_INTERVAL || timerState !== "working") return;
    timerStateRef.current = "resting";
    setTimerState("resting");
    setRestElapsed(0);
  }, [timerElapsed, timerState]);

  useEffect(() => {
    if (timerState !== "resting" || timerPaused) return;
    const id = setInterval(() => setRestElapsed(s => Math.min(s + 1, REST_DURATION)), 1000);
    return () => clearInterval(id);
  }, [timerState, timerPaused]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (restElapsed < REST_DURATION || timerState !== "resting") return;
    timerStateRef.current = "working";
    setTimerState("working");
    setTimerElapsed(0);
  }, [restElapsed, timerState]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pill.current) return;
    gsap.to(pill.current, {
      backgroundColor: timerState === "resting"
        ? cssVar("--tempest-island-timer-rest-bg")
        : cssVar("--tempest-island-bg-open"),
      duration: 0.6,
    });
  }, [timerState]);

  useEffect(() => {
    if (timerState === "off") return;
    let idx = 0;
    const id = setInterval(() => {
      if (!timerPausedRef.current && !mutedRef.current) {
        const n = NOTIFS[idx % NOTIFS.length];
        idx++;
        setTimerNotif(n);
        setTimeout(() => setTimerNotif(null), PEEK_MS);
      }
    }, PEEK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [timerState]);

  const isResting     = timerState === "resting";
  const timerColor    = isResting ? "var(--tempest-island-timer-rest-color)" : "var(--tempest-island-timer-color)";
  const arcProgress   = isResting ? restElapsed / REST_DURATION : timerElapsed / BREAK_INTERVAL;
  const timeRemaining = isResting ? REST_DURATION - restElapsed : BREAK_INTERVAL - timerElapsed;
  const activeNotifs  = NOTIFS.filter(n => n.type === "permission");
  const doneNotifs    = NOTIFS.filter(n => n.type === "done");
  const detailIdx     = NOTIFS.findIndex(n => n.id === notif.id);

  const NotifRow = ({ n }: { n: Notif }) => (
    <div
      onClick={() => toDetail(n)}
      onMouseEnter={() => setHoveredRow(n.id)}
      onMouseLeave={() => setHoveredRow(null)}
      style={{
        display: "flex", alignItems: "center", gap: 8, height: H_ITEM, flexShrink: 0,
        cursor: "pointer", borderRadius: 6, padding: "0 4px",
        background: hoveredRow === n.id ? "var(--tempest-bg-hover)" : "transparent",
        transition: "background 0.15s",
      }}
    >
      {n.type === "permission"
        ? <ShieldAlert  size={12} style={{ flexShrink: 0, color: "var(--tempest-island-perm-color)" }} />
        : <CheckCircle2 size={12} style={{ flexShrink: 0, color: "var(--tempest-semantic-success)" }} />}
      <span style={listTitleStyle}>{n.title}</span>
      <span style={listAgentStyle}>{n.agent}</span>
    </div>
  );

  return (
    <div ref={root} className="island-root" style={{ pointerEvents: "none" }}>
      {/* ── Pill ── */}
      <div
        ref={pill}
        onClick={(e) => {
          e.stopPropagation();
          if (phaseRef.current === "active") doHover();
        }}
        style={{
          position: "absolute", top: 0, left: "50%",
          overflow: "hidden", borderRadius: 32,
          border: "1px solid var(--tempest-island-border-open)",
          background: "var(--tempest-island-bg-open)",
          pointerEvents: "auto",
          cursor: phase === "active" ? "pointer" : "default",
        }}
      >
        {/* ── Compact layer ── */}
        <div ref={compactLayer} style={{ position: "absolute", top: 0, left: 0, right: 0, height: H_ACTIVE }}>
          {/* Notif compact */}
          <div ref={notifCompactRef} style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px",
            pointerEvents: timerState === "off" ? "auto" : "none",
          }}>
            <div style={{ position: "relative", width: 34, height: H_ACTIVE, flexShrink: 0 }}>
              <div ref={bellNormalRef} style={{ position: "absolute", left: 0, top: "50%", marginTop: -6 }}>
                <Bell size={12} strokeWidth={2} fill="currentColor" style={{ color: "var(--tempest-fg-default)" }} />
              </div>
              <span ref={bellMutedRef} style={{
                position: "absolute", left: 0, top: "50%", marginTop: -8,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                padding: "2px 10px", borderRadius: 999,
                background: "var(--tempest-island-mute-bg)", whiteSpace: "nowrap",
              }}>
                <BellOff size={12} strokeWidth={2} fill="currentColor" style={{ color: "#fff" }} />
              </span>
            </div>
            <div ref={normalRightRef} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={badgeStyle}>{NOTIFS.length}</span>
              <span ref={ticker} style={tickerTextStyle}>{tickerText}</span>
            </div>
            <span ref={silentRef} style={{ ...tickerTextStyle, color: "var(--tempest-island-mute-bg)", fontWeight: 600,
              position: "absolute", right: 12, top: "50%", marginTop: -6 }}>
              Silent
            </span>
          </div>

          {/* Timer compact */}
          <div ref={timerCompactRef} style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px",
            pointerEvents: timerState !== "off" ? "auto" : "none",
          }}>
            {timerNotif && phase === "active" ? (
              <>
                {timerNotif.type === "permission"
                  ? <ShieldAlert  size={12} style={{ flexShrink: 0, color: "var(--tempest-island-perm-color)" }} />
                  : <CheckCircle2 size={12} style={{ flexShrink: 0, color: "var(--tempest-semantic-success)" }} />}
                <span style={{
                  fontSize: 11, color: "var(--tempest-fg-default)", flex: 1, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 6,
                  fontFamily: "Geist, system-ui, sans-serif", fontWeight: 500,
                }}>
                  {timerNotif.title}
                </span>
              </>
            ) : (
              <>
                <TimerArc progress={arcProgress} color={muted ? "var(--tempest-fg-subtle)" : timerColor} />
                <span style={{
                  fontSize: 14,
                  color: muted ? "var(--tempest-fg-subtle)" : timerColor,
                  fontFamily: "Geist, system-ui, sans-serif",
                  fontWeight: 500, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em",
                }}>
                  {fmtTime(timeRemaining)}
                </span>
              </>
            )}
          </div>
        </div>

        {/* ── Expanded layer ── */}
        <div ref={expandedLayer} style={{
          position: "absolute", inset: 0,
          padding: "10px 14px",
          display: "flex", flexDirection: "column",
          boxSizing: "border-box",
        }}>

          {/* ── Timer expanded ── */}
          {timerState !== "off" && !timerShowList ? (
            timerNotif ? (
              <div
                onClick={() => openTimerList()}
                style={{
                  height: "100%", display: "flex", alignItems: "center", gap: 10, padding: "0 2px",
                  cursor: "pointer", borderRadius: 8, background: "var(--tempest-bg-selection)",
                }}
              >
                {timerNotif.type === "permission"
                  ? <ShieldAlert  size={22} style={{ flexShrink: 0, color: "var(--tempest-island-perm-color)" }} />
                  : <CheckCircle2 size={22} style={{ flexShrink: 0, color: "var(--tempest-semantic-success)" }} />}
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--tempest-fg-default)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {timerNotif.title}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--tempest-fg-muted)", marginTop: 2,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {timerNotif.detail}
                  </div>
                </div>
                <ChevronRight size={12} style={{ flexShrink: 0, color: "var(--tempest-fg-subtle)" }} />
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => {
                        if (isResting) {
                          timerStateRef.current = "working";
                          setTimerState("working");
                          setTimerElapsed(0);
                        } else {
                          timerPausedRef.current = !timerPausedRef.current;
                          setTimerPaused(p => !p);
                        }
                      }}
                      style={{
                        width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        background: isResting
                          ? "color-mix(in srgb, var(--tempest-island-timer-rest-color) 20%, transparent)"
                          : timerPaused ? "var(--tempest-bg-active)" : "var(--tempest-island-timer-color)",
                      }}
                    >
                      {isResting
                        ? <Play  size={16} style={{ fill: "var(--tempest-island-timer-rest-color)", color: "var(--tempest-island-timer-rest-color)" }} />
                        : timerPaused
                          ? <Play  size={16} style={{ fill: "var(--tempest-island-timer-color)", color: "var(--tempest-island-timer-color)" }} />
                          : <Pause size={16} style={{ fill: "#000", color: "#000" }} />}
                    </button>
                    <button
                      onClick={() => stopTimer()}
                      style={{
                        width: 40, height: 40, borderRadius: "50%", border: "none", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        background: "var(--tempest-fg-subtle)",
                        opacity: 0.45,
                      }}
                    >
                      <X size={16} style={{ color: "var(--tempest-fg-default)" }} strokeWidth={2.5} />
                    </button>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <span style={{
                      fontSize: 9,
                      color: isResting
                        ? "color-mix(in srgb, var(--tempest-island-timer-rest-color) 60%, transparent)"
                        : "var(--tempest-fg-subtle)",
                      fontFamily: "Geist, system-ui, sans-serif",
                      fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", lineHeight: 1,
                    }}>
                      {isResting ? "Rest" : "Break in"}
                    </span>
                    <span style={{
                      fontSize: 28, color: timerColor, lineHeight: 1.05, letterSpacing: "-0.03em",
                      fontFamily: "Geist, system-ui, sans-serif", fontWeight: 600,
                      fontVariantNumeric: "tabular-nums",
                    }}>
                      {fmtTime(timeRemaining)}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <TimerArc progress={arcProgress} color={timerColor} />
                  <button
                    onClick={() => openTimerList()}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", borderRadius: 999,
                      background: "var(--tempest-bg-hover)",
                      border: "1px solid var(--tempest-border-default)",
                      cursor: "pointer",
                    }}
                  >
                    <Bell size={9} style={{ color: "var(--tempest-fg-muted)" }} />
                    <span style={{
                      fontSize: 10, color: "var(--tempest-fg-muted)",
                      fontFamily: "Geist, system-ui, sans-serif",
                    }}>
                      Notifications
                    </span>
                    <span style={smallBadgeStyle}>{NOTIFS.length}</span>
                  </button>
                </div>
              </div>
            )

          ) : isListView ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              {timerState !== "off" && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6, flexShrink: 0 }}>
                  <button onClick={() => closeTimerList()} style={backBtnStyle}>
                    <ChevronLeft size={12} />
                  </button>
                  <span style={groupLabelStyle}>Notification Center</span>
                </div>
              )}
              <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column" }}>
                {activeNotifs.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
                    <span style={groupLabelStyle}>Active</span>
                    {activeNotifs.map(n => <NotifRow key={n.id} n={n} />)}
                  </div>
                )}
                {doneNotifs.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={groupLabelStyle}>Done</span>
                    {doneNotifs.map(n => <NotifRow key={n.id} n={n} />)}
                  </div>
                )}
              </div>
            </div>

          ) : (
            <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <button onClick={() => toListView()} style={backBtnStyle}>
                  <ChevronLeft size={12} />
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <button onClick={() => toDetail(NOTIFS[(detailIdx - 1 + NOTIFS.length) % NOTIFS.length])} style={navArrowStyle}>
                    <ChevronLeft size={10} />
                  </button>
                  <span style={navCountStyle}>{detailIdx + 1} / {NOTIFS.length}</span>
                  <button onClick={() => toDetail(NOTIFS[(detailIdx + 1) % NOTIFS.length])} style={navArrowStyle}>
                    <ChevronRight size={10} />
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 12, flex: 1, alignItems: "flex-start" }}>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                  {notif.type === "permission"
                    ? <ShieldAlert  size={26} style={{ flexShrink: 0, color: "var(--tempest-island-perm-color)" }} />
                    : <CheckCircle2 size={26} style={{ flexShrink: 0, color: "var(--tempest-semantic-success)" }} />}
                  <div>
                    <div style={detailTitleStyle}>{notif.title}</div>
                    <div style={detailBodyStyle}>{notif.detail}</div>
                  </div>
                </div>
                <div style={{
                  width: 62, height: 62, borderRadius: 14, flexShrink: 0,
                  background: notif.type === "permission"
                    ? "color-mix(in srgb, var(--tempest-island-perm-color) 8%, transparent)"
                    : "color-mix(in srgb, var(--tempest-semantic-success) 8%, transparent)",
                  border: "1px solid var(--tempest-border-default)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {AGENT_ICONS[notif.agent] && (
                    <img src={AGENT_ICONS[notif.agent].src} alt={notif.agent}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      style={{ width: 32, height: 32, objectFit: "contain", filter: AGENT_ICONS[notif.agent].filter }} />
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {notif.type === "permission" ? (
                  <>
                    <button style={denyBtnStyle}>Ignore</button>
                    <button style={allowBtnStyle}>View Agent</button>
                  </>
                ) : (
                  <button style={{ ...allowBtnStyle, flex: 1 }}>View Agent</button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const badgeStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minWidth: 16, height: 16, padding: "1px 4px 0",
  borderRadius: 999, background: "var(--tempest-island-perm-color)",
  color: "#000", fontSize: 10, fontWeight: 600, lineHeight: 1,
  flexShrink: 0, fontVariantNumeric: "tabular-nums",
};

const smallBadgeStyle: React.CSSProperties = {
  background: "var(--tempest-island-perm-color)", color: "#000", borderRadius: 999,
  padding: "1px 4px", fontSize: 9, fontWeight: 700, lineHeight: 1,
};

const tickerTextStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 500, color: "var(--tempest-fg-default)",
  fontFamily: "Geist, system-ui, sans-serif",
  whiteSpace: "nowrap", letterSpacing: "-0.01em", lineHeight: 1,
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, color: "var(--tempest-fg-subtle)",
  fontFamily: "Geist, system-ui, sans-serif",
  letterSpacing: "0.07em", textTransform: "uppercase",
  paddingLeft: 4, lineHeight: 1,
};

const listTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 500, color: "var(--tempest-fg-default)",
  fontFamily: "Geist, system-ui, sans-serif",
  flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

const listAgentStyle: React.CSSProperties = {
  fontSize: 10, color: "var(--tempest-fg-subtle)",
  fontFamily: "Geist, system-ui, sans-serif",
  flexShrink: 0, whiteSpace: "nowrap",
};

const detailTitleStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "var(--tempest-fg-default)",
  fontFamily: "Geist, system-ui, sans-serif", marginBottom: 3,
};

const detailBodyStyle: React.CSSProperties = {
  fontSize: 11, color: "var(--tempest-fg-muted)",
  fontFamily: "Geist, system-ui, sans-serif", lineHeight: 1.45,
};

const denyBtnStyle: React.CSSProperties = {
  flex: 1, padding: "6px 0", borderRadius: 999, border: "none",
  background: "var(--tempest-bg-hover)", color: "var(--tempest-fg-default)",
  fontSize: 11, fontWeight: 500, cursor: "pointer",
  fontFamily: "Geist, system-ui, sans-serif",
};

const allowBtnStyle: React.CSSProperties = {
  flex: 1, padding: "6px 0", borderRadius: 999, border: "none",
  background: "var(--tempest-island-allow-bg)", color: "var(--tempest-accent-blue)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  fontFamily: "Geist, system-ui, sans-serif",
};

const backBtnStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "none", border: "none", padding: "2px 4px",
  cursor: "pointer", color: "var(--tempest-fg-subtle)", borderRadius: 4,
};

const navArrowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "var(--tempest-bg-hover)", border: "none", padding: "2px 5px",
  cursor: "pointer", color: "var(--tempest-fg-muted)", borderRadius: 4,
};

const navCountStyle: React.CSSProperties = {
  fontSize: 10, color: "var(--tempest-fg-subtle)",
  fontFamily: "Geist, system-ui, sans-serif",
  fontVariantNumeric: "tabular-nums", minWidth: 28, textAlign: "center",
};
