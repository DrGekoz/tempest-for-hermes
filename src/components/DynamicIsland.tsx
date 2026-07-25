import { useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition, type Variants } from "motion/react";
import { formatReset, levelOf, pct, peakQuota, type QuotaWindow } from "../lib/quota";
import "./DynamicIsland.css";

/** Arrives fast, overshoots a little, settles. Interruptible mid-flight. */
const SPRING: Transition = { type: "spring", stiffness: 420, damping: 36, mass: 0.9 };

const PANEL: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { staggerChildren: 0.045, delayChildren: 0.05 } },
};

const ROW: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0 },
};

/**
 * Toolbar island for live rate-limit windows.
 *
 * Quiet when there is room — a fill ring and nothing else. As a window fills it
 * widens and names the one that is filling. Hover (or focus) opens every window
 * with its bar and reset time.
 *
 * Every size here comes from content: `layout` morphs the shape to whatever the
 * labels need, so nothing is a hardcoded width waiting to truncate.
 *
 * Presentational: no polling, no fetching. Renders nothing without data, so it
 * is inert until a reader supplies `quotas`.
 */
export function DynamicIsland({ quotas }: { quotas: QuotaWindow[] }) {
  const [open, setOpen] = useState(false);
  const still = useReducedMotion();
  const spring = still ? { duration: 0 } : SPRING;

  const peak = peakQuota(quotas);
  if (!peak) return null;

  const level = levelOf(peak.used);

  return (
    // Full-width, click-through anchor: the island is flex-centred inside it, so
    // `layout` owns the element's own transform without fighting a translate.
    <div className="island-anchor">
      <motion.div
        layout
        className="island"
        data-level={level}
        data-open={open || undefined}
        tabIndex={0}
        role="group"
        aria-label={`Usage limits — ${peak.label} at ${pct(peak.used)} percent`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        animate={{ borderRadius: open ? 18 : 999 }}
        transition={spring}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {!open ? (
            <motion.div
              key="pill"
              layout="position"
              className="island-pill"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: still ? 0 : 0.14 }}
            >
              {/* --fill drives the conic arc; the ring is one element, no SVG. */}
              <span className="island-gauge" style={{ "--fill": pct(peak.used) } as CSSProperties} />
              {level !== "ok" && (
                <span className="island-peak">
                  <span className="island-peak-label">{peak.label}</span>
                  <span className="island-peak-pct">{pct(peak.used)}%</span>
                </span>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="panel"
              layout="position"
              className="island-panel"
              variants={PANEL}
              initial="hidden"
              animate="shown"
              exit="hidden"
              transition={{ duration: still ? 0 : 0.18 }}
            >
              <motion.div className="island-title" variants={ROW}>Usage</motion.div>
              {quotas.map(q => (
                <motion.div className="island-row" key={q.id} data-level={levelOf(q.used)} variants={ROW}>
                  <div className="island-row-head">
                    <span className="island-row-label">{q.label}</span>
                    <span className="island-row-pct">{pct(q.used)}%</span>
                  </div>
                  <div className="island-bar">
                    <motion.div
                      className="island-bar-fill"
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: pct(q.used) / 100 }}
                      transition={still ? { duration: 0 } : { ...SPRING, delay: 0.12 }}
                    />
                  </div>
                  <div className="island-row-reset">{formatReset(q.resetsAt)}</div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
