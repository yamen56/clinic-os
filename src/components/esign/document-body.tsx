/**
 * Renders frozen document HTML.
 *
 * The only place `dangerouslySetInnerHTML` is used for document content, and it
 * is safe for one reason: every string that reaches here has already been
 * through `sanitizeHtml` on the server — at freeze time for a sent document, at
 * render time for a draft preview. Nothing may pass raw clinic input directly
 * into this component.
 */
export function DocumentBody({ html, className = "" }: { html: string; className?: string }) {
  return <div className={`doc-body-wrap ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
