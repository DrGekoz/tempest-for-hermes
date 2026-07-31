import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./Markdown.css";

// Global markdown renderer. Wraps react-markdown + GFM behind the shared
// `.tempest-md` styles so chat, notes, and any future surface render the same.
// Use everywhere markdown needs displaying; pass extra classes via `className`.
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `tempest-md ${className}` : "tempest-md"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
