import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ToolInputField } from "../graph";

// Plain text field with a `{{ input.<name> }}` insert menu. Stored value is the
// literal template string — the Rust writer resolves chips at runtime by
// substituting `{{input.<name>}}` against the tool's `input` object.
// ponytail: inline chip rendering (colored pills mid-text) is a polish upgrade;
// the insert menu already removes the need to memorise template syntax.

interface Props {
  value: string;
  onChange: (v: string) => void;
  fields: ToolInputField[];
  placeholder?: string;
  mono?: boolean;
  className?: string;
  multiline?: boolean;
  rows?: number;
}

export function ValueChipsInput({
  value, onChange, fields, placeholder, mono, className, multiline, rows,
}: Props) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);

  const insert = (name: string) => {
    const el = ref.current;
    const token = `{{input.${name}}}`;
    if (!el) { onChange((value || "") + token); setOpen(false); return; }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    setOpen(false);
    // put caret after the inserted token on next tick
    requestAnimationFrame(() => {
      const pos = start + token.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const inputCls = `am-input${mono ? " am-mono" : ""} ${className || ""}`.trim();

  return (
    <div className="am-chipin">
      {multiline ? (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          className={`am-textarea${mono ? " am-mono" : ""}`}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows ?? 3}
        />
      ) : (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          className={inputCls}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
      <button
        type="button"
        className="am-chipin-btn"
        onClick={() => setOpen(o => !o)}
        title={fields.length ? "Insert an input" : "No inputs declared yet"}
        disabled={fields.length === 0}
      >
        {`{ }`} <ChevronDown size={11} />
      </button>
      {open && fields.length > 0 && (
        <>
          <div className="am-chipin-scrim" onClick={() => setOpen(false)} />
          <div className="am-chipin-menu">
            <div className="am-chipin-menu-head">Insert input</div>
            {fields.map(f => (
              <button
                key={f.name}
                type="button"
                className="am-chipin-menu-item"
                onClick={() => insert(f.name)}
              >
                <span className="am-chipin-menu-name">{f.name}</span>
                <span className="am-chipin-menu-type">{f.type}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
