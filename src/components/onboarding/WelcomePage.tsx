import { Component, type ReactNode, useState, useEffect } from 'react';
import { CircleArrowRight } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { MetalFx } from 'metal-fx';
import { useTheme } from '../../themes/ThemeContext';
import { TempestLogo } from '../../assets/TempestLogo';

interface Props { onComplete: () => void; }

// A decorative WebGL effect must never take down the app. WebKitGTK (Linux)
// exposes OffscreenCanvas but not an OffscreenCanvas WebGL context, so metal-fx
// throws "WebGL not supported" on mount. Isolate it and fall back to the plain
// child button so onboarding still renders.
class GfxBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// ── Page 0 — Welcome ────────────────────────────────────────────
export default function WelcomePage({ onComplete }: Props) {
  const { theme } = useTheme();
  const isDark = theme.type === 'dark';

  const [version, setVersion] = useState('');
  useEffect(() => { getVersion().then(setVersion); }, []);

  return (
    <div className="ob-blank">
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '18px', transform: 'translateY(3px)' }}>
        <TempestLogo style={{ height: '36px', width: 'auto', alignSelf: 'flex-start', transform: 'translateY(-6px)', color: 'var(--tempest-fg-default)' }} />
        <p style={{
          fontSize: '16px',
          fontWeight: 400,
          color: 'var(--tempest-fg-muted)',
          letterSpacing: '-0.2px',
          lineHeight: 1.4,
          maxWidth: '452px',
          margin: '-8px 0 0',
        }}>
          Run your AI coding agents in parallel with 64% fewer tokens and deeper codebase understanding
        </p>
        <GfxBoundary
          fallback={
            <div className="ob-metal">
              <button className="ob-blank-btn" onClick={onComplete}>
                Get Started
                <CircleArrowRight size={21} />
              </button>
            </div>
          }
        >
          <MetalFx className="ob-metal" preset="chromatic" strength={0.78} theme={isDark ? 'light' : 'dark'} borderRadius={8} ringCssPx={3}>
            <button className="ob-blank-btn" onClick={onComplete}>
              Get Started
              <CircleArrowRight size={21} />
            </button>
          </MetalFx>
        </GfxBoundary>
      </div>

      <div className="ob-box" />

      <div className="ob-footer">
        <div className="ob-blank-license">
          <button className="ob-license-link" onClick={() => openUrl('https://github.com/tempestai-dev/tempest/blob/main/LICENSE').catch(() => {})}>Apache 2.0 License</button>
          <span className="ob-license-sep">·</span>
          <button className="ob-license-link" onClick={() => openUrl('https://tempestai.dev/privacy-policy').catch(() => {})}>Privacy Policy</button>
          <span className="ob-license-sep">·</span>
          <button className="ob-license-link" onClick={() => openUrl('https://tempestai.dev/terms').catch(() => {})}>Terms &amp; Conditions</button>
        </div>
        {version && <span className="ob-blank-version">v{version}</span>}
      </div>
    </div>
  );
}
